# Design: Per-column filter (lọc theo giá trị từng cột)

**Date:** 2026-07-18
**Branch:** `feat/mongodb-document-edit`
**Status:** Approved

## Goal

Tại nhãn (header) của mỗi cột trong bảng "Dữ liệu", thêm một action filter. Bấm vào biểu tượng
filter mở một popup nhỏ ngay tại vị trí cột đó, cho phép lọc theo điều kiện WHERE của riêng cột:
`= != > >= < <= LIKE IS NULL IS NOT NULL`. Lọc thực hiện phía server (grid chỉ giữ 1 trang).

## Scope

- **SQL (PostgreSQL, MariaDB) + MongoDB.** Redis loại trừ: grid là key/type/ttl/value tổng hợp,
  vốn đã lọc bằng key pattern qua ô tìm kiếm.
- Nhiều filter cột + ô "Tìm trên toàn bảng" (`search`) kết hợp bằng **AND**.
- Mỗi cột một điều kiện tại một thời điểm.

Ngoài scope: OR giữa các cột, nhiều điều kiện trên cùng một cột, filter phía client, lọc Redis.

## Data model — `src/shared/types.ts`

```ts
export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'isNull' | 'isNotNull';

export interface ColumnFilter {
  column: string;
  op: FilterOp;
  /** Không dùng cho isNull/isNotNull. */
  value?: string;
}
```

Thêm vào `PageRequest`:

```ts
  /** Lọc theo từng cột (AND với nhau và với `search`). */
  filters?: ColumnFilter[];
```

`window.api.readRows` đã truyền nguyên `PageRequest` xuống adapter nên không cần đổi chữ ký IPC.

## Adapters

### SQL builder dùng chung — `src/main/adapters/sql-util.ts`

```ts
import type { ColumnFilter, FilterOp } from '@shared/types';

interface SqlFilterDialect {
  quote: (name: string) => string;      // quoteIdentPg / quoteIdentMysql
  textCast: (expr: string) => string;   // e => `CAST(${e} AS TEXT)` | `AS CHAR`
  likeOp: string;                        // 'ILIKE' | 'LIKE'
}

const SQL_CMP: Record<'eq'|'ne'|'gt'|'gte'|'lt'|'lte', string> = {
  eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
};

/**
 * Dựng các mệnh đề WHERE tham số hóa cho filter từng cột. `addParam(value)` đẩy giá trị vào
 * mảng params của caller và trả về placeholder (`$n` cho PG, `?` cho MySQL). Trả về mảng mệnh đề
 * (caller nối bằng AND). isNull/isNotNull không tạo param.
 */
export function buildColumnFilterClauses(
  filters: ColumnFilter[],
  d: SqlFilterDialect,
  addParam: (value: unknown) => string,
): string[] {
  const clauses: string[] = [];
  for (const f of filters) {
    const col = d.quote(f.column);
    if (f.op === 'isNull') { clauses.push(`${col} IS NULL`); continue; }
    if (f.op === 'isNotNull') { clauses.push(`${col} IS NOT NULL`); continue; }
    if (f.op === 'like') { clauses.push(`${d.textCast(col)} ${d.likeOp} ${addParam(`%${f.value ?? ''}%`)}`); continue; }
    clauses.push(`${col} ${SQL_CMP[f.op]} ${addParam(f.value)}`);
  }
  return clauses;
}
```

### `postgres.ts` / `mariadb.ts` — merge vào `readRows`

Cả hai đổi cách gom WHERE: dùng một `addParam` chung, gom nhóm search (nếu có) và các mệnh đề
filter, nối bằng `AND`.

- PG: `const params: unknown[] = []; const add = (v) => { params.push(v); return \`$${params.length}\`; };`
  dialect `{ quote: quoteIdentPg, textCast: e => \`CAST(${e} AS TEXT)\`, likeOp: 'ILIKE' }`.
- MariaDB: `add = (v) => { params.push(v); return '?'; };`
  dialect `{ quote: quoteIdentMysql, textCast: e => \`CAST(${e} AS CHAR)\`, likeOp: 'LIKE' }`.

Nhóm search hiện tại (`col ILIKE/LIKE ... OR ...`) được bọc trong `(...)` và cũng dùng `add` để
đánh số param nhất quán. `LIMIT/OFFSET` tiếp tục qua `add`. Count query dùng cùng `where` + params.
Giá trị vẫn tham số hóa; DB tự suy/ép kiểu (vd `int_col > $1` với '5').

### MongoDB — `src/main/adapters/mongo.ts`

Helper mới:

```ts
/** Coerce giá trị filter: số round-trip -> number, true/false -> boolean, còn lại giữ chuỗi. */
function coerceFilterValue(v: string | undefined): unknown {
  if (v === undefined) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  if (v !== '' && Number.isFinite(n) && String(n) === v) return n;
  return v;
}

/** Dựng fragment filter Mongo từ ColumnFilter[]; trả {} nếu rỗng. */
function buildColumnFilter(filters: ColumnFilter[]): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];
  for (const f of filters) {
    const col = f.column;
    // _id với eq/ne: dựng ObjectId nếu là hex 24 ký tự (dùng lại coerceImportedId).
    const raw = col === '_id' && (f.op === 'eq' || f.op === 'ne')
      ? coerceImportedId(f.value)
      : coerceFilterValue(f.value);
    switch (f.op) {
      case 'eq': clauses.push({ [col]: raw }); break;
      case 'ne': clauses.push({ [col]: { $ne: raw } }); break;
      case 'gt': clauses.push({ [col]: { $gt: raw } }); break;
      case 'gte': clauses.push({ [col]: { $gte: raw } }); break;
      case 'lt': clauses.push({ [col]: { $lt: raw } }); break;
      case 'lte': clauses.push({ [col]: { $lte: raw } }); break;
      case 'like':
        clauses.push({ [col]: { $regex: String(f.value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } });
        break;
      case 'isNull': clauses.push({ [col]: null }); break;
      case 'isNotNull': clauses.push({ [col]: { $ne: null } }); break;
    }
  }
  return clauses.length ? { $and: clauses } : {};
}
```

Trong `readRows`: nếu có `page.filters`, kết hợp với `filter` search hiện tại. Khi cả hai đều có:
`{ $and: [ searchFilter, ...columnClauses ] }`. Khi chỉ có filter cột: dùng `buildColumnFilter`.
Điều kiện `search ? countDocuments : estimatedCount` đổi thành: dùng `countDocuments(filter)` nếu
có search **hoặc** filter cột, ngược lại `estimatedDocumentCount`.

## UI

### `src/renderer/src/components/ColumnFilterHeader.tsx` (mới)

Custom header component cho ag-grid (thay header mặc định của các cột dữ liệu). Nhận props ag-grid
(`displayName`, `progressSort`, `column`, `api`) và `context`.

Render:
- Tên cột — bấm gọi `props.progressSort(e.shiftKey)` (giữ nguyên multi-sort server).
- Mũi tên sort — cập nhật theo `column` sự kiện `sortChanged` (subscribe trong effect).
- Biểu tượng filter (antd icon). Bọc trong antd `Popover` (`trigger="click"`), nội dung là form:
  `Select` toán tử (full set) + `Input` giá trị (disable khi isNull/isNotNull) + nút **Áp dụng**/**Xóa**.
- Icon được tô đậm (màu primary) khi cột đang có filter (đọc từ `context.getFilter(colName)`).

`context` truyền vào grid: `{ getFilter(col): ColumnFilter | undefined; setFilter(col, cond | null): void }`.
`getFilter` đọc từ `filtersRef.current` để luôn lấy trạng thái mới nhất.

### `src/renderer/src/components/DataGridView.tsx`

- State `filters: ColumnFilter[]` + `filtersRef` (đồng bộ để header đọc).
- `load` thêm `filters: filters.length ? filters : undefined`.
- `setFilter(col, cond)`: cập nhật/loại bỏ điều kiện của cột trong `filters` + ref, `setPage(1)`,
  reload, rồi `gridApiRef.current?.refreshHeader()` để vẽ lại icon active.
- Chỉ gắn `headerComponent: ColumnFilterHeader` cho cột dữ liệu khi DB hỗ trợ filter server —
  cờ mới `columnFilter` trong `Capabilities` (true cho postgres/mariadb/mongo, false cho redis).
  Cột checkbox không có filter header.
- `useEffect([load])` reset filter khi đổi bảng/collection (đặt `filters=[]`).

### `Capabilities` — cờ mới

Thêm `columnFilter: boolean` vào interface `Capabilities` (breaking cho cả 4 adapter — phải cập nhật
đủ 4: postgres/mariadb/mongo = true, redis = false).

## Testing

Repo **không có test framework**. Xác minh hai lớp:

1. **Cổng tự động:** `npm run typecheck` sạch (strict cả hai tsconfig).
2. **Kiểm thử hành vi headless** (theo [[headless-adapter-verification]]): drive `readRows` với
   `filters` qua esbuild bundle trên DB thật. Ca kiểm thử mỗi dialect:
   - `eq` số, `like` chuỗi (case-insensitive), `gt`/`lte` số, `isNull`/`isNotNull`.
   - Kết hợp 2 cột (AND) và filter cột + `search` (AND).
   - Mongo: `_id` `eq` với hex → khớp ObjectId đúng document.
   MongoDB thật: docker `cs-mongo:27017`. SQL: dùng instance sẵn có nếu kết nối được; nếu không,
   ghi rõ dialect nào chưa chạy được headless và dựa vào typecheck + kiểm thử `npm run dev`.
3. **UI:** kiểm thử `npm run dev` — bấm icon filter ở header, popup hiện tại cột, áp dụng/xóa,
   icon active, kết hợp nhiều cột.

## Backward compatibility

`filters` là tùy chọn; thiếu nó thì `readRows` chạy như cũ. Cờ `columnFilter` chỉ bật header mới,
không đổi luồng đọc dữ liệu hiện có.
