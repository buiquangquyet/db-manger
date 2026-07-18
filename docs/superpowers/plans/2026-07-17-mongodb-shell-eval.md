# MongoDB Shell Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho ô "Mongo Shell" trong `QueryPanel` chạy được cú pháp mongosh thật (vd `db.terms.findOne({_id: ObjectId("...")})`), gồm cả chaining cursor và CRUD.

**Architecture:** Tách logic đánh giá vào module mới `mongo-shell.ts` dùng `vm` context hạn chế; `MongoAdapter.executeRaw` điều phối (JSON `runCommand` cũ vs biểu thức shell) rồi chuẩn hóa giá trị driver trả về thành `QueryResult`.

**Tech Stack:** Electron main + TypeScript + driver `mongodb` v6 (dùng `ObjectId`, namespace `BSON` cho các kiểu số/binary) + Node builtin `vm`.

## Global Constraints

- **Không có test framework** trong repo. Cổng kiểm tra tự động của mỗi task là `npm run typecheck` (phải sạch). Kiểm thử hành vi làm thủ công ở Task 3 bằng `npm run dev`.
- `strict: true` ở cả `tsconfig.node.json` và `tsconfig.web.json`.
- Không thêm dependency mới — chỉ dùng `mongodb` (đã có) và Node builtin.
- Các kiểu BSON số/binary lấy qua namespace `BSON` (vd `const { Long, Int32, Decimal128 } = BSON;`) theo đúng chú thích sẵn có ở `mongo.ts:2` (mongodb 6.x không export ổn định ở top-level cho một số kiểu).
- Mọi chuỗi UI/thông điệp bằng tiếng Việt, theo phong cách file hiện có.
- Import path alias: `@shared/types`.
- Giữ nguyên đường JSON `runCommand` cũ (đầu vào bắt đầu bằng `{`) để tương thích ngược.

---

### Task 1: Module `mongo-shell.ts` — đánh giá biểu thức shell trong `vm`

**Files:**
- Create: `src/main/adapters/mongo-shell.ts`

**Interfaces:**
- Produces:
  - `evalMongoShell(db: Db, expr: string): Promise<unknown>` — đánh giá một biểu thức shell, trả về giá trị thô của driver (cursor / document / result ghi / scalar). Chưa materialize cursor.

- [ ] **Step 1: Tạo file `src/main/adapters/mongo-shell.ts`**

```ts
import vm from 'node:vm';
import { ObjectId, BSON, type Db } from 'mongodb';

// Các kiểu số/binary lấy qua namespace BSON cho chắc chắn (mongodb 6.x — xem mongo.ts:2).
const { Long, Int32, Decimal128, Binary, Timestamp, UUID } = BSON;

/**
 * Đánh giá một biểu thức Mongo Shell (cú pháp mongosh) trên `db` đã kết nối và trả về
 * giá trị thô mà driver trả (cursor cho find/aggregate, Promise<document> cho findOne,
 * Promise<result> cho lệnh ghi, ...). KHÔNG materialize cursor — việc đó do executeRaw lo.
 *
 * BẢO MẬT: `vm` chỉ là *cô lập*, KHÔNG phải sandbox cứng — về lý thuyết vẫn có cách thoát.
 * Threat model chấp nhận được: đây là công cụ desktop chạy cục bộ do chính chủ DB vận hành;
 * người dùng vốn đã có toàn quyền truy cập DB và tự gõ query của mình. Context chỉ phơi bày
 * `db` + vài helper kiểu BSON; KHÔNG có require/process/global/module.
 */
export function evalMongoShell(db: Db, expr: string): Promise<unknown> {
  // Bỏ dấu ; ở cuối để bọc trong ngoặc không lỗi cú pháp.
  const clean = expr.trim().replace(/;+\s*$/, '');

  const sandbox: Record<string, unknown> = {
    db,
    // Dùng Date/RegExp của realm chính để instanceof phía driver hoạt động đúng.
    Date,
    RegExp,
    ObjectId: (v?: string) => (v === undefined ? new ObjectId() : new ObjectId(v)),
    ISODate: (v?: string) => (v === undefined ? new Date() : new Date(v)),
    NumberLong: (v: string | number) => Long.fromValue(v as never),
    NumberInt: (v: string | number) => new Int32(Number(v)),
    NumberDecimal: (v: string | number) => Decimal128.fromString(String(v)),
    UUID: (v?: string) => (v === undefined ? new UUID() : new UUID(v)),
    BinData: (subtype: number, base64: string) =>
      new Binary(Buffer.from(base64, 'base64'), subtype),
    Timestamp: (t: number, i: number) => new Timestamp({ t, i } as never),
  };

  const context = vm.createContext(sandbox);
  // Bọc trong async IIFE để await được kết quả bên trong biểu thức nếu cần.
  const script = new vm.Script(`(async () => (${clean}))()`, { filename: 'mongo-shell.js' });
  // timeout chỉ chặn phần đồng bộ (parse/tạo cursor); I/O DB có timeout riêng của driver.
  return script.runInContext(context, { timeout: 15000 }) as Promise<unknown>;
}
```

