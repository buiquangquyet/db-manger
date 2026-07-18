# Per-Column Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm action filter tại header mỗi cột của bảng Dữ liệu; bấm mở popup tại cột cho phép lọc WHERE theo cột (`= != > >= < <= LIKE IS NULL IS NOT NULL`), lọc phía server, AND với nhau và với ô tìm kiếm toàn bảng.

**Architecture:** Thêm `ColumnFilter[]` vào `PageRequest`; SQL (PG/Maria) dựng WHERE tham số hóa qua một builder dùng chung trong `sql-util.ts`; MongoDB dựng fragment `$and`. UI dùng custom header ag-grid (`ColumnFilterHeader`) với antd `Popover` neo tại icon filter; `DataGridView` giữ state filter và reload server.

**Tech Stack:** Electron + React + TypeScript + Ant Design (`Popover`/`Select`/`Input`) + ag-grid (custom `headerComponent`) + driver `pg`/`mysql2`/`mongodb`.

## Global Constraints

- **Không có test framework.** Cổng tự động mỗi task = `npm run typecheck` (sạch). Kiểm thử hành vi: headless theo `[[headless-adapter-verification]]` (Mongo dùng docker `cs-mongo:27017`; SQL nếu kết nối được, nếu không ghi rõ và dựa `npm run dev`) + `npm run dev` cho UI.
- `strict: true` ở cả hai tsconfig. Không thêm dependency mới.
- Mọi chuỗi UI/thông điệp tiếng Việt, theo phong cách file hiện có.
- Import alias `@shared/types`.
- Thêm field `columnFilter` vào `Capabilities` là **breaking** cho cả 4 adapter — phải cập nhật đủ 4 ở Task 1 để typecheck xanh (postgres/mariadb/mongo = `true`, redis = `false`).
- Filter tham số hóa tuyệt đối — không nội suy giá trị vào chuỗi SQL.
- `filters` là tùy chọn trong `PageRequest`; thiếu nó thì `readRows` chạy như cũ (tương thích ngược).

---

### Task 1: Shared types + cờ `Capabilities.columnFilter`

**Files:**
- Modify: `src/shared/types.ts` (Capabilities interface 56-73; PageRequest 111-118; thêm type filter)
- Modify: `src/main/adapters/postgres.ts:29`, `src/main/adapters/mariadb.ts:29`, `src/main/adapters/mongo.ts:33`, `src/main/adapters/redis.ts:26` (capabilities)

**Interfaces:**
- Produces:
  - `type FilterOp = 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'like'|'isNull'|'isNotNull'`
  - `interface ColumnFilter { column: string; op: FilterOp; value?: string }`
  - `PageRequest.filters?: ColumnFilter[]`
  - `Capabilities.columnFilter: boolean`

- [ ] **Step 1: Thêm cờ `columnFilter` vào interface `Capabilities`**

Trong `src/shared/types.ts`, ngay sau dòng `manageObjects: boolean;` (dòng 72), trước `}`:

```ts
  /** Cho phép tạo/xóa/đổi tên bảng & xóa database. */
  manageObjects: boolean;
  /** Cho phép lọc theo giá trị từng cột ở header bảng dữ liệu. */
  columnFilter: boolean;
```

- [ ] **Step 2: Thêm type `FilterOp` + `ColumnFilter` và field `filters`**

Trong `src/shared/types.ts`, thay khối `interface PageRequest` (111-118) bằng:

```ts
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
```

- [ ] **Step 3: Bật `columnFilter` ở 3 adapter SQL/Mongo, tắt ở Redis**

Thêm `columnFilter: true,` ngay sau dòng `manageObjects: true,` trong **postgres.ts:29**, **mariadb.ts:29**, **mongo.ts:33**. Thêm `columnFilter: false,` ngay sau `manageObjects: false,` trong **redis.ts:26**.

Ví dụ (postgres.ts):
```ts
    manageObjects: true,
    columnFilter: true,
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (Nếu báo thiếu `columnFilter` ở adapter nào → chưa cập nhật đủ 4; bổ sung.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/adapters/postgres.ts src/main/adapters/mariadb.ts src/main/adapters/mongo.ts src/main/adapters/redis.ts
git commit -m "feat(types): ColumnFilter + PageRequest.filters + cờ capabilities columnFilter"
```

---

