import { MongoClient, ObjectId, BSON } from 'mongodb';
// mongodb 6.x không export EJSON ở top-level module — chỉ có qua namespace BSON.
// Dùng lại BSON.EJSON để tránh thêm dependency 'bson' riêng.
const { EJSON } = BSON;
import type {
  Capabilities,
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

export class MongoAdapter implements DatabaseAdapter {
  readonly kind = 'mongodb' as const;
  readonly capabilities: Capabilities = {
    sql: false,
    transactions: true,
    dataModel: 'document',
    queryLabel: 'Mongo Shell',
    // Tạm chưa cho sửa inline: document lồng nhau + _id kiểu BSON cần UI riêng.
    inlineEdit: false,
    documentEdit: true,
    // MongoDB schemaless — không có ALTER TABLE.
    alterStructure: false,
    // Cho phép tạo/xóa/đổi tên collection & xóa database.
    manageObjects: true,
  };

  private client: MongoClient | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  private buildUri(): string {
    const custom = this.config.options?.connectionString as string | undefined;
    if (custom) return custom;
    const auth =
      this.config.user && this.config.password
        ? `${encodeURIComponent(this.config.user)}:${encodeURIComponent(this.config.password)}@`
        : '';
    return `mongodb://${auth}${this.config.host}:${this.config.port}`;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const tls = this.config.options?.ssl;
    this.client = new MongoClient(this.buildUri(), {
      serverSelectionTimeoutMS: 5000,
      ...(tls
        ? { tls: true, tlsAllowInvalidCertificates: this.config.options?.sslRejectUnauthorized === false }
        : {}),
    });
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  private c(): MongoClient {
    if (!this.client) throw new Error('Chưa kết nối MongoDB');
    return this.client;
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      await this.connect();
      const info = await this.c().db('admin').command({ buildInfo: 1 });
      return { ok: true, serverInfo: `MongoDB ${info.version}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async getRootNodes(): Promise<TreeNode[]> {
    const { databases } = await this.c().db().admin().listDatabases();
    return databases.map((d) => ({
      id: `db:${d.name}`,
      label: d.name,
      type: 'database',
      expandable: true,
      meta: { database: d.name },
    }));
  }

  async getChildNodes(node: TreeNode): Promise<TreeNode[]> {
    if (node.type === 'database') {
      const database = node.meta?.database as string;
      const cols = await this.c().db(database).listCollections().toArray();
      return cols.map((c) => ({
        id: `col:${database}.${c.name}`,
        label: c.name,
        type: 'collection',
        expandable: false,
        meta: { database, name: c.name },
      }));
    }
    return [];
  }

  async getTableList(database?: string): Promise<TableSummary[]> {
    const db = database ?? this.config.database;
    if (!db) throw new Error('Thiếu tên database cho MongoDB');
    const mdb = this.c().db(db);
    const cols = await mdb.listCollections().toArray();
    const out: TableSummary[] = [];
    for (const c of cols) {
      const isView = c.type === 'view';
      let rows: number | null = null;
      let sizeBytes: number | null = null;
      if (!isView) {
        try {
          const stats = await mdb.command({ collStats: c.name });
          rows = typeof stats.count === 'number' ? stats.count : null;
          // size = dung lượng dữ liệu chưa nén; cộng thêm index nếu có.
          sizeBytes =
            (typeof stats.size === 'number' ? stats.size : 0) +
            (typeof stats.totalIndexSize === 'number' ? stats.totalIndexSize : 0);
        } catch {
          // collStats có thể lỗi với collection đặc biệt — bỏ qua, để null.
        }
      }
      out.push({ name: c.name, type: isView ? 'view' : 'collection', rows, sizeBytes });
    }
    return out;
  }

  async readRows(target: DataTarget, page: PageRequest): Promise<RowSet> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const col = this.c().db(database).collection(target.name);

    // Tìm kiếm: regex (không phân biệt hoa/thường) trên các field lấy mẫu từ 1 document.
    let filter: Record<string, unknown> = {};
    const search = page.search?.trim();
    if (search) {
      const sample = await col.findOne({});
      const keys = sample ? Object.keys(sample) : [];
      const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      if (keys.length) filter = { $or: keys.map((k) => ({ [k]: rx })) };
    }

    // Có filter thì đếm chính xác; không thì dùng ước lượng (nhanh).
    const total = search ? await col.countDocuments(filter) : await col.estimatedDocumentCount();
    const sort = page.orderBy?.reduce<Record<string, 1 | -1>>((acc, o) => {
      acc[o.column] = o.dir === 'desc' ? -1 : 1;
      return acc;
    }, {});

    const docs = await col
      .find(filter, { sort })
      .skip(page.offset)
      .limit(page.limit)
      .toArray();

    // Gom tất cả key xuất hiện để dựng cột (document có schema linh hoạt).
    const colSet = new Set<string>();
    for (const d of docs) for (const k of Object.keys(d)) colSet.add(k);
    const columns = [...colSet].map((name) => ({ name, isPrimaryKey: name === '_id' }));

    const rows = docs.map((d) => {
      const out: Record<string, unknown> = {};
      for (const k of colSet) {
        const v = (d as Record<string, unknown>)[k];
        // ObjectId -> chuỗi hex trần (không có dấu nháy) để dùng lại làm rowKey (toId nhận diện được).
        // Giá trị lồng nhau khác -> JSON để grid hiển thị được.
        out[k] =
          v instanceof ObjectId
            ? v.toHexString()
            : v !== null && typeof v === 'object'
              ? JSON.stringify(v)
              : v;
      }
      return out;
    });

    return { columns, rows, total };
  }

  /** Chạy lệnh dạng: db.<collection>.find({...}) hoặc runCommand JSON. MVP: hỗ trợ find/aggregate cơ bản. */
  async executeRaw(query: string, database?: string): Promise<QueryResult> {
    const started = process.hrtime.bigint();
    const db = this.c().db(database ?? this.config.database);

    // MVP: cho phép chạy runCommand bằng JSON thuần, ví dụ {"find":"users","limit":10}
    const trimmed = query.trim();
    if (!trimmed.startsWith('{')) {
      throw new Error(
        'MVP MongoShell: hãy nhập lệnh runCommand dạng JSON, ví dụ {"find":"users","limit":10}',
      );
    }
    const command = JSON.parse(trimmed);
    const result = await db.command(command);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Kết quả find/aggregate nằm trong cursor.firstBatch.
    const batch: unknown[] | undefined = result?.cursor?.firstBatch;
    if (Array.isArray(batch)) {
      const colSet = new Set<string>();
      for (const d of batch) for (const k of Object.keys(d as object)) colSet.add(k);
      return {
        rowSet: {
          columns: [...colSet].map((name) => ({ name })),
          rows: batch.map((d) => {
            const out: Record<string, unknown> = {};
            for (const k of colSet) {
              const v = (d as Record<string, unknown>)[k];
              out[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
            }
            return out;
          }),
          total: batch.length,
        },
        durationMs,
      };
    }
    return { message: JSON.stringify(result), durationMs };
  }

  async getStructure(target: DataTarget): Promise<TableStructure> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const col = this.c().db(database).collection(target.name);

    // Suy ra "cột" từ 1 document mẫu (collection không có schema cố định).
    const sample = await col.findOne();
    const columns = sample
      ? Object.entries(sample).map(([name, v]) => ({
          name,
          dataType: mongoType(v),
          nullable: true,
          default: null,
          isPrimaryKey: name === '_id',
        }))
      : [];

    const idxList = await col.indexes();
    const indexes = idxList.map((ix) => ({
      name: (ix.name as string) ?? '(unnamed)',
      columns: Object.keys(ix.key ?? {}),
      unique: Boolean(ix.unique),
    }));

    return { columns, indexes, note: sample ? undefined : 'Collection rỗng — không suy ra được cột.' };
  }

  async alterTable(): Promise<void> {
    throw new Error('MongoDB không có cấu trúc bảng cố định — không áp dụng ALTER TABLE.');
  }

  async createTable(target: DataTarget): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    // Collection schemaless: bỏ qua danh sách cột, chỉ tạo collection rỗng.
    await this.c().db(database).createCollection(target.name);
  }

  async dropTable(target: DataTarget): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    await this.c().db(database).collection(target.name).drop();
  }

  async truncateTable(target: DataTarget): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    await this.c().db(database).collection(target.name).deleteMany({});
  }

  async renameTable(target: DataTarget, newName: string): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    await this.c().db(database).renameCollection(target.name, newName);
  }

  async createDatabase(name: string): Promise<void> {
    // MongoDB tạo database lười (khi có collection đầu tiên) — tạo collection giữ chỗ để db hiện ra.
    await this.c().db(name).createCollection('_placeholder');
  }

  async dropDatabase(name: string): Promise<void> {
    await this.c().db(name).dropDatabase();
  }

  async getCreateStatement(target: DataTarget): Promise<string> {
    return `// MongoDB collection "${target.name}" (schemaless)\ndb.createCollection(${JSON.stringify(target.name)});`;
  }

  /** Chuyển _id từ rowKey về ObjectId nếu là chuỗi hex 24 ký tự; ngược lại giữ nguyên. */
  private toId(rowKey: Record<string, unknown>): unknown {
    const id = rowKey._id;
    if (typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id)) return new ObjectId(id);
    return id;
  }
  // Giới hạn đã biết: _id dạng object (compound _id / sub-document) bị readRows JSON hóa
  // nên không dựng lại được ở đây -> xem/sửa/xóa các document đó sẽ báo "không tìm thấy".
  // _id kiểu ObjectId hoặc vô hướng (string/number) hoạt động bình thường.

  async getDocument(target: DataTarget, rowKey: Record<string, unknown>): Promise<string> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const col = this.c().db(database).collection(target.name);
    const doc = await col.findOne({ _id: this.toId(rowKey) as never });
    if (!doc) throw new Error('Không tìm thấy document.');
    // Canonical EJSON (relaxed:false): giữ nguyên kiểu số BSON (Int32/Long/Double) — tránh
    // mất chính xác Long > 2^53 khi hiển thị rồi lưu lại.
    return EJSON.stringify(doc, undefined, 2, { relaxed: false });
  }

  async updateDocument(
    target: DataTarget,
    rowKey: Record<string, unknown>,
    ejson: string,
  ): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const col = this.c().db(database).collection(target.name);
    const id = this.toId(rowKey);
    // relaxed:false: dựng lại đúng kiểu số BSON từ {$numberLong/$numberInt/...} khi lưu.
    const doc = EJSON.parse(ejson, { relaxed: false }) as Record<string, unknown>;
    // Không cho đổi _id.
    if ('_id' in doc && EJSON.stringify(doc._id) !== EJSON.stringify(id)) {
      throw new Error('Không thể thay đổi _id của document.');
    }
    // Loại _id khỏi phần thay thế để tránh lỗi immutable field.
    delete doc._id;
    const res = await col.replaceOne({ _id: id as never }, doc);
    if (res.matchedCount === 0) throw new Error('Không tìm thấy document để cập nhật.');
  }

  async insertDocument(target: DataTarget, ejson: string): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const col = this.c().db(database).collection(target.name);
    // relaxed:false: dựng lại đúng kiểu số BSON từ {$numberLong/$numberInt/...} khi thêm.
    const doc = EJSON.parse(ejson, { relaxed: false }) as Record<string, unknown>;
    await col.insertOne(doc as never);
  }

  async updateCell(): Promise<void> {
    throw new Error('Sửa inline cho MongoDB chưa được hỗ trợ — dùng ô Mongo Shell.');
  }

  /**
   * Thêm 1 document (dùng cho import CSV/JSON). Giá trị chuỗi (từ CSV) được suy kiểu tự động:
   * số round-trip chính xác -> number, "true"/"false" -> boolean, ô trống -> bỏ field, còn lại giữ chuỗi.
   * Giá trị không phải chuỗi (số/bool/object từ JSON) giữ nguyên.
   */
  async insertRow(target: DataTarget, values: Record<string, unknown>): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const doc: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const coerced = coerceCsvValue(v);
      if (coerced !== undefined) doc[k] = coerced;
    }
    await this.c().db(database).collection(target.name).insertOne(doc as never);
  }

  async deleteRow(target: DataTarget, rowKey: Record<string, unknown>): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const res = await this.c()
      .db(database)
      .collection(target.name)
      .deleteOne({ _id: this.toId(rowKey) as never });
    if (res.deletedCount === 0) throw new Error('Không tìm thấy document để xóa.');
  }
}

/**
 * Suy kiểu một giá trị khi import. Chỉ đụng tới chuỗi (từ CSV); giá trị đã có kiểu (JSON) giữ nguyên.
 * Trả về `undefined` để ra hiệu "bỏ field" (ô trống).
 */
function coerceCsvValue(v: unknown): unknown {
  if (typeof v !== 'string') return v; // number/boolean/object từ JSON: giữ nguyên
  if (v === '') return undefined; // ô trống -> bỏ field
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Chỉ ép thành số khi round-trip khớp tuyệt đối: loại "007", "1e5", "1.50", số > 2^53...
  const n = Number(v);
  if (Number.isFinite(n) && String(n) === v) return n;
  return v;
}

/** Đoán kiểu hiển thị của một giá trị BSON. */
function mongoType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  const t = typeof v;
  if (t === 'object') {
    // ObjectId và các kiểu BSON khác thường có _bsontype.
    const bson = (v as { _bsontype?: string })._bsontype;
    return bson ?? 'object';
  }
  return t;
}
