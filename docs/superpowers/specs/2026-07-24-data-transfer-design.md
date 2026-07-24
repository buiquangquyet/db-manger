# Thiết kế: Transfer Data giữa các kết nối cùng loại

Ngày: 2026-07-24
Trạng thái: Đã duyệt thiết kế, chờ viết plan.

## 1. Mục tiêu & phạm vi

Cho phép copy dữ liệu (và tùy chọn cấu trúc) của bảng/collection từ một
**connection nguồn** sang một **connection đích** trong danh sách kết nối đã lưu.

Ràng buộc & phạm vi v1:

- Nguồn và đích **bắt buộc cùng `DbKind`** (mariadb→mariadb, postgres→postgres,
  mongodb→mongodb). Khác loại bị chặn ở UI và validate lại ở main process.
- Hỗ trợ v1: **SQL (MariaDB, Postgres) + MongoDB**. Redis (key-value) để sau.
- Chọn **tất cả bảng** hoặc **tick từng bảng**.
- Tên bảng đích = tên bảng nguồn (không đổi tên ở v1).
- Checkbox **"Tạo cấu trúc nếu bảng đích chưa có"**.
- Chế độ ghi (chọn mỗi lần chạy): **Append** hoặc **Truncate + Insert**.
- Ghi theo **lô (batch insert)** ngay từ v1 để nhanh.
- Lỗi một bảng → ghi nhận và **tiếp tục bảng kế tiếp**; có nút **Hủy**; kết thúc
  hiện bảng tổng kết.

Ngoài phạm vi (YAGNI v1): đổi tên bảng khi copy, chọn tập cột con, transaction bao
cả bảng, transfer khác loại DB, Redis, đồng bộ/incremental.

## 2. Bối cảnh mã nguồn hiện tại

- Adapter pattern: mỗi loại DB hiện thực `DatabaseAdapter` (`src/main/adapters/*`).
  UI chỉ nói chuyện qua interface này qua IPC.
- `SessionManager` (`src/main/session-manager.ts`) giữ nhiều adapter mở cùng lúc
  theo `connectionId` → mở được **2 session** (nguồn + đích) song song. Yêu cầu:
  cả hai session phải **đang mở** khi transfer.
- `src/main/io.ts` đã có khuôn `readAll()` phân trang qua `readRows` + ghi qua
  `insertRow` (export/import) — transfer là một module song song, KHÔNG sửa io.ts.
- `capabilities.dataModel` phân biệt `relational` / `document` / `keyvalue` →
  orchestrator dùng để chọn đường copy.

Ràng buộc kỹ thuật đã xác minh:

- SQL `readRows`→`insertRow` round-trip tốt (chính là cơ chế import hiện tại).
- Mongo `readRows` **JSON-hóa** giá trị lồng nhau và đổi `ObjectId`→hex string
  (`mongo.ts:178-186`). Do đó **không** dùng `readRows` để copy Mongo — sẽ mất
  fidelity BSON/nested. Mongo dùng đường **document-native** (EJSON canonical).
- SQL `getCreateStatement`: MariaDB dùng `SHOW CREATE TABLE` (tên bảng trần, không
  kèm database) → chạy đúng trong context DB đích. Postgres dựng DDL kèm qualifier
  schema (`postgres.ts:354`).

## 3. Kiến trúc backend

Module mới `src/main/transfer.ts` (song song với `io.ts`). Dùng `SessionManager` để
lấy **cả hai** adapter (nguồn + đích). Không sửa adapter hiện có ngoài việc thêm các
method **optional** ở mục 5.

Luồng cho mỗi bảng được chọn:

1. **Kiểm tra tồn tại** ở đích: `dest.getTableList(destDb, destSchema)` → tên bảng
   đã có chưa.
2. **Tạo cấu trúc** (nếu bật checkbox & bảng chưa tồn tại):
   - SQL: `source.getCreateStatement(srcTarget)` → `dest.executeRaw(ddl, destDb)`.
     Postgres: nếu schema đích khác schema nguồn, rewrite qualifier trong DDL sang
     schema đích; mặc định giả định cùng tên schema.
   - Mongo: `dest.createTable(destTarget, [])` (tạo collection rỗng).
   - Nếu bật checkbox nhưng bảng **đã tồn tại** → bỏ qua bước tạo (không lỗi).
3. **Truncate** (nếu chọn Truncate+Insert & bảng đã tồn tại từ trước):
   `dest.truncateTable(destTarget)`. (Bảng vừa tạo thì đã rỗng, bỏ qua.)
4. **Copy dữ liệu** — phân trang `PAGE = 1000`, **không giới hạn 100k** như export:
   - SQL: `source.readRows(srcTarget, {offset, limit})` → `dest.insertRows(destTarget, rows)`.
   - Mongo: `source.readDocumentsRaw(srcTarget, {offset, limit})` (mảng EJSON canonical)
     → `dest.insertDocumentsRaw(destTarget, ejsonDocs)`.
   - Sau mỗi lô: kiểm tra cờ hủy, cộng dồn `rowsCopied`, đẩy `transfer:progress`.
   - Dừng khi số bản ghi đọc được < `PAGE`.

Xử lý lỗi: bọc mỗi bảng trong try/catch. Lỗi → `TransferTableResult.status='error'`
kèm message, tiếp tục bảng sau. Hủy → các bảng chưa chạy đánh dấu `cancelled`.

## 4. Giao thức IPC & tiến trình

Transfer chạy lâu nên dùng **event streaming** (khác request/response của các channel
hiện có).

Kênh IPC mới (thêm vào `IpcChannels` trong `shared/types.ts`):

