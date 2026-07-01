import Redis from 'ioredis';
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

export class RedisAdapter implements DatabaseAdapter {
  readonly kind = 'redis' as const;
  readonly capabilities: Capabilities = {
    sql: false,
    transactions: false,
    dataModel: 'keyvalue',
    queryLabel: 'Redis Command',
    inlineEdit: true,
    alterStructure: false,
    manageObjects: false,
  };

  private client: Redis | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = new Redis({
      host: this.config.host,
      port: this.config.port,
      username: this.config.user || undefined,
      password: this.config.password || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      tls: this.config.options?.ssl
        ? { rejectUnauthorized: this.config.options?.sslRejectUnauthorized !== false }
        : undefined,
    });
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    this.client?.disconnect();
    this.client = null;
  }

  private r(): Redis {
    if (!this.client) throw new Error('Chưa kết nối Redis');
    return this.client;
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      await this.connect();
      const info = await this.r().info('server');
      const version = /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? '?';
      return { ok: true, serverInfo: `Redis ${version}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Redis: node gốc là các db index (0..15 theo cấu hình). */
  async getRootNodes(): Promise<TreeNode[]> {
    const raw = await this.r().config('GET', 'databases');
    const count = Number((raw as string[])[1] ?? 16);
    const nodes: TreeNode[] = [];
    for (let i = 0; i < count; i++) {
      nodes.push({
        id: `keyspace:${i}`,
        label: `db${i}`,
        type: 'keyspace',
        expandable: false,
        meta: { dbIndex: i },
      });
    }
    return nodes;
  }

  async getChildNodes(): Promise<TreeNode[]> {
    // Không lazy-load key vào cây (có thể rất nhiều) — dùng readRows để duyệt.
    return [];
  }

  async getTableList(): Promise<TableSummary[]> {
    // Redis là key-value, không có bảng để liệt kê.
    return [];
  }

  /** Đọc key bằng SCAN có phân trang; mỗi dòng = 1 key với type & preview. */
  async readRows(target: DataTarget, page: PageRequest): Promise<RowSet> {
    // Node keyspace ở sidebar đặt dbIndex vào target.name; ưu tiên database rồi tới name.
    const dbIndex = Number(target.database ?? target.name ?? 0);
    await this.r().select(Number.isFinite(dbIndex) ? dbIndex : 0);
    // Tìm kiếm map sang MATCH pattern (glob của Redis); mặc định '*' để liệt kê hết.
    const pattern = page.search?.trim() || '*';

    // MVP phân trang đơn giản: SCAN toàn bộ rồi cắt trang (đủ cho tập key vừa phải).
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.r().scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0' && keys.length < page.offset + page.limit + 1);

    const pageKeys = keys.slice(page.offset, page.offset + page.limit);
    const rows: Record<string, unknown>[] = [];
    for (const key of pageKeys) {
      const type = await this.r().type(key);
      const ttl = await this.r().ttl(key);
      rows.push({ key, type, ttl, value: await this.previewValue(key, type) });
    }

    return {
      columns: [
        { name: 'key', isPrimaryKey: true },
        { name: 'type' },
        { name: 'ttl' },
        { name: 'value' },
      ],
      rows,
      total: keys.length >= page.offset + page.limit + 1 ? null : keys.length,
    };
  }

  async getStructure(target: DataTarget): Promise<TableStructure> {
    // Keyspace Redis không có schema; hiển thị cấu trúc "ảo" của bảng key đang duyệt.
    return {
      columns: [
        { name: 'key', dataType: 'string', nullable: false, default: null, isPrimaryKey: true },
        { name: 'type', dataType: 'string', nullable: false, default: null, isPrimaryKey: false },
        { name: 'ttl', dataType: 'integer (giây)', nullable: true, default: null, isPrimaryKey: false },
        { name: 'value', dataType: 'tùy type', nullable: true, default: null, isPrimaryKey: false },
      ],
      indexes: [],
      note: `Redis db${target.database ?? 0}: key-value store, không có schema cố định.`,
    };
  }

  async alterTable(): Promise<void> {
    throw new Error('Redis không có cấu trúc bảng — không áp dụng ALTER TABLE.');
  }

  async createTable(): Promise<void> {
    throw new Error('Redis không có bảng — tạo key trực tiếp qua ô Redis Command.');
  }

  async dropTable(): Promise<void> {
    throw new Error('Redis không có bảng — xóa key riêng lẻ hoặc FLUSHDB cả keyspace.');
  }

  async truncateTable(target: DataTarget): Promise<void> {
    await this.r().select(Number(target.database ?? target.name ?? 0));
    await this.r().flushdb();
  }

  async renameTable(): Promise<void> {
    throw new Error('Redis không hỗ trợ đổi tên keyspace.');
  }

  async dropDatabase(name: string): Promise<void> {
    await this.r().select(Number(name) || 0);
    await this.r().flushdb();
  }

  async getCreateStatement(): Promise<string> {
    throw new Error('Redis không có bảng — không có DDL để copy.');
  }

  /** Sửa inline: cột 'value' (chỉ key kiểu string) hoặc 'ttl'. */
  async updateCell(
    target: DataTarget,
    rowKey: Record<string, unknown>,
    column: string,
    value: unknown,
  ): Promise<void> {
    const key = rowKey.key as string;
    if (!key) throw new Error('Thiếu key để cập nhật.');
    await this.r().select(Number(target.database ?? 0));

    if (column === 'value') {
      const type = await this.r().type(key);
      if (type !== 'string') {
        throw new Error(`Chưa hỗ trợ sửa inline cho key kiểu "${type}" — dùng ô Redis Command.`);
      }
      await this.r().set(key, String(value));
      return;
    }
    if (column === 'ttl') {
      const ttl = Number(value);
      if (!Number.isFinite(ttl) || ttl < 0) await this.r().persist(key);
      else await this.r().expire(key, ttl);
      return;
    }
    throw new Error(`Không thể sửa cột "${column}".`);
  }

  async insertRow(target: DataTarget, values: Record<string, unknown>): Promise<void> {
    const key = values.key as string;
    if (!key) throw new Error('Cần nhập "key" để tạo dòng mới.');
    await this.r().select(Number(target.database ?? 0));
    // MVP: tạo key kiểu string.
    await this.r().set(key, String(values.value ?? ''));
    const ttl = Number(values.ttl);
    if (Number.isFinite(ttl) && ttl > 0) await this.r().expire(key, ttl);
  }

  async deleteRow(target: DataTarget, rowKey: Record<string, unknown>): Promise<void> {
    const key = rowKey.key as string;
    if (!key) throw new Error('Thiếu key để xóa.');
    await this.r().select(Number(target.database ?? 0));
    const removed = await this.r().del(key);
    if (removed === 0) throw new Error('Không xóa được key (có thể đã bị xóa).');
  }

  private async previewValue(key: string, type: string): Promise<string> {
    switch (type) {
      case 'string':
        return (await this.r().get(key)) ?? '';
      case 'list':
        return JSON.stringify(await this.r().lrange(key, 0, 20));
      case 'set':
        return JSON.stringify(await this.r().srandmember(key, 20));
      case 'hash':
        return JSON.stringify(await this.r().hgetall(key));
      case 'zset':
        return JSON.stringify(await this.r().zrange(key, 0, 20, 'WITHSCORES'));
      default:
        return `(${type})`;
    }
  }

  /** Chạy command tự do, ví dụ: GET foo | HGETALL user:1 | KEYS * */
  async executeRaw(query: string, database?: string): Promise<QueryResult> {
    const started = process.hrtime.bigint();
    if (database !== undefined) await this.r().select(Number(database));
    const parts = this.tokenize(query);
    if (!parts.length) return { message: '(lệnh rỗng)', durationMs: 0 };

    const [cmd, ...args] = parts;
    const result = await this.r().call(cmd, ...args);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { message: this.stringify(result), durationMs };
  }

  private tokenize(input: string): string[] {
    // Tách theo khoảng trắng, hỗ trợ chuỗi trong nháy kép/đơn.
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(input.trim()))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
  }

  private stringify(v: unknown): string {
    if (v === null) return '(nil)';
    if (Array.isArray(v)) return v.map((x) => this.stringify(x)).join('\n');
    if (Buffer.isBuffer(v)) return v.toString();
    return String(v);
  }
}
