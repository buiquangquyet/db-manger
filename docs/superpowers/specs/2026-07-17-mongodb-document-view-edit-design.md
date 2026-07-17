# Xem chi tiết & sửa document MongoDB

**Ngày:** 2026-07-17
**Trạng thái:** Đã duyệt thiết kế

## Mục tiêu

Cho phép người dùng, khi mở một collection MongoDB ở tab "Dữ liệu":

1. **Xem chi tiết** toàn bộ một document (kể cả field lồng nhau) dưới dạng JSON có định dạng.
2. **Sửa** cả document dưới dạng JSON.
3. **Thêm** document mới bằng JSON.
4. **Xóa** document.

Tất cả thao tác giữ nguyên kiểu BSON (ObjectId, Date, v.v.) thông qua **Extended JSON (EJSON)** của gói `bson`.

## Bối cảnh & ràng buộc

- Grid hiện tại (`DataGridView`) flatten document: field lồng nhau bị `JSON.stringify` thành chuỗi để hiển thị — **mất kiểu** và không dùng lại được để ghi.
- MongoDB adapter hiện `updateCell`/`insertRow`/`deleteRow` đều `throw` "chưa hỗ trợ"; `capabilities.inlineEdit = false`.
- Vì document lồng nhau và `_id` là BSON, ta **không** sửa inline từng ô. Thay vào đó sửa **cả document dạng JSON** trong modal (Monaco editor).
- `bson` đã có sẵn trong `node_modules` (dependency của driver `mongodb`) → import `EJSON` được ở main process.
- Monaco đã dùng ở `QueryPanel`; hiện `monaco-setup.ts` chỉ nạp ngôn ngữ SQL.

## Kiến trúc tổng quan

```
DataGridView (renderer)
  │  double-click row / nút Thêm / nút Xóa
  ▼
DocumentModal (renderer, Monaco JSON)
  │  window.api.getDocument / updateDocument / insertDocument / deleteRow
  ▼
preload  →  IPC  →  SessionManager  →  MongoAdapter (EJSON parse/stringify)  →  MongoDB
```

Nguồn sự thật khi **sửa** là fetch lại document theo `_id` (trả EJSON), **không** lấy từ ô grid (đã mất kiểu).

## Thay đổi chi tiết

### 1. `src/shared/types.ts`

**Capabilities** — thêm cờ:

```ts
/** Cho phép xem/sửa cả document dạng JSON (mô hình document như MongoDB). */
documentEdit: boolean;
```

**DatabaseAdapter** — thêm 3 method **optional** (SQL/Redis adapters không cần implement):

```ts
/** Lấy 1 document theo khóa định danh, trả về chuỗi EJSON (pretty). */
getDocument?(target: DataTarget, rowKey: Record<string, unknown>): Promise<string>;
/** Thay thế 1 document (theo _id cũ) bằng nội dung EJSON mới. */
updateDocument?(target: DataTarget, rowKey: Record<string, unknown>, ejson: string): Promise<void>;
/** Thêm 1 document mới từ chuỗi EJSON. */
insertDocument?(target: DataTarget, ejson: string): Promise<void>;
```

Xóa dùng lại `deleteRow(target, rowKey)` sẵn có.

**IpcChannels** — thêm:

```ts
dataGetDocument: 'data:getDocument',
dataUpdateDocument: 'data:updateDocument',
dataInsertDocument: 'data:insertDocument',
```

**RendererApi** — thêm 3 method tương ứng:

```ts
getDocument(connectionId: string, target: DataTarget, rowKey: Record<string, unknown>): Promise<string>;
updateDocument(connectionId: string, target: DataTarget, rowKey: Record<string, unknown>, ejson: string): Promise<void>;
insertDocument(connectionId: string, target: DataTarget, ejson: string): Promise<void>;
```

### 2. `src/main/adapters/mongo.ts`

- `capabilities`: đặt `documentEdit: true` (giữ `inlineEdit: false`).
- `readRows`: đánh dấu cột `_id` là `isPrimaryKey` khi dựng `columns`, để grid dựng được row-key cho xem/sửa/xóa.
- Import `EJSON` và `ObjectId` từ `bson`.
- Helper `parseId(rowKey)`: lấy `rowKey._id`; nếu là chuỗi hex 24 ký tự hợp lệ → `new ObjectId(...)`, ngược lại giữ nguyên giá trị (một số collection dùng `_id` không phải ObjectId).
- Implement:
  - `getDocument(target, rowKey)`: `findOne({ _id: parseId })` → nếu không thấy thì `throw`; trả `EJSON.stringify(doc, undefined, 2)`.
  - `updateDocument(target, rowKey, ejson)`: `EJSON.parse(ejson)` → nếu document mới có `_id` khác `_id` cũ thì `throw` (không cho đổi `_id`); `replaceOne({ _id: parseId }, doc)`. (Dùng `replaceOne` giữ nguyên `_id`; loại `_id` khỏi phần thay thế nếu cần để tránh lỗi immutable field.)
  - `insertDocument(target, ejson)`: `EJSON.parse(ejson)` → `insertOne(doc)`.
  - `deleteRow(target, rowKey)`: thay `throw` bằng `deleteOne({ _id: parseId })`.
