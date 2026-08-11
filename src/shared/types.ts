/**
 * Kiểu dữ liệu dùng chung giữa main process, preload và renderer.
 * KHÔNG import module Node/Electron ở đây để renderer dùng được an toàn.
 */

export type DbKind = 'mariadb' | 'postgres' | 'mongodb' | 'redis';

/** Cấu hình SSH tunnel: forward local -> DB host:port qua một SSH server (bastion). */
export interface SshTunnelConfig {
  host: string;
  port: number;
  user: string;
  /** Xác thực bằng mật khẩu (bí mật — mã hóa khi lưu). */
  password?: string;
  /** Hoặc bằng private key dạng PEM (bí mật — mã hóa khi lưu). */
  privateKey?: string;
  /** Passphrase của private key nếu có (bí mật). */
  passphrase?: string;
}

/** Tùy chọn nâng cao theo từng kết nối. */
export interface ConnectionOptions {
  /** Bật TLS/SSL tới DB. */
  ssl?: boolean;
  /** false = chấp nhận chứng chỉ tự ký / không khớp tên (mặc định true). */
  sslRejectUnauthorized?: boolean;
  /** Nếu đặt, kết nối qua SSH tunnel. */
  ssh?: SshTunnelConfig;
  /** Chuỗi kết nối tùy chỉnh (vd Mongo URI). */
  connectionString?: string;
}

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
  /** Tùy chọn nâng cao theo từng loại (ssl, ssh tunnel, connectionString, v.v.). */
  options?: ConnectionOptions;
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
  /** Cho phép xem/sửa cả document dạng JSON (mô hình document như MongoDB). */
  documentEdit: boolean;
  /** Cho phép sửa cấu trúc bảng (ALTER TABLE) hay không. */
  alterStructure: boolean;
  /** Cho phép tạo/xóa/đổi tên bảng & xóa database. */
  manageObjects: boolean;
  /** Cho phép lọc theo giá trị từng cột ở header bảng dữ liệu. */
  columnFilter: boolean;
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

/** Toán tử lọc theo cột. */
export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'isNull' | 'isNotNull';

/** Một điều kiện lọc trên một cột. */
export interface ColumnFilter {
  column: string;
  op: FilterOp;
  /** Không dùng cho isNull/isNotNull. */
  value?: string;
}

export interface PageRequest {
  offset: number;
  limit: number;
  /** sắp xếp: [{column, dir}]. */
  orderBy?: { column: string; dir: 'asc' | 'desc' }[];
  /** Tìm kiếm phía server: SQL -> LIKE mọi cột, Mongo -> regex, Redis -> MATCH pattern. */
  search?: string;
  /** Lọc theo từng cột (AND với nhau và với `search`). */
  filters?: ColumnFilter[];
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

/** Một khóa ngoại. `columns` và `refColumns` khớp nhau theo chỉ số. */
export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  /** Schema của bảng đích, chỉ có ý nghĩa với Postgres khi khác schema hiện tại. */
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

/** Cấu trúc của một bảng/collection. */
export interface TableStructure {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  /** Khóa ngoại; [] với loại DB không có khái niệm này (Mongo, Redis). */
  foreignKeys: ForeignKeyInfo[];
  /** Ghi chú khi loại đối tượng không có cấu trúc dạng bảng (vd Redis keyspace). */
  note?: string;
}

/** Bảng + danh sách cột của nó, dùng cho autocomplete SQL. */
export interface SchemaObject {
  table: string;
  columns: string[];
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

/**
 * Đích chạy một query tự do. Mỗi loại DB dùng trường hợp lệ với mô hình của nó:
 * MariaDB `USE database`; Postgres `SET search_path TO schema` (pool gắn cứng vào
 * một database nên không đổi database được); Mongo lấy `database` làm tên db;
 * Redis lấy `database` làm số hiệu db.
 */
export interface QueryTarget {
  database?: string;
  schema?: string;
}

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

/** Định dạng import/export. */
export type IoFormat = 'csv' | 'json' | 'sql';

/** Kết quả export: đường dẫn file đã ghi + số dòng, hoặc cancelled nếu người dùng hủy. */
export interface ExportResult {
  path?: string;
  count: number;
  cancelled?: boolean;
}

/** Kết quả import: số dòng đã nạp, hoặc cancelled. */
export interface ImportResult {
  count: number;
  cancelled?: boolean;
}

/** Yêu cầu transfer dữ liệu từ một connection nguồn sang connection đích (cùng loại). */
export interface TransferRequest {
  /** ID phiên transfer (renderer sinh, dùng để khớp progress & hủy). */
  transferId: string;
  sourceConnectionId: string;
  /** DB/schema nguồn (bảng chọn qua `tables`). */
  source: { database?: string; schema?: string };
  destConnectionId: string;
  dest: { database?: string; schema?: string };
  /** Tên bảng/collection được chọn để copy (tên đích = tên nguồn). */
  tables: string[];
  /** Tạo cấu trúc ở đích nếu bảng chưa tồn tại. */
  createStructure: boolean;
  /** 'append' = thêm vào; 'truncateInsert' = xóa sạch rồi nạp. */
  writeMode: 'append' | 'truncateInsert';
}

/** Tiến trình phát liên tục trong lúc transfer. */
export interface TransferProgress {
  transferId: string;
  /** Chỉ số bảng đang chạy (0-based). */
  tableIndex: number;
  tableCount: number;
  currentTable: string;
  /** Số dòng đã copy của bảng hiện tại. */
  rowsCopied: number;
  /** Tổng số dòng nếu ước lượng được, null nếu không rõ. */
  rowsTotal: number | null;
}

/** Kết quả transfer của một bảng. */
export interface TransferTableResult {
  table: string;
  status: 'ok' | 'error' | 'cancelled' | 'skipped';
  rows: number;
  error?: string;
}

/** Tổng kết cả phiên transfer. */
export interface TransferSummary {
  results: TransferTableResult[];
  cancelled: boolean;
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

