/**
 * Kiểu dữ liệu dùng chung giữa main process, preload và renderer.
 * KHÔNG import module Node/Electron ở đây để renderer dùng được an toàn.
 */

export type DbKind = 'mariadb' | 'postgres' | 'mongodb' | 'redis';

/** Cấu hình kết nối do người dùng nhập. Mật khẩu được lưu tách biệt & mã hóa. */
export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  /** Với SQL: username DB. Với Mongo: user. Với Redis: (tùy chọn) username ACL. */
  user?: string;
  /** Chỉ nằm trong bộ nhớ / được mã hóa khi lưu — không bao giờ ghi plaintext. */
  password?: string;
  /** DB/schema mặc định (SQL), database name (Mongo), hoặc db index (Redis dạng chuỗi). */
  database?: string;
  /** Tùy chọn nâng cao theo từng loại (ssl, connectionString, v.v.). */
  options?: Record<string, unknown>;
  /** Nhóm để tổ chức sidebar, ví dụ "Production", "Local". */
  group?: string;
}

/** Cấu hình đã lưu — không chứa password (password lấy từ secure store khi cần). */
export type StoredConnection = Omit<ConnectionConfig, 'password'>;

/** Khả năng của từng loại DB để UI bật/tắt tính năng phù hợp. */
export interface Capabilities {
  /** Hỗ trợ SQL editor (Maria/PG). */
  sql: boolean;
  /** Có transaction. */
  transactions: boolean;
  /** Mô hình dữ liệu để UI chọn cách hiển thị. */
  dataModel: 'relational' | 'document' | 'keyvalue';
  /** Nhãn cho ô nhập query tự do (vd "SQL", "Mongo Shell", "Redis Command"). */
  queryLabel: string;
  /** Cho phép sửa dữ liệu inline trong grid hay không. */
  inlineEdit: boolean;
  /** Cho phép sửa cấu trúc bảng (ALTER TABLE) hay không. */
  alterStructure: boolean;
}

/** Một node trong cây sidebar (database → bảng/collection/key…). */
export interface TreeNode {
  id: string;
  label: string;
  /** Loại node để chọn icon và hành vi khi click. */
  type: 'database' | 'schema' | 'table' | 'view' | 'collection' | 'keyspace' | 'key' | 'folder';
  /** Có thể mở rộng (lazy load con) hay không. */
  expandable: boolean;
  children?: TreeNode[];
  /** Metadata tùy loại (vd rowCount, engine…). */
  meta?: Record<string, unknown>;
}

/** Thông tin tóm tắt một bảng/collection để hiển thị danh sách khi mở database. */
export interface TableSummary {
  name: string;
  type: 'table' | 'view' | 'collection';
  /** Số dòng/document (có thể là ước lượng), null nếu không xác định. */
  rows: number | null;
  /** Dung lượng theo byte (data + index nếu có), null nếu không xác định. */
  sizeBytes: number | null;
  /** Engine lưu trữ (InnoDB…), nếu có. */
  engine?: string;
  /** Ghi chú/comment của bảng, nếu có. */
  comment?: string;
}

/** Định danh mục tiêu để đọc dữ liệu (bảng/collection/keyspace). */
export interface DataTarget {
  /** database/schema chứa đối tượng. */
  database?: string;
  schema?: string;
  /** tên bảng, collection, hoặc pattern key. */
  name: string;
}

export interface PageRequest {
  offset: number;
  limit: number;
  /** sắp xếp: [{column, dir}]. */
  orderBy?: { column: string; dir: 'asc' | 'desc' }[];
  /** Tìm kiếm phía server: SQL -> LIKE mọi cột, Mongo -> regex, Redis -> MATCH pattern. */
  search?: string;
}

/** Mô tả một cột trong kết quả. */
export interface ColumnDef {
  name: string;
  /** Kiểu dữ liệu gốc từ DB nếu biết. */
  dataType?: string;
  nullable?: boolean;
  isPrimaryKey?: boolean;
}

/** Kết quả dạng bảng — dùng chung cho mọi loại DB (document được flatten/JSON hóa). */
export interface RowSet {
  columns: ColumnDef[];
  rows: Record<string, unknown>[];
  /** Tổng số dòng nếu đếm được (để phân trang), null nếu không rõ. */
  total: number | null;
}

/** Thông tin một cột trong cấu trúc bảng. */
export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  /** Ghi chú thêm: auto_increment, identity… */
  extra?: string;
}

/** Thông tin một index. */
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

/** Cấu trúc của một bảng/collection. */
export interface TableStructure {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  /** Ghi chú khi loại đối tượng không có cấu trúc dạng bảng (vd Redis keyspace). */
  note?: string;
}

/** Mô tả một cột khi thêm/sửa. `default` nhập nguyên văn (chuỗi cần kèm dấu nháy). */
export interface ColumnSpec {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
}

/** Thao tác thay đổi cấu trúc bảng (ALTER TABLE). */
export type AlterOperation =
  | { kind: 'addColumn'; column: ColumnSpec }
  | { kind: 'modifyColumn'; oldName: string; column: ColumnSpec }
  | { kind: 'dropColumn'; name: string }
  | { kind: 'addIndex'; name: string; columns: string[]; unique: boolean }
  | { kind: 'dropIndex'; name: string };