- `insertRow`/`updateCell` giữ nguyên `throw` (không dùng cho luồng document).

### 3. `src/main/ipc.ts`

Đăng ký 3 handler mới, gọi qua `sessions.get(connectionId)` như các handler hiện có. Vì method là optional, kiểm tra tồn tại trước khi gọi (hoặc dựa vào việc UI chỉ gọi khi `documentEdit`).

### 4. `src/preload/index.ts`

Thêm 3 hàm `getDocument`/`updateDocument`/`insertDocument` map vào IPC channel mới.

### 5. `src/renderer/src/monaco-setup.ts`

- Import `monaco-editor/esm/vs/language/json/monaco.contribution` để có highlight/validate JSON.
- Import json worker và trả đúng worker theo `label` trong `MonacoEnvironment.getWorker` (`json` → json worker, còn lại → editor worker).

### 6. `src/renderer/src/components/DocumentModal.tsx` (mới)

- Props: `open`, `mode: 'view' | 'edit' | 'create'`, `connectionId`, `target`, `rowKey?` (cho edit/view), `onClose`, `onSaved` (callback reload grid).
- Tạo Monaco editor ngôn ngữ `json` trong modal.
- `view`: nạp EJSON qua `getDocument`, editor `readOnly`.
- `edit`: nạp EJSON qua `getDocument`; nút Lưu → `updateDocument`.
- `create`: nội dung khởi tạo `{\n  \n}`; nút Lưu → `insertDocument`.
- Nút "Định dạng" (format JSON). Trước khi lưu: `JSON.parse` để bắt lỗi cú pháp phía client → nếu lỗi hiện thông báo, không gửi.
- Lưu thất bại (vd trùng `_id`, đổi `_id`) → giữ modal mở, `message.error`.
- Dọn editor khi đóng modal (dispose).

### 7. `src/renderer/src/components/DataGridView.tsx`

- Thêm prop `documentEdit: boolean`.
- Khi `documentEdit`:
  - `onRowDoubleClicked` → mở `DocumentModal` mode `edit` với `rowKey = buildRowKey(row)`.
  - Nút "Thêm dòng" → mở `DocumentModal` mode `create` (thay `AddRowModal`).
  - Hiện cột checkbox + cho phép "Xóa dòng" dựa trên `_id` (không phụ thuộc `inlineEdit`). Tách điều kiện: `canDelete = (inlineEdit || documentEdit) && hasPrimaryKey`; `canInsert = inlineEdit ? cols>0 : documentEdit`.
  - Không cho sửa inline ô (editable=false với mọi cột khi chỉ có `documentEdit`).
  - Chú thích chân grid: "Double-click để xem/sửa document · tick chọn để xóa".
- Giữ nguyên hành vi cũ cho SQL (`inlineEdit`).

### 8. `src/renderer/src/App.tsx`

Truyền `documentEdit={session.capabilities.documentEdit}` vào `DataGridView`.

### 9. Các adapter khác (`postgres`, `mariadb`, `redis`)

Thêm `documentEdit: false` vào `capabilities` của từng adapter (bắt buộc vì thêm field vào interface `Capabilities`).

## Xử lý lỗi

| Tình huống | Xử lý |
|---|---|
| JSON sai cú pháp khi lưu | Bắt ở client (`JSON.parse`), hiện lỗi tại modal, không gửi IPC |
| EJSON.parse lỗi ở main | `throw` → renderer `message.error`, giữ modal mở |
| Người dùng đổi `_id` khi sửa | Adapter `throw` với thông báo rõ, giữ modal mở |
| Document không tồn tại khi mở edit | `getDocument` `throw`, modal hiện lỗi |
| Xóa/lưu trùng khóa | `throw` từ driver → `message.error` |

## Ngoài phạm vi (YAGNI)

- Sửa inline từng ô cho MongoDB.
- Trình soạn dạng cây (tree editor) — chỉ dùng JSON text.
- Sửa nhiều document cùng lúc (bulk edit).
- Validate schema JSON tùy chỉnh.

## Kiểm thử / nghiệm thu

- Mở một collection có document lồng nhau → double-click → thấy JSON đầy đủ, đúng kiểu (ObjectId, Date hiển thị dạng EJSON).
- Sửa một field, Lưu → grid reload, giá trị đã đổi; kiểu BSON được giữ.
- Thêm document mới bằng JSON → xuất hiện trong grid.
- Xóa document đã chọn → biến mất khỏi grid.
- Nhập JSON sai cú pháp → báo lỗi, không mất dữ liệu đang nhập.
- Đổi `_id` khi sửa → bị chặn.
- Với DB SQL: hành vi grid không đổi (vẫn sửa inline như cũ), không xuất hiện luồng document.
- `npm run typecheck` sạch.
