# PRD: Ba cải thiện luồng làm việc với query

Ngày: 2026-08-11
Branch: `feat/query-workflow` (tách từ `main` sau khi PR #4 merge)
Trạng thái: đã duyệt thiết kế, chờ thực hiện theo ba plan riêng.

## Bối cảnh

Khảo sát codebase ngày 2026-08-11 tìm ra một loạt khoảng trống. PRD này gom ba cái được
chọn làm trước vì tỉ lệ giá trị/công sức cao nhất và không đụng tới kiến trúc:

1. **Hủy query đang chạy + phím tắt Ctrl/Cmd+Enter** — hiện lỡ chạy query nặng thì chỉ
   còn cách kill app; chạy query phải bấm chuột.
2. **Query history** — chạy xong là mất, không có gì lưu lại (`grep history` trong
   `renderer/` không ra kết quả nào).
3. **Foreign key trong StructureView** — `TableStructure` (`types.ts:171-176`) chỉ có
   `columns` + `indexes`; đọc một schema lạ không thấy được quan hệ giữa các bảng.

Ngoài phạm vi PRD này (đã khảo sát, để lại có chủ ý): nhiều phiên đồng thời, nhiều tab
query, backup/restore, quản lý user/quyền, ERD, so sánh schema. Hai thứ chết cần dọn
riêng: `capabilities.transactions` khai báo ở cả 4 adapter nhưng không nơi nào đọc, và
`closeSession` expose ở preload nhưng renderer không bao giờ gọi.

## Nguyên tắc chung cho cả ba

- Không thêm dependency mới.
- Gate tự động: `npm run typecheck` + `npm run build`. Repo không có test framework; hàm
  thuần kiểm bằng script esbuild + node theo khuôn `scripts/check-tree-utils.ts` đã có
  trên `main`.
- Chuỗi hiển thị và comment bằng tiếng Việt, khớp văn phong hiện có.
- Thứ tự thực hiện: **FK → hủy query → history**. FK độc lập hoàn toàn; hai cái sau đều
  sửa `QueryPanel.tsx` nên phải nối tiếp để tránh chồng chéo.

---

## Tính năng 1: Hủy query + phím tắt

### Quyết định đã chốt

| Câu hỏi | Chọn |
|---|---|
| Phạm vi DB | Chỉ MariaDB + Postgres. Mongo/Redis không hiện nút Hủy. |

### Cơ chế

Hủy một query đang chạy **không phải** là abort một Promise — kết nối đang bận chờ
server. Phải giết từ một kết nối thứ hai:

- **MariaDB** — `connection.threadId` có sẵn và đã khai báo kiểu
  (`mysql2/typings/mysql/lib/Connection.d.ts:365`). Mượn connection khác trong pool, chạy
  `KILL QUERY <threadId>`.
- **Postgres** — `client.processID` tồn tại lúc chạy (`pg/lib/client.js:364`) nhưng
  **không có trong `@types/pg`**, phải cast kèm comment giải thích. Từ client khác chạy
  `SELECT pg_cancel_backend($1)`.

Renderer sinh `queryId` mỗi lần chạy và gửi kèm. Adapter đăng ký `queryId → threadId/pid`
lúc bắt đầu, gỡ trong `finally`. Kênh mới `query:cancel(connectionId, queryId)` gọi
`adapter.cancelQuery?.(queryId)`. Khuôn này lặp lại đúng `transferId → transferFlags` mà
`ipc.ts` đã dùng cho transfer.

### Hai chỗ dễ sai

**Query bị giết sẽ ném lỗi, không resolve.** MariaDB trả `ER_QUERY_INTERRUPTED`, Postgres
trả SQLSTATE `57014`. Không nhận diện hai mã này thì người dùng bấm Hủy xong lại nhận một
thông báo lỗi đỏ như thể có sự cố. Phải map thành thông báo `Đã hủy query`.

**`addCommand` đóng băng closure.** Editor được tạo một lần trong effect mount
(`QueryPanel.tsx:89`), nên callback đăng ký lúc đó sẽ giữ mãi state của render đầu tiên —
chạy bằng phím tắt sẽ dùng `targetConnId`/`queryTarget` cũ, tức là **chạy sai đích**,
đúng loại lỗi mà tính năng chọn đích vừa mới sửa xong. Bắt buộc giữ `runRef.current = run`
mỗi render và command chỉ gọi `runRef.current()`.

### Hành vi

- Đang chạy: nút `Chạy` chuyển thành trạng thái loading, hiện thêm nút `Hủy`.
- `Ctrl/Cmd+Enter` chạy query. Có bôi đen thì chỉ chạy phần bôi đen.
- Hủy xong: thông báo `Đã hủy query`, vùng kết quả giữ nguyên nội dung trước đó.

---

## Tính năng 2: Query history

### Quyết định đã chốt

| Câu hỏi | Chọn |
|---|---|
| Nơi hiển thị | Panel dưới editor, thành `Tabs`: `Kết quả` \| `Lịch sử` |

### Ghi ở main, không ở renderer

Handler `query:execute` trong `ipc.ts` đã bọc quanh `executeRaw`, nên ghi ở đó bắt được
cả ca thành công lẫn thất bại và không mất bản ghi khi renderer reload.

Module `src/main/query-history.ts` theo đúng khuôn `SecureStore`: JSON tại
`app.getPath('userData')/query-history.json`, cap **500** bản ghi kiểu FIFO. Không thêm
dependency.

Mỗi bản ghi:

```ts
export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  database?: string;
  schema?: string;
  sql: string;
  /** epoch ms lúc bắt đầu chạy. */
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  rowCount?: number;
  error?: string;
}
```

Lưu `connectionId` chứ không lưu tên kết nối — tên có thể đổi, renderer tự tra lại từ
`connections` để không hiển thị dữ liệu cũ nói sai.

Kênh mới: `history:list`, `history:clear`.

### UI

Vùng dưới editor thành `Tabs`. Tab `Lịch sử` là bảng antd: thời gian, trạng thái, thời
lượng, số dòng, và SQL rút gọn. Click một dòng nạp SQL trở lại editor. Checkbox
`Chỉ kết nối này` bật sẵn. Nút `Xóa lịch sử` có xác nhận.

### Đánh đổi về bảo mật — có chủ ý

File này lưu **toàn văn mọi query**, gồm cả dữ liệu nhạy cảm nằm trong mệnh đề `WHERE`,
và **không mã hóa** — khác với mật khẩu kết nối vốn đi qua `safeStorage`. Đây là mức phù
hợp cho một công cụ dev chạy local, nhưng là đánh đổi có ý thức chứ không phải sơ suất.
Nếu sau này cần siết, hai hướng: mã hóa file bằng `safeStorage` như `secure-store`, hoặc
thêm tùy chọn tắt ghi history.

---

## Tính năng 3: Foreign key trong StructureView

### Quyết định đã chốt

| Câu hỏi | Chọn |
|---|---|
| Phạm vi | Chỉ hiển thị. Không thêm/xóa FK ở phiên bản này. |

### Kiểu dữ liệu

```ts
export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}
```

`TableStructure` thêm `foreignKeys: ForeignKeyInfo[]` — **bắt buộc, không optional**. Để
typecheck ép cả bốn adapter khai báo; Mongo/Redis trả mảng rỗng một cách tường minh thay
vì lặng lẽ bỏ sót.

### Truy vấn

- **MariaDB** — `information_schema.KEY_COLUMN_USAGE` join `REFERENTIAL_CONSTRAINTS` theo
  `CONSTRAINT_NAME` + `CONSTRAINT_SCHEMA`, lọc `REFERENCED_TABLE_NAME IS NOT NULL`, sắp
  theo `ORDINAL_POSITION`.
- **Postgres** — `pg_constraint` với `contype = 'f'`, dùng
  `unnest(conkey) WITH ORDINALITY` và `unnest(confkey) WITH ORDINALITY` rồi join theo thứ
  tự. **Bắt buộc giữ đúng thứ tự cột**: nối `conkey` với `confkey` sai thứ tự tạo ra FK
  hiển thị sai cặp cột trong khóa phức — sai âm thầm, rất khó phát hiện bằng mắt.

Phần gom nhiều dòng thành một FK là hàm thuần, đặt trong `sql-util.ts` cạnh
`groupColumnsByTable` sẵn có, kiểm bằng script esbuild.

### UI

Thêm một mục `Khóa ngoại (N)` trong `StructureView` ngay dưới mục `Index`
(`StructureView.tsx:191-205`), cùng kiểu `Typography.Title` + `Table`. Cột: tên
constraint, cột nguồn, bảng đích, cột đích, ON DELETE, ON UPDATE. Không có FK thì mục vẫn
hiện với số 0 để phân biệt "bảng không có FK" với "chưa tải xong".

---

## Tiêu chí hoàn thành

Mỗi tính năng xong khi: `npm run typecheck` và `npm run build` xanh, script kiểm hàm
thuần xanh (với FK), và kiểm tay trong `npm run dev` đạt các điểm dưới đây.

**Hủy query**

1. Chạy `SELECT SLEEP(30)` trên MariaDB, bấm Hủy → query dừng, hiện `Đã hủy query`, không
   hiện lỗi đỏ.
2. Tương tự trên Postgres với `SELECT pg_sleep(30)`.
3. Đổi select đích sang database khác rồi chạy bằng **Ctrl/Cmd+Enter** → phải chạy đúng
   đích mới, không phải đích lúc mở panel. Đây là ca bắt lỗi stale closure.
4. Bôi đen một câu trong nhiều câu → chỉ câu đó chạy.
5. Kết nối Mongo/Redis → không thấy nút Hủy.

**History**

1. Chạy vài query thành công và một query lỗi → cả hai đều xuất hiện trong tab Lịch sử.
2. Click một dòng → SQL nạp lại vào editor.
3. Khởi động lại app → lịch sử vẫn còn.
4. Bỏ tick `Chỉ kết nối này` → thấy cả query của kết nối khác.
5. Chạy quá 500 query → bản ghi cũ nhất bị đẩy ra, file không phình vô hạn.

**Foreign key**

1. Bảng MariaDB có FK khóa đơn → hiện đúng bảng/cột đích và ON DELETE/UPDATE.
2. Bảng có FK **khóa phức nhiều cột** → thứ tự cột nguồn khớp đúng thứ tự cột đích.
3. Bảng Postgres có FK trỏ sang schema khác → cột bảng đích hiển thị kèm schema.
4. Bảng không có FK → mục hiện `Khóa ngoại (0)`.
5. Collection Mongo / keyspace Redis → mục FK trống, không lỗi.