/** Kết quả chạy query tự do. */
export interface QueryResult {
  /** Nếu query trả về bảng. */
  rowSet?: RowSet;
  /** Số dòng bị ảnh hưởng (INSERT/UPDATE/DELETE). */
  affectedRows?: number;
  /** Thông điệp trạng thái để hiển thị. */
  message?: string;
  /** Thời gian thực thi (ms). */
  durationMs: number;
}

export interface TestConnectionResult {
  ok: boolean;
  /** Thông tin server nếu kết nối được (vd version). */
  serverInfo?: string;
  error?: string;
}

/**
 * Hợp đồng chung mọi adapter phải hiện thực.
 * UI chỉ nói chuyện qua interface này (thông qua IPC) — không phụ thuộc driver cụ thể.
 */
export interface DatabaseAdapter {
  readonly kind: DbKind;
  readonly capabilities: Capabilities;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  testConnection(): Promise<TestConnectionResult>;

  /** Lấy cây cấp cao nhất (danh sách database). */
  getRootNodes(): Promise<TreeNode[]>;
  /** Lazy-load con của một node khi người dùng mở rộng. */
  getChildNodes(node: TreeNode): Promise<TreeNode[]>;

  /** Liệt kê bảng/collection kèm thông số cơ bản (số dòng, dung lượng…) của một database/schema. */
  getTableList(database?: string, schema?: string): Promise<TableSummary[]>;

  /** Đọc dữ liệu có phân trang từ một bảng/collection/keyspace. */
  readRows(target: DataTarget, page: PageRequest): Promise<RowSet>;

  /** Lấy cấu trúc (cột + index) của một bảng/collection. */
  getStructure(target: DataTarget): Promise<TableStructure>;

  /** Thực hiện một thay đổi cấu trúc bảng (ALTER TABLE). */
  alterTable(target: DataTarget, op: AlterOperation): Promise<void>;

  /** Chạy query/command tự do (SQL, mongo shell, redis command). */
  executeRaw(query: string, database?: string): Promise<QueryResult>;

  /**
   * Cập nhật một ô dữ liệu.
   * @param rowKey map cột-định-danh -> giá trị để xác định đúng dòng (khóa chính với SQL, 'key' với Redis).
   * @param column tên cột cần sửa.
   * @param value giá trị mới.
   */
  updateCell(target: DataTarget, rowKey: Record<string, unknown>, column: string, value: unknown): Promise<void>;

  /** Thêm một dòng mới. `values` chỉ gồm các cột người dùng đã nhập (để DB dùng default/auto-increment). */
  insertRow(target: DataTarget, values: Record<string, unknown>): Promise<void>;

  /** Xóa một dòng theo khóa định danh (khóa chính với SQL, 'key' với Redis). */
  deleteRow(target: DataTarget, rowKey: Record<string, unknown>): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Giao thức IPC: renderer gọi -> main xử lý. Giữ 1 chỗ duy nhất.       */
/* ------------------------------------------------------------------ */

export const IpcChannels = {
  ping: 'app:ping',
  connectionsList: 'connections:list',
  connectionsSave: 'connections:save',
  connectionsDelete: 'connections:delete',
  connectionsTest: 'connections:test',
  sessionOpen: 'session:open',
  sessionClose: 'session:close',
  treeRoot: 'tree:root',
  treeChildren: 'tree:children',
  treeTableList: 'tree:tableList',
  dataRead: 'data:read',
  dataStructure: 'data:structure',
  dataAlter: 'data:alter',
  dataUpdate: 'data:update',
  dataInsert: 'data:insert',
  dataDelete: 'data:delete',
  queryExecute: 'query:execute',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

/** Bề mặt API mà preload expose ra window.api cho renderer. */
export interface RendererApi {
  ping(): Promise<string>;
  listConnections(): Promise<StoredConnection[]>;
  saveConnection(config: ConnectionConfig): Promise<StoredConnection>;
  deleteConnection(id: string): Promise<void>;
  testConnection(config: ConnectionConfig): Promise<TestConnectionResult>;
  /** Mở phiên kết nối tới 1 connection đã lưu; trả về capabilities. */
  openSession(connectionId: string): Promise<Capabilities>;
  closeSession(connectionId: string): Promise<void>;
  getRootNodes(connectionId: string): Promise<TreeNode[]>;
  getChildNodes(connectionId: string, node: TreeNode): Promise<TreeNode[]>;
  getTableList(connectionId: string, database?: string, schema?: string): Promise<TableSummary[]>;
  readRows(connectionId: string, target: DataTarget, page: PageRequest): Promise<RowSet>;
  getStructure(connectionId: string, target: DataTarget): Promise<TableStructure>;
  alterTable(connectionId: string, target: DataTarget, op: AlterOperation): Promise<void>;
  updateCell(
    connectionId: string,
    target: DataTarget,
    rowKey: Record<string, unknown>,
    column: string,
    value: unknown,
  ): Promise<void>;
  insertRow(connectionId: string, target: DataTarget, values: Record<string, unknown>): Promise<void>;
  deleteRow(connectionId: string, target: DataTarget, rowKey: Record<string, unknown>): Promise<void>;
  executeQuery(connectionId: string, query: string, database?: string): Promise<QueryResult>;
}
