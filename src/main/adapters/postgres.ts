import pg from 'pg';
import type {
  AlterOperation,
  Capabilities,
  ColumnSpec,
  ConnectionConfig,
  DataTarget,
  DatabaseAdapter,
  PageRequest,
  QueryResult,
  RowSet,
  TableStructure,
  TableSummary,
  TestConnectionResult,
  TreeNode,
} from '@shared/types';
import { quoteIdentPg } from './sql-util';

export class PostgresAdapter implements DatabaseAdapter {
  readonly kind = 'postgres' as const;
  readonly capabilities: Capabilities = {
    sql: true,
    transactions: true,
    dataModel: 'relational',
    queryLabel: 'SQL',
    inlineEdit: true,
    alterStructure: true,
    manageObjects: true,
  };

  private pool: pg.Pool | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = new pg.Pool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database || 'postgres',
      max: 5,
      ssl: this.config.options?.ssl
        ? { rejectUnauthorized: this.config.options?.sslRejectUnauthorized !== false }
        : undefined,
    });
    const client = await this.pool.connect();
    client.release();
  }

  async disconnect(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private db(): pg.Pool {
    if (!this.pool) throw new Error('Chưa kết nối PostgreSQL');
    return this.pool;
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      await this.connect();
      const res = await this.db().query('SELECT version() AS v');
      return { ok: true, serverInfo: res.rows[0]?.v };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Với Postgres, "database" là node gốc; bên trong là schema; bên trong nữa là bảng. */
  async getRootNodes(): Promise<TreeNode[]> {
    // Chỉ liệt kê schema trong database đang kết nối (Postgres không cross-database dễ dàng).
    const res = await this.db().query(
      `SELECT nspname FROM pg_namespace
       WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
       ORDER BY nspname`,
    );
    return res.rows.map((r: { nspname: string }) => ({
      id: `schema:${r.nspname}`,
      label: r.nspname,
      type: 'schema',
      expandable: true,
      meta: { schema: r.nspname },
    }));
  }

  async getChildNodes(node: TreeNode): Promise<TreeNode[]> {
    if (node.type === 'schema') {
      const schema = node.meta?.schema as string;
      const res = await this.db().query(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = $1 ORDER BY table_name`,
        [schema],
      );
      return res.rows.map((r: { table_name: string; table_type: string }) => ({
        id: `tbl:${schema}.${r.table_name}`,
        label: r.table_name,
        type: r.table_type === 'VIEW' ? 'view' : 'table',
        expandable: false,
        meta: { schema, name: r.table_name },
      }));
    }
    return [];
  }

  async getTableList(_database?: string, schema?: string): Promise<TableSummary[]> {
    const ns = schema ?? 'public';
    // reltuples là ước lượng của planner; pg_total_relation_size gồm cả index + toast.
    const res = await this.db().query(
      `SELECT c.relname AS name,
              c.relkind AS kind,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows,
              pg_total_relation_size(c.oid) AS size_bytes,
              obj_description(c.oid) AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m')
       ORDER BY c.relname`,
      [ns],
    );
    return res.rows.map((r: { name: string; kind: string; rows: string | null; size_bytes: string | null; comment: string | null }) => ({
      name: r.name,
      type: r.kind === 'v' || r.kind === 'm' ? 'view' : 'table',
      rows: r.rows != null ? Number(r.rows) : null,
      sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
      comment: r.comment || undefined,
    }));
  }

  async readRows(target: DataTarget, page: PageRequest): Promise<RowSet> {
    const schema = target.schema ?? 'public';
    const qualified = `${quoteIdentPg(schema)}.${quoteIdentPg(target.name)}`;

    const order =
      page.orderBy && page.orderBy.length
        ? ' ORDER BY ' +
          page.orderBy.map((o) => `${quoteIdentPg(o.column)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
        : '';

    // Tìm kiếm: ILIKE (không phân biệt hoa/thường) trên mọi cột, ép TEXT để bắt cả số/ngày.
    let where = '';
    const whereParams: unknown[] = [];
    const search = page.search?.trim();
    if (search) {
      const cols = await this.columnNames(schema, target.name);
      if (cols.length) {
        where =
          ' WHERE ' + cols.map((c, i) => `CAST(${quoteIdentPg(c)} AS TEXT) ILIKE $${i + 1}`).join(' OR ');
        cols.forEach(() => whereParams.push(`%${search}%`));
      }
    }
    const n = whereParams.length;

    const countRes = await this.db().query(`SELECT COUNT(*)::int AS c FROM ${qualified}${where}`, whereParams);
    const total = countRes.rows[0]?.c ?? 0;

    const res = await this.db().query(
      `SELECT * FROM ${qualified}${where}${order} LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...whereParams, page.limit, page.offset],
    );

    const pks = await this.primaryKeys(schema, target.name);
    return {
      columns: res.fields.map((f) => ({ name: f.name, isPrimaryKey: pks.has(f.name) })),
      rows: res.rows as Record<string, unknown>[],
      total,
    };
  }

  async getStructure(target: DataTarget): Promise<TableStructure> {
    const schema = target.schema ?? 'public';
    const pks = await this.primaryKeys(schema, target.name);
    // format_type trả về kiểu kèm độ dài, vd "character varying(255)", "numeric(10,2)".
    const colRes = await this.db().query(
      `SELECT a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              NOT a.attnotnull AS is_nullable,
              pg_get_expr(d.adbin, d.adrelid) AS column_default
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, target.name],
    );
    const columns = colRes.rows.map((c: Record<string, unknown>) => ({
      name: c.column_name as string,
      dataType: c.data_type as string,
      nullable: Boolean(c.is_nullable),
      default: (c.column_default as string) ?? null,
      isPrimaryKey: pks.has(c.column_name as string),
      extra: String(c.column_default ?? '').startsWith('nextval') ? 'auto-increment' : undefined,
    }));

    const idxRes = await this.db().query(
      `SELECT i.relname AS index_name, ix.indisunique AS unique, a.attname AS column_name, k.ord
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE n.nspname = $1 AND t.relname = $2
       ORDER BY i.relname, k.ord`,
      [schema, target.name],
    );
    const byName = new Map<string, { name: string; columns: string[]; unique: boolean }>();
    for (const r of idxRes.rows as { index_name: string; unique: boolean; column_name: string }[]) {
      const entry = byName.get(r.index_name) ?? { name: r.index_name, columns: [], unique: r.unique };
      entry.columns.push(r.column_name);
      byName.set(r.index_name, entry);
    }
    return { columns, indexes: [...byName.values()] };
  }

  async alterTable(target: DataTarget, op: AlterOperation): Promise<void> {
    const schema = target.schema ?? 'public';
    const t = `${quoteIdentPg(schema)}.${quoteIdentPg(target.name)}`;

    switch (op.kind) {
      case 'addColumn': {
        const c = op.column;
        let sql = `ALTER TABLE ${t} ADD COLUMN ${quoteIdentPg(c.name)} ${c.dataType}`;
        if (!c.nullable) sql += ' NOT NULL';
        if (c.default !== null && c.default !== '') sql += ` DEFAULT ${c.default}`;
        await this.db().query(sql);
        return;
      }
      case 'dropColumn':
        await this.db().query(`ALTER TABLE ${t} DROP COLUMN ${quoteIdentPg(op.name)}`);
        return;
      case 'addIndex':
        await this.db().query(
          `CREATE ${op.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentPg(op.name)} ON ${t} (${op.columns
            .map(quoteIdentPg)
            .join(', ')})`,
        );
        return;
      case 'dropIndex':
        // Index trong Postgres là đối tượng theo schema.
        await this.db().query(`DROP INDEX ${quoteIdentPg(schema)}.${quoteIdentPg(op.name)}`);
        return;
      case 'modifyColumn': {
        // Postgres không có lệnh MODIFY gộp: đổi tên, kiểu, NULL, default là các lệnh riêng.
        const c = op.column;
        const client = await this.db().connect();
        try {
          await client.query('BEGIN');
          if (op.oldName !== c.name) {
            await client.query(`ALTER TABLE ${t} RENAME COLUMN ${quoteIdentPg(op.oldName)} TO ${quoteIdentPg(c.name)}`);
          }
          const col = quoteIdentPg(c.name);
          // USING ...::type giúp ép kiểu khi đổi type tương thích.
          await client.query(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${c.dataType} USING ${col}::${c.dataType}`);
          await client.query(`ALTER TABLE ${t} ALTER COLUMN ${col} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
          if (c.default !== null && c.default !== '') {
            await client.query(`ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${c.default}`);
          } else {
            await client.query(`ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`);
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
        return;
      }
    }
  }

  /** Danh sách tên cột của bảng (để dựng mệnh đề tìm kiếm). */
  private async columnNames(schema: string, table: string): Promise<string[]> {
    const res = await this.db().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, table],
    );
    return res.rows.map((r: { column_name: string }) => r.column_name);
  }

  private qualify(target: DataTarget, name = target.name): string {
    const schema = target.schema ?? 'public';
    return `${quoteIdentPg(schema)}.${quoteIdentPg(name)}`;
  }

  /** Sinh mệnh đề định nghĩa cột cho CREATE TABLE. */
  private colDef(c: ColumnSpec): string {
    let def = `${quoteIdentPg(c.name)} ${c.dataType}`;
    if (!c.nullable) def += ' NOT NULL';
    if (c.default !== null && c.default !== '') def += ` DEFAULT ${c.default}`;
    return def;
  }

  async createTable(target: DataTarget, columns: ColumnSpec[]): Promise<void> {
    if (!columns.length) throw new Error('Cần ít nhất 1 cột để tạo bảng.');
    const defs = columns.map((c) => this.colDef(c)).join(', ');
    await this.db().query(`CREATE TABLE ${this.qualify(target)} (${defs})`);
  }

  async dropTable(target: DataTarget): Promise<void> {
    await this.db().query(`DROP TABLE ${this.qualify(target)}`);
  }

  async truncateTable(target: DataTarget): Promise<void> {
    await this.db().query(`TRUNCATE TABLE ${this.qualify(target)}`);
  }

  async renameTable(target: DataTarget, newName: string): Promise<void> {
    // RENAME TO chỉ nhận tên mới không kèm schema.
    await this.db().query(`ALTER TABLE ${this.qualify(target)} RENAME TO ${quoteIdentPg(newName)}`);
  }

  async dropDatabase(name: string): Promise<void> {
    // Không thể xóa database đang kết nối; Postgres sẽ báo lỗi rõ ràng nếu vậy.
    await this.db().query(`DROP DATABASE ${quoteIdentPg(name)}`);
  }

  async getCreateStatement(target: DataTarget): Promise<string> {
    // Postgres không có SHOW CREATE — dựng DDL từ cấu trúc (cột + PK + index).
    const s = await this.getStructure(target);
    const lines = s.columns.map((c) => {
      let l = `  ${quoteIdentPg(c.name)} ${c.dataType}`;
      if (!c.nullable) l += ' NOT NULL';
      if (c.default) l += ` DEFAULT ${c.default}`;
      return l;
    });
    const pks = s.columns.filter((c) => c.isPrimaryKey).map((c) => quoteIdentPg(c.name));
    if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(', ')})`);
    let sql = `CREATE TABLE ${this.qualify(target)} (\n${lines.join(',\n')}\n);`;
    for (const ix of s.indexes) {
      // Bỏ qua index của khóa chính (đã nằm trong PRIMARY KEY).
      if (pks.length && ix.name.endsWith('_pkey')) continue;
      sql += `\nCREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentPg(ix.name)} ON ${this.qualify(
        target,
      )} (${ix.columns.map(quoteIdentPg).join(', ')});`;
    }
    return sql;
  }

  /** Lấy tập cột khóa chính của bảng. */
  private async primaryKeys(schema: string, table: string): Promise<Set<string>> {
    const res = await this.db().query(
      `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary`,
      [quoteIdentPg(schema), quoteIdentPg(table)],
    );
    return new Set(res.rows.map((r: { name: string }) => r.name));
  }

  async updateCell(
    target: DataTarget,
    rowKey: Record<string, unknown>,
    column: string,
    value: unknown,
  ): Promise<void> {
    const keys = Object.keys(rowKey);
    if (keys.length === 0) {
      throw new Error('Bảng không có khóa chính — không thể sửa inline an toàn.');
    }
    const schema = target.schema ?? 'public';
    const qualified = `${quoteIdentPg(schema)}.${quoteIdentPg(target.name)}`;
    // $1 = giá trị mới; $2..$n = giá trị khóa chính.
    const where = keys.map((k, i) => `${quoteIdentPg(k)} = $${i + 2}`).join(' AND ');

    const res = await this.db().query(
      `UPDATE ${qualified} SET ${quoteIdentPg(column)} = $1 WHERE ${where}`,
      [value, ...keys.map((k) => rowKey[k])],
    );
    if (res.rowCount === 0) throw new Error('Không cập nhật được dòng nào (dòng có thể đã bị đổi/xóa).');
  }

  async insertRow(target: DataTarget, values: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(values);
    if (cols.length === 0) throw new Error('Chưa nhập giá trị nào cho dòng mới.');
    const schema = target.schema ?? 'public';
    const qualified = `${quoteIdentPg(schema)}.${quoteIdentPg(target.name)}`;
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await this.db().query(
      `INSERT INTO ${qualified} (${cols.map(quoteIdentPg).join(', ')}) VALUES (${placeholders})`,
      cols.map((c) => values[c]),
    );
  }

  async deleteRow(target: DataTarget, rowKey: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(rowKey);
    if (keys.length === 0) throw new Error('Bảng không có khóa chính — không thể xóa an toàn.');
    const schema = target.schema ?? 'public';
    const qualified = `${quoteIdentPg(schema)}.${quoteIdentPg(target.name)}`;
    const where = keys.map((k, i) => `${quoteIdentPg(k)} = $${i + 1}`).join(' AND ');
    const res = await this.db().query(
      `DELETE FROM ${qualified} WHERE ${where}`,
      keys.map((k) => rowKey[k]),
    );
    if (res.rowCount === 0) throw new Error('Không xóa được dòng nào (dòng có thể đã bị xóa).');
  }

  async executeRaw(query: string): Promise<QueryResult> {
    const started = process.hrtime.bigint();
    const res = await this.db().query(query);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

    // pg trả về command (SELECT/INSERT/…) trong res.command.
    if (res.command === 'SELECT' || res.fields.length > 0) {
      return {
        rowSet: {
          columns: res.fields.map((f) => ({ name: f.name })),
          rows: res.rows as Record<string, unknown>[],
          total: res.rowCount,
        },
        durationMs,
      };
    }
    return {
      affectedRows: res.rowCount ?? 0,
      message: `OK, ${res.rowCount ?? 0} dòng bị ảnh hưởng`,
      durationMs,
    };
  }
}