- `transfer:start` — `ipcMain.handle`, nhận `TransferRequest`, trả `TransferSummary`
  khi hoàn tất.
- `transfer:progress` — main → renderer qua `event.sender.send` / `webContents.send`,
  đẩy `TransferProgress` liên tục.
- `transfer:cancel` — `ipcMain.handle`, set cờ hủy theo `transferId`. Orchestrator giữ
  một `Map<transferId, {cancelled:boolean}>`; kiểm tra ở ranh giới lô/bảng.

Preload (`src/preload/index.ts` + `RendererApi`):

- `startTransfer(req: TransferRequest): Promise<TransferSummary>`
- `cancelTransfer(transferId: string): Promise<void>`
- `onTransferProgress(cb: (p: TransferProgress) => void): () => void` (trả hàm hủy
  đăng ký listener).

Kiểu dữ liệu mới trong `shared/types.ts`:

```ts
export interface TransferRequest {
  transferId: string;
  sourceConnectionId: string;
  /** DB/schema nguồn (name bỏ trống — chọn bảng qua `tables`). */
  source: { database?: string; schema?: string };
  destConnectionId: string;
  dest: { database?: string; schema?: string };
  /** Tên bảng/collection được chọn để copy. */
  tables: string[];
  /** Tạo cấu trúc ở đích nếu bảng chưa tồn tại. */
  createStructure: boolean;
  writeMode: 'append' | 'truncateInsert';
}

export interface TransferProgress {
  transferId: string;
  tableIndex: number;   // 0-based bảng đang chạy
  tableCount: number;
  currentTable: string;
  rowsCopied: number;   // số dòng đã copy của bảng hiện tại
  rowsTotal: number | null;
}

export interface TransferTableResult {
  table: string;
  status: 'ok' | 'error' | 'cancelled' | 'skipped';
  rows: number;
  error?: string;
}

export interface TransferSummary {
  results: TransferTableResult[];
  cancelled: boolean;
}
```

## 5. Thay đổi adapter (tối thiểu, đều optional)

Thêm vào interface `DatabaseAdapter` các method **optional** với fallback:

```ts
/** Ghi nhiều dòng trong 1-vài lệnh (multi-row INSERT). Thiếu → orchestrator fallback loop insertRow. */
insertRows?(target: DataTarget, rows: Record<string, unknown>[]): Promise<void>;

/** (Document DB) Đọc raw EJSON canonical để copy giữ nguyên kiểu BSON/nested. */
readDocumentsRaw?(target: DataTarget, page: { offset: number; limit: number }): Promise<string[]>;

/** (Document DB) Ghi nhiều document EJSON bằng insertMany. */
insertDocumentsRaw?(target: DataTarget, ejsonDocs: string[]): Promise<void>;
```

Hiện thực:

- **MariaDB** (`mariadb.ts`): `insertRows` dựng `INSERT INTO … VALUES (…),(…),…`.
  Tự **chunk** theo `max_allowed_packet` / số placeholder — giới hạn an toàn ví dụ
  ≤ 500 dòng hoặc ≤ ~2000 tham số mỗi lệnh.
- **Postgres** (`postgres.ts`): `insertRows` multi-row, chunk theo giới hạn tham số
  của `pg` (~65535) — an toàn ≤ 500 dòng hoặc ≤ ~2000 tham số/lệnh.
- **Mongo** (`mongo.ts`): `readDocumentsRaw` (find + skip/limit, `EJSON.stringify`
  canonical `{relaxed:false}` mỗi doc) và `insertDocumentsRaw` (`EJSON.parse` từng doc
  rồi `insertMany`, tái dùng `coerceImportedId` cho `_id`).
- SQL adapter **không cần** đường document; Mongo **không cần** `insertRows`.
- Orchestrator: thiếu method batch → fallback `insertRow` / `insertDocument` từng cái.

## 6. UI — Wizard modal

Component mới `src/renderer/src/components/TransferModal.tsx`, mở từ **menu chuột phải
node database** trong `Sidebar.tsx` → mục "Transfer sang…" (nguồn = database đang chọn).

3 bước (Ant Design `Steps` + `Modal`):

1. **Chọn đích**: dropdown connection — chỉ liệt kê connection **cùng `kind`** với
   nguồn (lọc từ `listConnections`). Sau khi chọn, mở session đích nếu chưa mở, rồi
   dropdown database/schema đích (`getRootNodes`/`getTableList` tùy loại).
2. **Chọn bảng & tùy chọn**: danh sách bảng từ `getTableList` nguồn với checkbox +
   "Chọn tất cả"; checkbox "Tạo cấu trúc nếu chưa có"; radio Append / Truncate+Insert.
3. **Tiến trình**: `Progress` tổng theo `tableIndex/tableCount`; dòng trạng thái
   "đang copy `<bảng>` (i/n) — `<rowsCopied>` dòng"; nút **Hủy** (gọi `cancelTransfer`);
   khi xong hiện `Table` tổng kết mỗi bảng (OK/Lỗi/số dòng), nút **Đóng**.

Renderer đăng ký `onTransferProgress` khi mở bước 3, hủy đăng ký khi đóng modal.

## 7. Giới hạn đã biết (v1)

- Batch insert có **chunk** theo giới hạn driver; **không** bao transaction cả bảng
  (một lô lỗi có thể để lại dữ liệu một phần — báo trong tổng kết).
- Không đổi tên bảng, không chọn tập cột con.
- Postgres: giả định schema đích cùng tên schema nguồn (rewrite qualifier chỉ khi
  người dùng chọn schema đích khác).
- Redis chưa hỗ trợ.
- Cả hai session (nguồn + đích) phải mở được; nếu mở session đích lỗi → báo ở bước 1.
