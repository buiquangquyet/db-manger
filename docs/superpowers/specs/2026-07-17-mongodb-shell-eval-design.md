# Design: Mongo Shell evaluation

**Date:** 2026-07-17
**Branch:** `feat/mongodb-document-edit`
**Status:** Approved

## Goal

Cho phép ô "Mongo Shell" trong `QueryPanel` chạy lệnh cú pháp mongosh thật, ví dụ:

```js
db.terms.findOne({_id: ObjectId("69140858a357b4dbc9d3e237")})
db.terms.find({active: true}).sort({name: 1}).limit(10)
db.terms.updateOne({_id: ObjectId("..")}, {$set: {x: 1}})
db.terms.aggregate([{$match: {...}}, {$group: {...}}])
```

Hiện tại `MongoAdapter.executeRaw` (`src/main/adapters/mongo.ts:187`) chỉ nhận JSON `runCommand`
thuần (vd `{"find":"users","limit":10}`). Feature này nâng cấp nó để đánh giá cú pháp shell.

## Scope

- **CRUD đầy đủ** (đọc + ghi): `find`/`findOne`/`aggregate`/`countDocuments`/`distinct` và
  `insertOne`/`insertMany`/`updateOne`/`updateMany`/`replaceOne`/`deleteOne`/`deleteMany`/`bulkWrite`.
- **Cú pháp linh hoạt như mongosh**: hỗ trợ chaining cursor (`.sort().limit().skip().project()`),
  các helper kiểu BSON (`ObjectId`, `ISODate`, `NumberLong`, ...), và bất kỳ method nào của
  driver collection.
- **Một biểu thức mỗi lần chạy** (single expression). Không hỗ trợ nhiều statement / khai báo biến.

Ngoài scope: nhiều statement, `use <db>`, `show collections`, biến shell, JS tùy ý ngoài lệnh db.

## Architecture

Tách logic eval rủi ro ra một module riêng, có ranh giới rõ và test được độc lập.

### Module mới: `src/main/adapters/mongo-shell.ts`

Interface duy nhất:

```ts
export function evalMongoShell(db: Db, expr: string): Promise<unknown>
```

- Cú pháp shell *chính là* JavaScript. Ta đánh giá biểu thức trong một **`vm` context hạn chế**.
- Context chỉ phơi bày:
  - `db` → proxy: `db.<name>` trả về `db.collection(name)` thật của driver.
    `FindCursor` của driver vốn đã hỗ trợ `.sort()/.limit()/.skip()/.project()/.toArray()`,
    nên chaining hoạt động sẵn.
  - Helper kiểu BSON: `ObjectId`, `ISODate` (alias `Date`), `NumberLong` (Long),
    `NumberInt` (Int32), `NumberDecimal` (Decimal128), `UUID`, `BinData` (Binary), `Timestamp`.
  - **Không** phơi bày `require`, `process`, `global`, `module`, v.v.
- Biểu thức được bọc trong async IIFE để có thể `await` kết quả, rồi trả giá trị thô về
  cho `executeRaw` chuẩn hóa.

**Ghi chú bảo mật:** `vm` là *cô lập*, không phải sandbox cứng — có thể có cách thoát. Threat
model chấp nhận được: đây là công cụ desktop chạy cục bộ, do chính chủ DB vận hành; người dùng
vốn đã có toàn quyền truy cập DB và tự gõ query của mình. Sẽ ghi rõ giới hạn này trong comment.

### Sửa `MongoAdapter.executeRaw` (`src/main/adapters/mongo.ts`)

Điều phối theo đầu vào (nhánh không chồng lấn):

- `trimmed.startsWith('{')` → giữ nguyên đường JSON `runCommand` cũ (tương thích ngược).
- Ngược lại (bắt đầu bằng `db.`) → gọi `evalMongoShell(db, trimmed)` rồi **chuẩn hóa kết quả**.

### Chuẩn hóa kết quả → `QueryResult`

| Giá trị eval trả về | Nhận diện | Ánh xạ |
|---|---|---|
| Cursor (`find`, `aggregate`) | có `.toArray` | `await toArray()` → mảng doc → `RowSet` (grid) |
| Doc đơn (`findOne`) | object không phải result | 1 dòng `RowSet` |
| Kết quả ghi (`insertOne`/`updateOne`/`deleteOne`/`bulkWrite`) | có `acknowledged`/`matchedCount`/`insertedId`/`deletedCount` | `message` chuỗi (vd `matched 1, modified 1`; `insertedId: <hex>`; `deleted 2`) |
| Scalar (`countDocuments`, `distinct` mảng nguyên thủy) | number / mảng nguyên thủy | `message` |

Dựng `RowSet` dùng lại cách hiện có trong `executeRaw`/`readRows`: hợp nhất key để ra cột,
`ObjectId` → hex trần, object lồng nhau → chuỗi JSON. Kèm `durationMs` đo bằng `process.hrtime`.

### UI: `queryPlaceholder` (`src/renderer/src/App.tsx:167`)

Đổi placeholder nhánh `document` từ `{"find":"users","limit":10}` sang
`db.users.find({}).limit(10)` để ví dụ khớp cách dùng thật.

## Testing

Repo **không có test framework** (theo đúng convention của feature MongoDB trước đó). Xác minh
theo hai lớp:

1. **Cổng tự động:** `npm run typecheck` phải sạch (`strict: true` ở cả hai tsconfig).
2. **Kiểm thử hành vi thủ công** qua `npm run dev`, chạy checklist lệnh shell thật trên một
   MongoDB kết nối được:
   - `db.<col>.findOne({_id: ObjectId("...")})` → 1 dòng.
   - `db.<col>.find({}).sort({_id: -1}).limit(5)` → tối đa 5 dòng, đúng thứ tự.
   - `db.<col>.aggregate([{$limit: 3}])` → 3 dòng.
   - `db.<col>.countDocuments({})` → message số đếm.
   - `db.<col>.insertOne({_probe: 1})` rồi `db.<col>.deleteOne({_probe: 1})` → message ghi.
   - `{"find":"<col>","limit":1}` (JSON cũ) → vẫn chạy (tương thích ngược).
   - `process.exit(0)` / biểu thức lạ → báo lỗi gọn, app không crash.

`evalMongoShell` được tách riêng để dễ suy luận và có thể bổ sung test tự động sau khi repo có
test runner, nhưng phạm vi hiện tại không thêm dependency test.

## Backward compatibility

Đường JSON `runCommand` cũ giữ nguyên (đầu vào bắt đầu bằng `{`). Không phá query đang dùng.