### Task 2: SQL — builder dùng chung + tích hợp Postgres & MariaDB

**Files:**
- Modify: `src/main/adapters/sql-util.ts` (thêm builder)
- Modify: `src/main/adapters/postgres.ts` (`readRows`, hiện 133-171)
- Modify: `src/main/adapters/mariadb.ts` (`readRows`, hiện 143-...)

**Interfaces:**
- Consumes: `ColumnFilter`, `FilterOp` (Task 1).
- Produces: `buildColumnFilterClauses(filters, dialect, addParam): string[]` trong `sql-util.ts`.

- [ ] **Step 1: Thêm builder vào `sql-util.ts`**

Ở cuối `src/main/adapters/sql-util.ts`, thêm:

```ts
import type { ColumnFilter } from '@shared/types';

interface SqlFilterDialect {
  /** escape identifier (quoteIdentPg / quoteIdentMysql). */
  quote: (name: string) => string;
  /** ép biểu thức về text để LIKE (PG: AS TEXT, MySQL: AS CHAR). */
  textCast: (expr: string) => string;
  /** toán tử LIKE không phân biệt hoa/thường (PG: ILIKE, MySQL: LIKE). */
  likeOp: string;
}

const SQL_CMP: Record<'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte', string> = {
  eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
};

/**
 * Dựng các mệnh đề WHERE tham số hóa cho filter từng cột. `addParam(value)` đẩy giá trị vào mảng
 * params của caller và trả về placeholder (`$n` cho PG, `?` cho MySQL). Trả về mảng mệnh đề để
 * caller nối bằng AND. isNull/isNotNull không tạo param. Giá trị luôn tham số hóa (không nội suy).
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
    if (f.op === 'like') {
      clauses.push(`${d.textCast(col)} ${d.likeOp} ${addParam(`%${f.value ?? ''}%`)}`);
      continue;
    }
    clauses.push(`${col} ${SQL_CMP[f.op]} ${addParam(f.value)}`);
  }
  return clauses;
}
```

- [ ] **Step 2: Tích hợp vào `postgres.ts` `readRows`**

Trong `postgres.ts` `readRows`, thay khối từ dòng `const order =` đến hết câu `const res = await this.db().query(...)` (kết thúc bằng `[...whereParams, page.limit, page.offset]`) bằng phiên bản dùng `addParam` chung. Giữ nguyên các dòng `schema`/`qualified` ở trên và khối `const pks` + `return {...}` ở dưới:

```ts
    const order =
      page.orderBy && page.orderBy.length
        ? ' ORDER BY ' +
          page.orderBy.map((o) => `${quoteIdentPg(o.column)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
        : '';

    // Param dùng chung cho search + filter; PG đánh số $1,$2,...
    const params: unknown[] = [];
    const add = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    const groups: string[] = [];
    const search = page.search?.trim();
    if (search) {
      const cols = await this.columnNames(schema, target.name);
      if (cols.length) {
        groups.push(
          '(' + cols.map((c) => `CAST(${quoteIdentPg(c)} AS TEXT) ILIKE ${add(`%${search}%`)}`).join(' OR ') + ')',
        );
      }
    }
    groups.push(
      ...buildColumnFilterClauses(page.filters ?? [], {
        quote: quoteIdentPg,
        textCast: (e) => `CAST(${e} AS TEXT)`,
        likeOp: 'ILIKE',
      }, add),
    );
    const where = groups.length ? ' WHERE ' + groups.join(' AND ') : '';

    const countRes = await this.db().query(`SELECT COUNT(*)::int AS c FROM ${qualified}${where}`, params);
    const total = countRes.rows[0]?.c ?? 0;

    const res = await this.db().query(
      `SELECT * FROM ${qualified}${where}${order} LIMIT ${add(page.limit)} OFFSET ${add(page.offset)}`,
      params,
    );
```

Thêm import ở đầu file: `import { quoteIdentPg, buildColumnFilterClauses } from './sql-util';` (nếu file đang import `quoteIdentPg` riêng, gộp thêm `buildColumnFilterClauses` vào cùng dòng import từ `./sql-util`).

- [ ] **Step 3: Tích hợp vào `mariadb.ts` `readRows`**

Thay khối tương ứng (từ `const order =` đến câu SELECT `[...whereParams, page.limit, page.offset]`) bằng:

```ts
    const order =
      page.orderBy && page.orderBy.length
        ? ' ORDER BY ' +
          page.orderBy.map((o) => `${quoteIdentMysql(o.column)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
        : '';

    const params: unknown[] = [];
    const add = (v: unknown): string => {
      params.push(v);
      return '?';
    };

    const groups: string[] = [];
    const search = page.search?.trim();
    if (search) {
      const cols = await this.columnNames(db, target.name);
      if (cols.length) {
        groups.push(
          '(' + cols.map((c) => `CAST(${quoteIdentMysql(c)} AS CHAR) LIKE ${add(`%${search}%`)}`).join(' OR ') + ')',
        );
      }
    }
    groups.push(
      ...buildColumnFilterClauses(page.filters ?? [], {
        quote: quoteIdentMysql,
        textCast: (e) => `CAST(${e} AS CHAR)`,
        likeOp: 'LIKE',
      }, add),
    );
    const where = groups.length ? ' WHERE ' + groups.join(' AND ') : '';

    const [countRows] = await this.db().query(`SELECT COUNT(*) AS c FROM ${qualified}${where}`, params);
    const total = Number((countRows as { c: number }[])[0]?.c ?? 0);

    const [rows, fields] = await this.db().query(
      `SELECT * FROM ${qualified}${where}${order} LIMIT ${add(page.limit)} OFFSET ${add(page.offset)}`,
      params,
    );
```

Thêm `buildColumnFilterClauses` vào import từ `./sql-util` ở đầu file.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Headless verify (nếu có DB SQL kết nối được)**

Viết harness bundle theo `[[headless-adapter-verification]]` cho một trong hai adapter nếu có DB thật (esbuild `--packages=external`, output .mjs vào repo dir). Ca: tạo bảng tạm, chèn vài dòng, gọi `readRows` với `filters` (`eq` số, `like`, `gt`, `isNull`) + kết hợp search. Nếu **không** có DB SQL kết nối được, ghi rõ trong report là "SQL headless skipped — no reachable instance", dựa vào typecheck ở đây và `npm run dev` ở Task 5.

- [ ] **Step 6: Commit**

```bash
git add src/main/adapters/sql-util.ts src/main/adapters/postgres.ts src/main/adapters/mariadb.ts
git commit -m "feat(sql): lọc theo cột (WHERE tham số hóa) cho Postgres & MariaDB"
```

---

### Task 3: MongoDB — lọc theo cột trong `readRows`

**Files:**
- Modify: `src/main/adapters/mongo.ts` (`readRows` filter region 141-151; thêm 2 helper cạnh `coerceImportedId`/`mongoType`)

**Interfaces:**
- Consumes: `ColumnFilter` (Task 1), `coerceImportedId` (đã có trong file).
- Produces (module-level): `coerceFilterValue(v)`, `buildColumnFilter(filters): Record<string, unknown>`.

- [ ] **Step 1: Thêm 2 helper vào `mongo.ts`**

Ngay trước hàm `coerceImportedId` (hoặc giữa `coerceCsvValue` và `coerceImportedId`), thêm:

```ts
/** Coerce giá trị filter: số round-trip -> number, "true"/"false" -> boolean, còn lại giữ chuỗi. */
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
    const raw =
      col === '_id' && (f.op === 'eq' || f.op === 'ne')
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
        clauses.push({
          [col]: { $regex: String(f.value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
        });
        break;
      case 'isNull': clauses.push({ [col]: null }); break;
      case 'isNotNull': clauses.push({ [col]: { $ne: null } }); break;
    }
  }
  return clauses.length ? { $and: clauses } : {};
}
```

Đảm bảo `ColumnFilter` có trong danh sách import type từ `@shared/types` ở đầu file (thêm nếu thiếu).

- [ ] **Step 2: Tích hợp vào `readRows` (mongo.ts 141-151)**

Thay khối:
```ts
    let filter: Record<string, unknown> = {};
    const search = page.search?.trim();
    if (search) {
      const sample = await col.findOne({});
      const keys = sample ? Object.keys(sample) : [];
      const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      if (keys.length) filter = { $or: keys.map((k) => ({ [k]: rx })) };
    }

    // Có filter thì đếm chính xác; không thì dùng ước lượng (nhanh).
    const total = search ? await col.countDocuments(filter) : await col.estimatedDocumentCount();
```
bằng:
```ts
    // Search toàn bảng (regex mọi field lấy mẫu).
    let searchFilter: Record<string, unknown> | null = null;
    const search = page.search?.trim();
    if (search) {
      const sample = await col.findOne({});
      const keys = sample ? Object.keys(sample) : [];
      const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      if (keys.length) searchFilter = { $or: keys.map((k) => ({ [k]: rx })) };
    }
    // Lọc theo cột (AND). Kết hợp với search bằng $and khi cả hai đều có.
    const colFilter = buildColumnFilter(page.filters ?? []);
    const hasColFilter = Object.keys(colFilter).length > 0;
    const filter: Record<string, unknown> =
      searchFilter && hasColFilter
        ? { $and: [searchFilter, colFilter] }
        : searchFilter ?? colFilter;

    // Có điều kiện (search hoặc filter cột) thì đếm chính xác; không thì ước lượng (nhanh).
    const total =
      search || hasColFilter ? await col.countDocuments(filter) : await col.estimatedDocumentCount();
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Headless verify trên MongoDB thật**

Viết harness `verify-colfilter-mongo.ts` theo `[[headless-adapter-verification]]` (bundle esbuild `--packages=external`, output .mjs **vào repo dir** rồi `node`, dọn db sau). Kết nối `127.0.0.1:27017` db tạm `__colfilter_verify`. Seed vài document (gồm 1 có `_id` ObjectId biết trước, field số + chuỗi + null). Assert:
- `eq` số, `gt`/`lte` số, `like` chuỗi (case-insensitive), `ne`.
- `isNull` (field thiếu/null) và `isNotNull`.
- `_id` `eq` với hex 24 ký tự → đúng 1 document.
- 2 cột kết hợp AND; filter cột + `search` kết hợp AND.
In `N passed, M failed`, exit != 0 nếu có fail.

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/mongo.ts
git commit -m "feat(mongo): lọc theo cột trong readRows (AND với search)"
```

---

### Task 4: Component `ColumnFilterHeader`

**Files:**
- Create: `src/renderer/src/components/ColumnFilterHeader.tsx`

**Interfaces:**
- Consumes: `ColumnFilter`, `FilterOp` (Task 1).
- Produces:
  - `interface FilterHeaderContext { getFilter(col: string): ColumnFilter | undefined; setFilter(col: string, cond: ColumnFilter | null): void }`
  - `function ColumnFilterHeader(props: IHeaderParams)` — custom header ag-grid.

- [ ] **Step 1: Tạo file `src/renderer/src/components/ColumnFilterHeader.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { IHeaderParams } from 'ag-grid-community';
import { Button, Input, Popover, Select, Space } from 'antd';
import { CaretDownOutlined, CaretUpOutlined, FilterFilled, FilterOutlined } from '@ant-design/icons';
import type { ColumnFilter, FilterOp } from '@shared/types';

/** Callback cầu nối giữa header (ag-grid) và state filter của DataGridView. */
export interface FilterHeaderContext {
  getFilter: (col: string) => ColumnFilter | undefined;
  setFilter: (col: string, cond: ColumnFilter | null) => void;
}

const OPS: { value: FilterOp; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '!=' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'like', label: 'LIKE' },
  { value: 'isNull', label: 'IS NULL' },
  { value: 'isNotNull', label: 'IS NOT NULL' },
];
const NO_VALUE: FilterOp[] = ['isNull', 'isNotNull'];

export function ColumnFilterHeader(props: IHeaderParams) {
  const ctx = props.context as FilterHeaderContext;
  const col = props.column.getColId();
  const existing = ctx.getFilter(col);
  const active = !!existing;

  // Mũi tên sort đồng bộ theo trạng thái cột.
  const [sort, setSort] = useState<string | null | undefined>(props.column.getSort());
  useEffect(() => {
    const onSort = () => setSort(props.column.getSort());
    props.column.addEventListener('sortChanged', onSort);
    return () => props.column.removeEventListener('sortChanged', onSort);
  }, [props.column]);

  const [open, setOpen] = useState(false);
  const [op, setOp] = useState<FilterOp>(existing?.op ?? 'eq');
  const [value, setValue] = useState<string>(existing?.value ?? '');

  // Nạp lại form theo filter hiện có mỗi lần mở popup.
  useEffect(() => {
    if (!open) return;
    const cur = ctx.getFilter(col);
    setOp(cur?.op ?? 'eq');
    setValue(cur?.value ?? '');
  }, [open, col, ctx]);

  const apply = () => {
    const cond: ColumnFilter = NO_VALUE.includes(op)
      ? { column: col, op }
      : { column: col, op, value };
    ctx.setFilter(col, cond);
    setOpen(false);
  };
  const clear = () => {
    ctx.setFilter(col, null);
    setOpen(false);
  };

  const form = (
    <Space direction="vertical" style={{ width: 230 }} onClick={(e) => e.stopPropagation()}>
      <Space.Compact style={{ width: '100%' }}>
        <Select size="small" value={op} options={OPS} style={{ width: 110 }} onChange={(v) => setOp(v)} />
        <Input
          size="small"
          placeholder="giá trị"
          value={value}
          disabled={NO_VALUE.includes(op)}
          onChange={(e) => setValue(e.target.value)}
          onPressEnter={apply}
          allowClear
        />
      </Space.Compact>
      <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
        <Button size="small" onClick={clear} disabled={!active}>Xóa</Button>
        <Button size="small" type="primary" onClick={apply}>Áp dụng</Button>
      </Space>
    </Space>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 4 }}>
      <span
        style={{ flex: 1, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={props.displayName}
        onClick={(e) => props.progressSort(e.shiftKey)}
      >
        {props.displayName}
      </span>
      {sort === 'asc' && <CaretUpOutlined style={{ fontSize: 10 }} />}
      {sort === 'desc' && <CaretDownOutlined style={{ fontSize: 10 }} />}
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomRight"
        destroyTooltipOnHide
        content={form}
      >
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', cursor: 'pointer' }}>
          {active ? <FilterFilled style={{ color: '#1677ff' }} /> : <FilterOutlined style={{ color: '#999' }} />}
        </span>
      </Popover>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (Nếu `IHeaderParams` báo generic thiếu tham số, dùng `IHeaderParams<Record<string, unknown>>`.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/ColumnFilterHeader.tsx
git commit -m "feat(ui): ColumnFilterHeader — icon filter + popover toán tử/giá trị"
```

---

### Task 5: Nối `DataGridView` + `App.tsx` + kiểm thử `npm run dev`

**Files:**
- Modify: `src/renderer/src/components/DataGridView.tsx`
- Modify: `src/renderer/src/App.tsx:97-103` (truyền prop `columnFilter`)

**Interfaces:**
- Consumes: `ColumnFilterHeader`, `FilterHeaderContext` (Task 4); `ColumnFilter` (Task 1); `Capabilities.columnFilter` (Task 1).

- [ ] **Step 1: Import + prop mới trong `DataGridView.tsx`**

Thêm import:
```ts
import { ColumnFilterHeader, type FilterHeaderContext } from './ColumnFilterHeader';
import type { ColumnFilter, DataTarget, IoFormat, RowSet } from '@shared/types';
```
(gộp `ColumnFilter` vào dòng import type `@shared/types` sẵn có thay vì thêm dòng mới.)

Trong `interface Props`, thêm sau `documentEdit`:
```ts
  /** Loại DB dùng luồng document JSON (MongoDB) hay không. */
  documentEdit: boolean;
  /** Loại DB hỗ trợ lọc theo cột ở header hay không. */
  columnFilter: boolean;
```
Và nhận trong tham số: `export function DataGridView({ connectionId, target, inlineEdit, documentEdit, columnFilter }: Props) {`

- [ ] **Step 2: State + ref + getFilter/setFilter + context**

Ngay sau dòng `const [search, setSearch] = useState('');` thêm:
```ts
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const filtersRef = useRef<ColumnFilter[]>([]);
  filtersRef.current = filters;
```

Trong `load` (useCallback), thêm `filters` vào payload đọc từ ref (KHÔNG thêm `filters` state vào deps — đọc qua ref để tránh stale/loop):
```ts
        const rs = await window.api.readRows(connectionId, target, {
          offset: (p - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
          orderBy: orderBy.length ? orderBy : undefined,
          search: search || undefined,
          filters: filtersRef.current.length ? filtersRef.current : undefined,
        });
```

Sau `load`, thêm getFilter/setFilter/context (đặt trước `useEffect([load])`):
```ts
  const getFilter = useCallback((c: string) => filtersRef.current.find((f) => f.column === c), []);
  const setFilter = useCallback(
    (c: string, cond: ColumnFilter | null) => {
      const next = filtersRef.current.filter((f) => f.column !== c);
      if (cond) next.push(cond);
      filtersRef.current = next;
      setFilters(next);
      setPage(1);
      void load(1);
      gridApiRef.current?.refreshHeader();
    },
    [load],
  );
  const filterContext = useMemo<FilterHeaderContext>(() => ({ getFilter, setFilter }), [getFilter, setFilter]);
```

- [ ] **Step 3: Reset filter khi đổi bảng/collection**

Sửa effect reset (hiện `useEffect(() => { setPage(1); void load(1); }, [load])`). Thêm một effect RIÊNG chạy khi đổi `target`, đặt NGAY TRƯỚC effect `[load]`:
```ts
  // Xóa filter khi chuyển bảng/collection (tránh áp filter của bảng cũ).
  useEffect(() => {
    filtersRef.current = [];
    setFilters([]);
  }, [target]);
```
(Effect `[load]` giữ nguyên; đổi `target` làm `load` đổi identity → tự reload với filter rỗng.)

- [ ] **Step 4: Gắn `headerComponent` cho cột dữ liệu + truyền `context`**

Trong `columnDefs` useMemo, thêm `headerComponent` cho cột dữ liệu khi `columnFilter` bật. Sửa phần map cột dữ liệu:
```ts
    const cols: ColDef[] = (rowSet?.columns ?? []).map((c) => ({
      field: c.name,
      headerName: c.isPrimaryKey ? `🔑 ${c.name}` : c.name,
      sortable: true,
      resizable: true,
      editable: canInlineEdit && !c.isPrimaryKey,
      ...(columnFilter ? { headerComponent: ColumnFilterHeader } : {}),
      valueFormatter: (p) =>
        p.value === null || p.value === undefined ? '' : typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value),
    }));
```
Thêm `columnFilter` vào mảng deps của useMemo này: `}, [rowSet?.columns, canInlineEdit, canDelete, columnFilter]);`

Trên `<AgGridReact ...>`, thêm prop `context={filterContext}` (vd ngay sau `columnDefs={columnDefs}`).

- [ ] **Step 5: Truyền prop trong `App.tsx`**

Trong `src/renderer/src/App.tsx`, thêm dòng sau `documentEdit={session.capabilities.documentEdit}` (dòng 102):
```tsx
              documentEdit={session.capabilities.documentEdit}
              columnFilter={session.capabilities.columnFilter}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Kiểm thử `npm run dev`**

Run: `npm run dev`. Kết nối một DB (Mongo `cs-mongo` hoặc SQL nếu có), mở tab Dữ liệu một bảng/collection nhiều dòng, xác nhận:
- [ ] Header mỗi cột có icon filter; bấm → popup hiện **ngay tại cột** đó.
- [ ] Chọn `=` + giá trị → Áp dụng → grid chỉ còn dòng khớp; icon cột tô xanh (active).
- [ ] `LIKE` một chuỗi con → khớp không phân biệt hoa/thường.
- [ ] `>`/`<` trên cột số → so sánh đúng theo số.
- [ ] `IS NULL`/`IS NOT NULL` → ô giá trị bị disable; lọc đúng.
- [ ] Lọc 2 cột đồng thời → AND; kết hợp ô "Tìm trên toàn bảng" → vẫn AND.
- [ ] Bấm **Xóa** trên một cột → chỉ bỏ filter cột đó; icon trở lại xám.
- [ ] Bấm tên cột vẫn sort được (mũi tên hiện đúng).
- [ ] Đổi sang bảng khác → filter reset (không còn active).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/DataGridView.tsx src/renderer/src/App.tsx
git commit -m "feat(ui): nối per-column filter vào DataGridView (server reload + reset theo bảng)"
```

---

## Ghi chú giới hạn đã biết

- Giá trị lệch kiểu (vd nhập chữ vào `>` cột số ở SQL) sẽ để DB báo lỗi, hiển thị qua `message.error` sẵn có.
- Mỗi cột một điều kiện tại một thời điểm; không hỗ trợ OR giữa các cột hay nhiều điều kiện cùng cột (ngoài scope).
- Redis không có filter cột (grid tổng hợp; lọc bằng key pattern qua ô tìm kiếm).