  /** Tạo bảng/collection mới với danh sách cột. */
  createTable(target: DataTarget, columns: ColumnSpec[]): Promise<void>;
  /** Xóa bảng/collection. */
  dropTable(target: DataTarget): Promise<void>;
  /** Xóa toàn bộ dữ liệu nhưng giữ cấu trúc (TRUNCATE / deleteMany / FLUSHDB). */
  truncateTable(target: DataTarget): Promise<void>;
  /** Đổi tên bảng/collection. */
  renameTable(target: DataTarget, newName: string): Promise<void>;
  /** Tạo một database/schema mới. */
  createDatabase(name: string): Promise<void>;
  /** Xóa một database/schema (Redis: FLUSHDB theo index). */
  dropDatabase(name: string): Promise<void>;
  /** Sinh câu lệnh tạo bảng (DDL) — dùng cho "copy cấu trúc". */
  getCreateStatement(target: DataTarget): Promise<string>;

  /** (SQL) Lấy toàn bộ bảng + cột của một database/schema trong 1 truy vấn — cho autocomplete. */
  getSchemaObjects?(database?: string, schema?: string): Promise<SchemaObject[]>;

  /** Chạy query/command tự do tại `target`. `queryId` để hủy giữa chừng (SQL). */
  executeRaw(query: string, target?: QueryTarget, queryId?: string): Promise<QueryResult>;

  /** (SQL) Hủy một query đang chạy đã đăng ký với `queryId`. Không hỗ trợ = không hiện thực. */
  cancelQuery?(queryId: string): Promise<void>;

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

  /** (Document DB) Lấy 1 document theo khóa định danh, trả chuỗi EJSON (pretty). */
  getDocument?(target: DataTarget, rowKey: Record<string, unknown>): Promise<string>;

  /** (Document DB) Thay thế 1 document (theo _id cũ) bằng nội dung EJSON mới. */
  updateDocument?(target: DataTarget, rowKey: Record<string, unknown>, ejson: string): Promise<void>;

  /** (Document DB) Thêm 1 document mới từ chuỗi EJSON. */
  insertDocument?(target: DataTarget, ejson: string): Promise<void>;

  /**
   * (Batch) Ghi nhiều dòng trong 1-vài lệnh INSERT.
   * Nếu adapter không hiện thực, orchestrator fallback gọi insertRow từng dòng.
   */
  insertRows?(target: DataTarget, rows: Record<string, unknown>[]): Promise<void>;

  /** (Document DB) Đọc raw document dạng EJSON canonical để copy giữ nguyên kiểu BSON/lồng nhau. */
  readDocumentsRaw?(target: DataTarget, page: { offset: number; limit: number }): Promise<string[]>;