- [ ] **Step 2: Chạy typecheck**

Run: `npm run typecheck`
Expected: PASS (không lỗi). Nếu báo `Long`/`Int32`… không tồn tại trên `BSON`, kiểm tra lại tên kiểu trong `node_modules/mongodb` và điều chỉnh import cho khớp trước khi tiếp tục.

- [ ] **Step 3: Commit**

```bash
git add src/main/adapters/mongo-shell.ts
git commit -m "feat(mongo): module evalMongoShell chạy biểu thức shell trong vm"
```

---

### Task 2: `executeRaw` điều phối shell + chuẩn hóa kết quả

**Files:**
- Modify: `src/main/adapters/mongo.ts` (import; method `executeRaw` ở `mongo.ts:186-224`; thêm 2 helper cuối file cạnh `mongoType`)

**Interfaces:**
- Consumes: `evalMongoShell(db, expr)` từ Task 1.
- Produces (helper module-level trong `mongo.ts`):
  - `docsToRowSet(docs: unknown[]): RowSet`
  - `formatShellValue(value: unknown, durationMs: number): QueryResult`

- [ ] **Step 1: Thêm import `evalMongoShell`**

Trong `src/main/adapters/mongo.ts`, ngay dưới dòng `import { MongoClient, ObjectId, BSON } from 'mongodb';` (dòng 1):

```ts
import { evalMongoShell } from './mongo-shell';
```

- [ ] **Step 2: Thay toàn bộ thân method `executeRaw`**

Thay khối `mongo.ts:186-224` (JSDoc + method `executeRaw`) bằng:

```ts
  /**
   * Chạy ô Mongo Shell. Hai chế độ (nhánh không chồng lấn theo ký tự đầu):
   * - Bắt đầu bằng `{` → JSON `runCommand` (tương thích ngược), vd {"find":"users","limit":10}.
   * - Ngược lại → biểu thức mongosh, vd db.users.find({}).sort({_id:-1}).limit(10).
   */
  async executeRaw(query: string, database?: string): Promise<QueryResult> {
    const started = process.hrtime.bigint();
    const db = this.c().db(database ?? this.config.database);
    const trimmed = query.trim();

    // Chế độ JSON runCommand (giữ nguyên hành vi cũ).
    if (trimmed.startsWith('{')) {
      const command = JSON.parse(trimmed);
      const result = await db.command(command);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const batch: unknown[] | undefined = result?.cursor?.firstBatch;
      if (Array.isArray(batch)) {
        return { rowSet: docsToRowSet(batch), durationMs };
      }
      return { message: JSON.stringify(result), durationMs };
    }

    // Chế độ biểu thức shell.
    let value = await evalMongoShell(db, trimmed);
    // find/aggregate trả cursor — materialize thành mảng.
    if (value && typeof (value as { toArray?: unknown }).toArray === 'function') {
      value = await (value as { toArray(): Promise<unknown[]> }).toArray();
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    return formatShellValue(value, durationMs);
  }
```

- [ ] **Step 3: Thêm helper `docsToRowSet` và `formatShellValue` cuối file**

Trong `src/main/adapters/mongo.ts`, ngay trước hàm `mongoType` (khối `/** Đoán kiểu hiển thị… */`), thêm:

```ts
/** Dựng RowSet từ mảng document: hợp nhất key thành cột, ObjectId→hex, object lồng→JSON. */
function docsToRowSet(docs: unknown[]): RowSet {
  // Giá trị nguyên thủy (vd distinct) được bọc dưới cột "value".
  const objs = docs.map((d) =>
    d !== null && typeof d === 'object' && !Array.isArray(d)
      ? (d as Record<string, unknown>)
      : { value: d },
  );
  const colSet = new Set<string>();
  for (const d of objs) for (const k of Object.keys(d)) colSet.add(k);
  const columns = [...colSet].map((name) => ({ name, isPrimaryKey: name === '_id' }));
  const rows = objs.map((d) => {
    const out: Record<string, unknown> = {};
    for (const k of colSet) {
      const v = d[k];
      out[k] =
        v instanceof ObjectId
          ? v.toHexString()
          : v !== null && typeof v === 'object'
            ? JSON.stringify(v)
            : v;
    }
    return out;
  });
  return { columns, rows, total: rows.length };
}

/** Chuẩn hóa giá trị driver trả về (sau khi đã materialize cursor) thành QueryResult. */
function formatShellValue(value: unknown, durationMs: number): QueryResult {
  // Mảng document (find/aggregate/distinct) → bảng.
  if (Array.isArray(value)) return { rowSet: docsToRowSet(value), durationMs };

  // Kết quả lệnh ghi: mọi CRUD result đều có cờ `acknowledged`.
  if (value !== null && typeof value === 'object' && 'acknowledged' in value) {
    return { message: formatWriteResult(value as Record<string, unknown>), durationMs };
  }

  // findOne trả 1 document → bảng 1 dòng.
  if (value !== null && typeof value === 'object') {
    return { rowSet: docsToRowSet([value]), durationMs };
  }

  // null (findOne không khớp) hoặc scalar (countDocuments...) → thông điệp.
  return { message: value === null ? '(null)' : String(value), durationMs };
}

/** Tóm tắt kết quả lệnh ghi theo các field có mặt. */
function formatWriteResult(r: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof r.insertedCount === 'number') parts.push(`đã thêm ${r.insertedCount}`);
  if (r.insertedId != null) parts.push(`insertedId: ${String(r.insertedId)}`);
  if (typeof r.matchedCount === 'number') parts.push(`khớp ${r.matchedCount}`);
  if (typeof r.modifiedCount === 'number') parts.push(`sửa ${r.modifiedCount}`);
  if (typeof r.upsertedCount === 'number' && r.upsertedCount > 0)
    parts.push(`upsert ${r.upsertedCount}`);
  if (r.upsertedId != null) parts.push(`upsertedId: ${String(r.upsertedId)}`);
  if (typeof r.deletedCount === 'number') parts.push(`đã xóa ${r.deletedCount}`);
  return parts.length ? parts.join(', ') : JSON.stringify(r);
}
```

- [ ] **Step 4: Chạy typecheck**

Run: `npm run typecheck`
Expected: PASS. `RowSet` và `QueryResult` đã có sẵn trong danh sách import type ở đầu `mongo.ts` — không cần thêm.

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/mongo.ts
git commit -m "feat(mongo): executeRaw chạy biểu thức shell và chuẩn hóa kết quả"
```

---

### Task 3: Placeholder shell + kiểm thử hành vi thủ công

**Files:**
- Modify: `src/renderer/src/App.tsx:162-171` (hàm `queryPlaceholder`)

- [ ] **Step 1: Đổi placeholder nhánh document**

Trong `src/renderer/src/App.tsx`, sửa nhánh `case 'document':` (dòng 166-167):

```ts
    case 'document':
      return 'db.users.find({}).limit(10)';
```

- [ ] **Step 2: Chạy typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Kiểm thử hành vi thủ công**

Run: `npm run dev`

Kết nối tới một MongoDB, mở tab query (nhãn "Mongo Shell"), chạy lần lượt và xác nhận:

- [ ] `db.<col>.findOne({_id: ObjectId("<hex 24 ký tự có thật>")})` → hiện đúng 1 dòng document.
- [ ] `db.<col>.find({}).sort({_id: -1}).limit(5)` → tối đa 5 dòng, `_id` giảm dần.
- [ ] `db.<col>.aggregate([{$limit: 3}])` → 3 dòng.
- [ ] `db.<col>.countDocuments({})` → ô kết quả hiện một con số (message).
- [ ] `db.<col>.insertOne({_probe: 1})` → message có `insertedId: ...`.
- [ ] `db.<col>.deleteOne({_probe: 1})` → message `đã xóa 1`.
- [ ] `{"find":"<col>","limit":1}` → vẫn chạy (đường JSON cũ), hiện 1 dòng.
- [ ] `process` → báo lỗi gọn trên UI (message.error), app KHÔNG crash.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(ui): placeholder Mongo Shell dùng cú pháp db.<col>.find()"
```

---

## Ghi chú giới hạn đã biết

- `vm` là cô lập, không phải sandbox bảo mật cứng (đã nêu ở Task 1) — chấp nhận theo threat model công cụ desktop cục bộ.
- Chỉ chạy **một biểu thức** mỗi lần; không hỗ trợ nhiều statement, khai báo biến, `use <db>`, `show collections`.
- `new Date()` do người dùng gõ dùng `Date` của realm chính (đã inject) nên `instanceof Date` phía driver đúng; các literal object/array luôn an toàn cross-realm.
