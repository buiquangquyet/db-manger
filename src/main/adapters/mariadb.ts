import mysql from 'mysql2/promise';
import type {
  AlterOperation,
  Capabilities,
  ColumnSpec,
  ConnectionConfig,
  DataTarget,
  DatabaseAdapter,
  PageRequest,
  QueryResult,
  QueryTarget,
  RowSet,
  SchemaObject,
  TableStructure,
  TableSummary,
  TestConnectionResult,
  TreeNode,
} from '@shared/types';
import { quoteIdentMysql, buildColumnFilterClauses, groupColumnsByTable, groupForeignKeys } from './sql-util';

export class MariaDbAdapter implements DatabaseAdapter {
  readonly kind = 'mariadb' as const;
  readonly capabilities: Capabilities = {
    sql: true,
    transactions: true,
    dataModel: 'relational',
    queryLabel: 'SQL',
    inlineEdit: true,
    documentEdit: false,
    alterStructure: true,
    manageObjects: true,
    columnFilter: true,
  };

  private pool: mysql.Pool | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database || undefined,
      connectionLimit: 5,
      // Trả về Buffer cho BLOB, giữ số lớn dạng chuỗi để không mất chính xác.
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      ssl: this.config.options?.ssl
        ? { rejectUnauthorized: this.config.options?.sslRejectUnauthorized !== false }
        : undefined,
    });
    // ép mở 1 kết nối để phát hiện lỗi sớm.
    const conn = await this.pool.getConnection();
    conn.release();
  }

  async disconnect(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private db(): mysql.Pool {
    if (!this.pool) throw new Error('Chưa kết nối MariaDB');
    return this.pool;
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      await this.connect();
      const [rows] = await this.db().query('SELECT VERSION() AS v');
      const v = (rows as { v: string }[])[0]?.v;
      return { ok: true, serverInfo: `MariaDB/MySQL ${v}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async getRootNodes(): Promise<TreeNode[]> {
    const [rows] = await this.db().query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys')
       ORDER BY schema_name`,
    );
    return (rows as { schema_name: string }[]).map((r) => ({
      id: `db:${r.schema_name}`,
      label: r.schema_name,
      type: 'database',
      expandable: true,
      meta: { database: r.schema_name },
    }));
  }

  async getChildNodes(node: TreeNode): Promise<TreeNode[]> {
    if (node.type === 'database') {
      const database = node.meta?.database as string;
      const [rows] = await this.db().query(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = ? ORDER BY table_name`,
        [database],
      );
      return (rows as { table_name: string; table_type: string }[]).map((r) => ({
        id: `tbl:${database}.${r.table_name}`,
        label: r.table_name,
        type: r.table_type === 'VIEW' ? 'view' : 'table',
        expandable: false,
        meta: { database, name: r.table_name },
      }));
    }
    return [];
  }

  async getTableList(database?: string): Promise<TableSummary[]> {
    const db = database ?? this.config.database;
    if (!db) throw new Error('Thiếu tên database để liệt kê bảng');
    const [rows] = await this.db().query(
      `SELECT table_name, table_type, engine, table_rows, data_length, index_length, table_comment
       FROM information_schema.tables
       WHERE table_schema = ? ORDER BY table_name`,
      [db],
    );
    return (rows as {
      table_name: string;
      table_type: string;
      engine: string | null;
      table_rows: number | null;
      data_length: number | null;
      index_length: number | null;
      table_comment: string | null;
    }[]).map((r) => ({
      name: r.table_name,
      type: r.table_type === 'VIEW' ? 'view' : 'table',
      rows: r.table_rows != null ? Number(r.table_rows) : null,
      sizeBytes:
        r.data_length != null || r.index_length != null
          ? Number(r.data_length ?? 0) + Number(r.index_length ?? 0)
          : null,
      engine: r.engine ?? undefined,
      comment: r.table_comment || undefined,
    }));
  }

  async readRows(target: DataTarget, page: PageRequest): Promise<RowSet> {
    const db = target.database ?? this.config.database;
    const qualified = db ? `${quoteIdentMysql(db)}.${quoteIdentMysql(target.name)}` : quoteIdentMysql(target.name);

    const order =
      page.orderBy && page.orderBy.length
        ? ' ORDER BY ' +
          page.orderBy.map((o) => `${quoteIdentMysql(o.column)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
        : '';

    // `params` chia sẻ giữa count và select — count PHẢI chạy TRƯỚC khi thêm LIMIT/OFFSET qua
    // add(), nếu không thứ tự '?' sẽ lệch. Đừng đảo thứ tự hai truy vấn.
    const params: unknown[] = [];
    const add = (v: unknown): string => {
      params.push(v);
      return '?';
    };

    const groups: string[] = [];
    const search = page.search?.trim();
    if (search) {
      const cols = await this.columnNames(db, target.name);
      if (cols.length) {
        groups.push(
          '(' + cols.map((c) => `CAST(${quoteIdentMysql(c)} AS CHAR) LIKE ${add(`%${search}%`)}`).join(' OR ') + ')',
        );
      }
    }
    groups.push(
      ...buildColumnFilterClauses(page.filters ?? [], {
        quote: quoteIdentMysql,
        textCast: (e) => `CAST(${e} AS CHAR)`,
        likeOp: 'LIKE',
      }, add),
    );
    const where = groups.length ? ' WHERE ' + groups.join(' AND ') : '';

    const [countRows] = await this.db().query(`SELECT COUNT(*) AS c FROM ${qualified}${where}`, params);
    const total = Number((countRows as { c: number }[])[0]?.c ?? 0);

    const [rows, fields] = await this.db().query(
      `SELECT * FROM ${qualified}${where}${order} LIMIT ${add(page.limit)} OFFSET ${add(page.offset)}`,
      params,
    );

    const pks = await this.primaryKeys(db, target.name);
    return {
      columns: (fields as mysql.FieldPacket[]).map((f) => ({ name: f.name, isPrimaryKey: pks.has(f.name) })),
      rows: rows as Record<string, unknown>[],
      total,
    };
  }

  async getStructure(target: DataTarget): Promise<TableStructure> {
    const db = target.database ?? this.config.database;
    const [cols] = await this.db().query(
      `SELECT column_name, column_type, is_nullable, column_default, column_key, extra
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [db, target.name],
    );
    const columns = (cols as Record<string, string>[]).map((c) => ({
      name: c.column_name,
      dataType: c.column_type,
      nullable: c.is_nullable === 'YES',
      default: c.column_default,
      isPrimaryKey: c.column_key === 'PRI',
      extra: c.extra || undefined,
    }));

    const [idx] = await this.db().query(
      `SELECT index_name, non_unique, seq_in_index, column_name
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index`,
      [db, target.name],
    );
    const byName = new Map<string, { name: string; columns: string[]; unique: boolean }>();
    for (const r of idx as { index_name: string; non_unique: number; column_name: string }[]) {
      const entry = byName.get(r.index_name) ?? { name: r.index_name, columns: [], unique: r.non_unique === 0 };
      entry.columns.push(r.column_name);
      byName.set(r.index_name, entry);
    }
    // KEY_COLUMN_USAGE cho cặp cột, REFERENTIAL_CONSTRAINTS cho quy tắc ON DELETE/UPDATE.
    // ORDER BY ordinal_position là bắt buộc: groupForeignKeys ghép cột nguồn với cột đích
    // theo thứ tự dòng.
    const [fks] = await this.db().query(
      `SELECT k.constraint_name, k.column_name, k.referenced_table_name, k.referenced_column_name,
              r.delete_rule, r.update_rule
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = ? AND k.table_name = ? AND k.referenced_table_name IS NOT NULL
       ORDER BY k.constraint_name, k.ordinal_position`,
      [db, target.name],
    );
    const foreignKeys = groupForeignKeys(
      (fks as Record<string, string>[]).map((r) => ({
        name: r.constraint_name,
        column: r.column_name,
        refTable: r.referenced_table_name,
        refColumn: r.referenced_column_name,
        onDelete: r.delete_rule || undefined,
        onUpdate: r.update_rule || undefined,
      })),
    );

    return { columns, indexes: [...byName.values()], foreignKeys };
  }

  async alterTable(target: DataTarget, op: AlterOperation): Promise<void> {
    const db = target.database ?? this.config.database;
    const t = db ? `${quoteIdentMysql(db)}.${quoteIdentMysql(target.name)}` : quoteIdentMysql(target.name);

    let sql: string;
    switch (op.kind) {
      case 'addColumn':
        sql = `ALTER TABLE ${t} ADD COLUMN ${this.colDef(op.column)}`;
        break;
      case 'modifyColumn':
        // CHANGE COLUMN xử lý cả đổi tên lẫn đổi kiểu trong 1 lệnh.
        sql = `ALTER TABLE ${t} CHANGE COLUMN ${quoteIdentMysql(op.oldName)} ${this.colDef(op.column)}`;
        break;
      case 'dropColumn':
        sql = `ALTER TABLE ${t} DROP COLUMN ${quoteIdentMysql(op.name)}`;
        break;
      case 'addIndex':
        sql = `ALTER TABLE ${t} ADD ${op.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentMysql(op.name)} (${op.columns
          .map(quoteIdentMysql)
          .join(', ')})`;
        break;
      case 'dropIndex':
        sql = `ALTER TABLE ${t} DROP INDEX ${quoteIdentMysql(op.name)}`;
        break;
    }
    await this.db().query(sql);
  }

  private qualify(target: DataTarget, name = target.name): string {
    const db = target.database ?? this.config.database;
    return db ? `${quoteIdentMysql(db)}.${quoteIdentMysql(name)}` : quoteIdentMysql(name);
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
    await this.db().query(`RENAME TABLE ${this.qualify(target)} TO ${this.qualify(target, newName)}`);
  }

  async createDatabase(name: string): Promise<void> {
    await this.db().query(`CREATE DATABASE ${quoteIdentMysql(name)}`);
  }

  async dropDatabase(name: string): Promise<void> {
    await this.db().query(`DROP DATABASE ${quoteIdentMysql(name)}`);
  }

  async getCreateStatement(target: DataTarget): Promise<string> {
    const [rows] = await this.db().query(`SHOW CREATE TABLE ${this.qualify(target)}`);
    const row = (rows as Record<string, string>[])[0] ?? {};
    // MySQL trả về cột 'Create Table' (hoặc 'Create View' cho view).
    return (row['Create Table'] ?? row['Create View'] ?? '') + ';';
  }

  async getSchemaObjects(database?: string): Promise<SchemaObject[]> {
    const db = database ?? this.config.database;
    const [rows] = await this.db().query(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = ? ORDER BY table_name, ordinal_position`,
      [db],
    );
    return groupColumnsByTable(rows as { t: string; c: string }[]);
  }

  /** Sinh mệnh đề định nghĩa cột: `name` type NULL/NOT NULL [DEFAULT ...]. */
  private colDef(c: ColumnSpec): string {
    let def = `${quoteIdentMysql(c.name)} ${c.dataType} ${c.nullable ? 'NULL' : 'NOT NULL'}`;
    if (c.default !== null && c.default !== '') def += ` DEFAULT ${c.default}`;
    return def;
  }

  /** Danh sách tên cột của bảng (để dựng mệnh đề tìm kiếm). */
  private async columnNames(database: string | undefined, table: string): Promise<string[]> {
    const [rows] = await this.db().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [database ?? this.config.database, table],
    );
    return (rows as { column_name: string }[]).map((r) => r.column_name);
  }

  /** Lấy tập cột khóa chính của bảng (để sửa inline an toàn). */
  private async primaryKeys(database: string | undefined, table: string): Promise<Set<string>> {
    const [rows] = await this.db().query(
      `SELECT column_name FROM information_schema.key_column_usage
       WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'`,
      [database ?? this.config.database, table],
    );
    return new Set((rows as { column_name: string }[]).map((r) => r.column_name));
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
    const db = target.database ?? this.config.database;
    const qualified = db ? `${quoteIdentMysql(db)}.${quoteIdentMysql(target.name)}` : quoteIdentMysql(target.name);
    const where = keys.map((k) => `${quoteIdentMysql(k)} = ?`).join(' AND ');

    const [result] = await this.db().query(
      `UPDATE ${qualified} SET ${quoteIdentMysql(column)} = ? WHERE ${where}`,
      [value, ...keys.map((k) => rowKey[k])],
    );
    const affected = (result as mysql.ResultSetHeader).affectedRows;
    if (affected === 0) throw new Error('Không cập nhật được dòng nào (dòng có thể đã bị đổi/xóa).');
  }

  async insertRow(target: DataTarget, values: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(values);
    if (cols.length === 0) throw new Error('Chưa nhập giá trị nào cho dòng mới.');
    const db = target.database ?? this.config.database;
    const qualified = db ? `${quoteIdentMysql(db)}.${quoteIdentMysql(target.name)}` : quoteIdentMysql(target.name);
    const placeholders = cols.map(() => '?').join(', ');
    await this.db().query(
      `INSERT INTO ${qualified} (${cols.map(quoteIdentMysql).join(', ')}) VALUES (${placeholders})`,
      cols.map((c) => values[c]),
    );
  }

  async insertRows(target: DataTarget, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    const cols = Object.keys(rows[0]);
    if (cols.length === 0) throw new Error('Không có cột nào để ghi.');
    const db = target.database ?? this.config.database;
    const qualified = db ? `${quoteIdentMysql(db)}.${quoteIdentMysql(target.name)}` : quoteIdentMysql(target.name);
    const colList = cols.map(quoteIdentMysql).join(', ');
    // Chunk theo số placeholder để không vượt max_allowed_packet / giới hạn tham số.
    const chunkSize = Math.max(1, Math.min(500, Math.floor(2000 / cols.length)));
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const groups = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
      const params = chunk.flatMap((r) => cols.map((c) => r[c]));
      await this.db().query(`INSERT INTO ${qualified} (${colList}) VALUES ${groups}`, params);
    }
  }

  async deleteRow(target: DataTarget, rowKey: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(rowKey);
    if (keys.length === 0) throw new Error('Bảng không có khóa chính — không thể xóa an toàn.');
    const db = target.database ?? this.config.database;
    const qualified = db ? `${quoteIdentMysql(db)}.${quoteIdentMysql(target.name)}` : quoteIdentMysql(target.name);
    const where = keys.map((k) => `${quoteIdentMysql(k)} = ?`).join(' AND ');
    const [result] = await this.db().query(
      `DELETE FROM ${qualified} WHERE ${where}`,
      keys.map((k) => rowKey[k]),
    );
    if ((result as mysql.ResultSetHeader).affectedRows === 0) {
      throw new Error('Không xóa được dòng nào (dòng có thể đã bị xóa).');
    }
  }

  async executeRaw(query: string, target?: QueryTarget): Promise<QueryResult> {
    const started = process.hrtime.bigint();
    const conn = await this.db().getConnection();
    try {
      // USE chạy trên đúng connection đang mượn nên không rò sang query khác của pool.
      if (target?.database) await conn.query(`USE ${quoteIdentMysql(target.database)}`);
      const [result, fields] = await conn.query(query);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

      if (Array.isArray(result)) {
        return {
          rowSet: {
            columns: (fields as mysql.FieldPacket[]).map((f) => ({ name: f.name })),
            rows: result as Record<string, unknown>[],
            total: (result as unknown[]).length,
          },
          durationMs,
        };
      }
      const header = result as mysql.ResultSetHeader;
      return {
        affectedRows: header.affectedRows,
        message: `OK, ${header.affectedRows} dòng bị ảnh hưởng`,
        durationMs,
      };
    } finally {
      conn.release();
    }
  }
}