  /** (Document DB) Ghi nhiều document EJSON bằng insertMany. */
  insertDocumentsRaw?(target: DataTarget, ejsonDocs: string[]): Promise<void>;
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
  objectCreate: 'object:create',
  objectDrop: 'object:drop',
  objectTruncate: 'object:truncate',
  objectRename: 'object:rename',
  databaseCreate: 'database:create',
  databaseDrop: 'database:drop',
  dataUpdate: 'data:update',
  dataInsert: 'data:insert',
  dataDelete: 'data:delete',
  dataGetDocument: 'data:getDocument',
  dataUpdateDocument: 'data:updateDocument',
  dataInsertDocument: 'data:insertDocument',
  queryExecute: 'query:execute',
  queryCancel: 'query:cancel',
  ioExport: 'io:export',
  ioImport: 'io:import',
  ioSaveText: 'io:saveText',
  ioCopyTableSql: 'io:copyTableSql',
  transferStart: 'transfer:start',
  transferProgress: 'transfer:progress',
  transferCancel: 'transfer:cancel',
  schemaObjects: 'schema:objects',
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
  /** (SQL) Lấy bảng + cột của database/schema cho autocomplete; [] nếu loại DB không hỗ trợ. */
  getSchemaObjects(connectionId: string, database?: string, schema?: string): Promise<SchemaObject[]>;
  readRows(connectionId: string, target: DataTarget, page: PageRequest): Promise<RowSet>;
  getStructure(connectionId: string, target: DataTarget): Promise<TableStructure>;
  alterTable(connectionId: string, target: DataTarget, op: AlterOperation): Promise<void>;
  createTable(connectionId: string, target: DataTarget, columns: ColumnSpec[]): Promise<void>;
  dropTable(connectionId: string, target: DataTarget): Promise<void>;
  truncateTable(connectionId: string, target: DataTarget): Promise<void>;
  renameTable(connectionId: string, target: DataTarget, newName: string): Promise<void>;
  createDatabase(connectionId: string, name: string): Promise<void>;
  dropDatabase(connectionId: string, name: string): Promise<void>;
  updateCell(
    connectionId: string,
    target: DataTarget,
    rowKey: Record<string, unknown>,
    column: string,
    value: unknown,
  ): Promise<void>;
  insertRow(connectionId: string, target: DataTarget, values: Record<string, unknown>): Promise<void>;
  deleteRow(connectionId: string, target: DataTarget, rowKey: Record<string, unknown>): Promise<void>;
  getDocument(connectionId: string, target: DataTarget, rowKey: Record<string, unknown>): Promise<string>;
  updateDocument(
    connectionId: string,
    target: DataTarget,
    rowKey: Record<string, unknown>,
    ejson: string,
  ): Promise<void>;
  insertDocument(connectionId: string, target: DataTarget, ejson: string): Promise<void>;
  executeQuery(connectionId: string, query: string, target?: QueryTarget, queryId?: string): Promise<QueryResult>;
  /** Hủy query đang chạy; no-op nếu queryId không còn trong sổ đăng ký. */
  cancelQuery(connectionId: string, queryId: string): Promise<void>;
  /** Xuất toàn bộ dữ liệu một bảng ra file (mở hộp thoại lưu). */
  exportTable(connectionId: string, target: DataTarget, format: IoFormat): Promise<ExportResult>;
  /** Nhập dữ liệu vào một bảng từ file CSV/JSON, hoặc chạy file .sql. */
  importTable(connectionId: string, target: DataTarget, format: IoFormat): Promise<ImportResult>;
  /** Lưu nội dung văn bản tùy ý ra file (dùng cho export kết quả query). */
  saveTextFile(defaultName: string, content: string): Promise<{ path?: string; cancelled?: boolean }>;
  /** Copy SQL của bảng vào clipboard: withData=true gồm cả INSERT, false chỉ DDL. */
  copyTableSql(connectionId: string, target: DataTarget, withData: boolean): Promise<{ chars: number }>;
  /** Bắt đầu transfer; resolve khi hoàn tất, trả tổng kết. */
  startTransfer(req: TransferRequest): Promise<TransferSummary>;
  /** Yêu cầu hủy một phiên transfer đang chạy. */
  cancelTransfer(transferId: string): Promise<void>;
  /** Đăng ký nhận tiến trình; trả về hàm hủy đăng ký. */
  onTransferProgress(cb: (p: TransferProgress) => void): () => void;
}
