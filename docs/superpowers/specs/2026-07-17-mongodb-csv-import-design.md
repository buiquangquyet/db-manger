# Import CSV (và JSON) cho MongoDB

**Ngày:** 2026-07-17
**Trạng thái:** Đã duyệt

## Mục tiêu

Cho phép import file CSV vào một collection MongoDB qua nút "Nhập → CSV" đã có sẵn trong grid.

## Bối cảnh

- UI "Nhập" (CSV/JSON/SQL) đã có cho mọi DB trong `DataGridView`.
- Pipeline `importTable` (`src/main/io.ts:119-147`) parse file rồi gọi `adapter.insertRow(target, row)` cho mỗi dòng.
- `MongoAdapter.insertRow` hiện **throw** "chưa hỗ trợ" → import CSV/JSON fail cho MongoDB.

Giải pháp: **hiện thực `MongoAdapter.insertRow`** với suy kiểu tự động. Không đổi UI hay pipeline.
Việc này cũng làm JSON-array import chạy được (cùng gọi `insertRow`).

## Thiết kế

Hiện thực `insertRow(target, values)` trong `src/main/adapters/mongo.ts`:

1. Duyệt từng cặp key/value của `values`, dựng object `doc` đã suy kiểu.
2. Suy kiểu — **chỉ áp dụng khi value là `string`** (giá trị từ CSV):
   - `''` (chuỗi rỗng) → **bỏ field** (không thêm vào `doc`).
   - Số round-trip chính xác → `number`: `const n = Number(s); if (s !== '' && Number.isFinite(n) && String(n) === s) → n`.
     - `"7"`→`7`; `"007"`→giữ chuỗi; `"9007199254740993"`→giữ chuỗi (tránh mất chính xác); `"+84"`,`"1e5"`,`"1.50"`→giữ chuỗi.
   - `"true"`/`"false"` → `boolean`.
   - còn lại → giữ `string`.
   - value **không phải string** (number/boolean/object từ JSON) → giữ nguyên.
3. `await this.c().db(database).collection(target.name).insertOne(doc)`.

`database = target.database ?? this.config.database`; thiếu → throw như các method khác.

## Xử lý lỗi

- Dòng lỗi (vd trùng `_id`) ném lỗi, `importTable` dừng — đồng nhất hành vi các DB khác. `ImportResult.count` báo số dòng đã nhập trước khi lỗi.

## Ngoài phạm vi (YAGNI)

- Không thêm UI mapping cột / chọn delimiter / map nested field. CSV phẳng → document phẳng.
- Không đổi import của SQL/Redis (coercion nằm trong `MongoAdapter.insertRow`).

## Nghiệm thu

- Import CSV có cột số/boolean/chuỗi/ô trống → document có kiểu đúng, field trống bị bỏ, số có 0 đầu và số lớn giữ nguyên chuỗi.
- Import JSON array (số thật) → giữ number.
- `npm run typecheck` sạch; kiểm thử end-to-end với MongoDB thật.
