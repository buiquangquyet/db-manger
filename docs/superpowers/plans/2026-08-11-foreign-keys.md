# Foreign key trong StructureView — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hiển thị khóa ngoại của bảng trong tab Cấu hình, cho MariaDB và Postgres.

**Architecture:** Thêm `ForeignKeyInfo` vào `TableStructure` như trường **bắt buộc** để typecheck ép cả bốn adapter khai báo. Hai adapter SQL truy vấn metadata; phần gom nhiều dòng thành một FK là hàm thuần đặt trong `sql-util.ts`, kiểm bằng script esbuild. Renderer thêm một mục bảng dưới mục Index.

**Tech Stack:** Electron + React 18 + TypeScript, antd 5, `mysql2`, `pg`, esbuild (transitive qua vite).

**PRD:** `docs/superpowers/specs/2026-08-11-query-workflow-prd.md`, mục "Tính năng 3".

## Global Constraints

- Branch `feat/query-workflow`. Làm **trước** hai plan còn lại — plan này không đụng `QueryPanel.tsx`.
- Không thêm dependency. Không sửa `src/preload/**` (không có API mới; `getStructure` đã tồn tại).
- Gate mọi task: `npm run typecheck` + `npm run build`.
- `foreignKeys` là trường **bắt buộc** trên `TableStructure`, không optional. Mongo/Redis trả `[]` tường minh.
- Chuỗi UI tiếng Việt: tiêu đề mục `Khóa ngoại (N)`, empty text `Không có khóa ngoại`.
- Comment tiếng Việt, khớp văn phong file.
- Commit message kết thúc bằng `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

| File | Việc |
|---|---|
| `src/shared/types.ts` | `ForeignKeyInfo`; `TableStructure.foreignKeys` |
| `src/main/adapters/sql-util.ts` | `groupForeignKeys` (thuần) |
| `scripts/check-foreign-keys.ts` | **Mới** — kiểm `groupForeignKeys` |
| `package.json` | script `check:foreign-keys` |
| `src/main/adapters/mariadb.ts` | truy vấn FK trong `getStructure` |
| `src/main/adapters/postgres.ts` | truy vấn FK trong `getStructure` |
| `src/main/adapters/mongo.ts`, `redis.ts` | trả `foreignKeys: []` |
| `src/renderer/src/components/StructureView.tsx` | mục bảng FK |

---

### Task 1: Kiểu + hàm gom thuần + kiểm chứng

**Files:** `src/shared/types.ts`, `src/main/adapters/sql-util.ts`, `scripts/check-foreign-keys.ts`, `package.json`

**Interfaces produced:**
- `export interface ForeignKeyInfo { name: string; columns: string[]; refSchema?: string; refTable: string; refColumns: string[]; onDelete?: string; onUpdate?: string }`
- `export interface FkRow { name: string; column: string; refSchema?: string; refTable: string; refColumn: string; onDelete?: string; onUpdate?: string }`
- `export function groupForeignKeys(rows: FkRow[]): ForeignKeyInfo[]`

- [ ] **Step 1: Viết script kiểm chứng (fail vì hàm chưa tồn tại)**

Tạo `scripts/check-foreign-keys.ts`:

```ts
import assert from 'node:assert/strict';
import { groupForeignKeys } from '../src/main/adapters/sql-util';

// Thứ tự dòng vào = thứ tự cột trong khóa (adapter đã ORDER BY ordinal).
const rows = [
  { name: 'fk_order_customer', column: 'customer_id', refTable: 'customers', refColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { name: 'fk_item_pair', column: 'order_id', refTable: 'orders', refColumn: 'id' },
  { name: 'fk_item_pair', column: 'line_no', refTable: 'orders', refColumn: 'line_no' },
];

// Gom theo tên constraint, giữ nguyên thứ tự cột nguồn và cột đích
{
  const fks = groupForeignKeys(rows);
  assert.deepEqual(fks.map((f) => f.name), ['fk_order_customer', 'fk_item_pair']);
  assert.deepEqual(fks[1].columns, ['order_id', 'line_no']);
  assert.deepEqual(fks[1].refColumns, ['id', 'line_no']);
  assert.equal(fks[1].refTable, 'orders');
}

// Khóa đơn giữ được onDelete/onUpdate
{
  const fk = groupForeignKeys(rows)[0];
  assert.equal(fk.onDelete, 'CASCADE');
  assert.equal(fk.onUpdate, 'NO ACTION');
  assert.deepEqual(fk.columns, ['customer_id']);
}

// refSchema được giữ khi có (Postgres trỏ sang schema khác)
{
  const fks = groupForeignKeys([
    { name: 'fk_x', column: 'a', refSchema: 'other', refTable: 't', refColumn: 'id' },
  ]);
  assert.equal(fks[0].refSchema, 'other');
}

// Mảng rỗng -> mảng rỗng, không ném
{
  assert.deepEqual(groupForeignKeys([]), []);
}

// Không sửa mảng đầu vào
{
  const input = [{ name: 'fk_a', column: 'x', refTable: 't', refColumn: 'id' }];
  groupForeignKeys(input);
  assert.equal(input.length, 1);
  assert.equal(input[0].column, 'x');
}

console.log('OK: foreign-keys');
```

- [ ] **Step 2: Thêm npm script**

Trong `package.json`, ngay sau `check:tree-utils`:

```json
    "check:foreign-keys": "esbuild scripts/check-foreign-keys.ts --bundle --format=esm --platform=node --outfile=node_modules/.cache/check-foreign-keys.mjs && node node_modules/.cache/check-foreign-keys.mjs",
```

- [ ] **Step 3: Chạy để xác nhận fail**

Run: `npm run check:foreign-keys`
Expected: FAIL — esbuild báo không resolve được `groupForeignKeys`.

- [ ] **Step 4: Thêm kiểu vào `src/shared/types.ts`**

Ngay sau `export interface IndexInfo { ... }`:

```ts
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
```

Trong `TableStructure`, thêm sau `indexes`:

```ts
  /** Khóa ngoại; [] với loại DB không có khái niệm này (Mongo, Redis). */
  foreignKeys: ForeignKeyInfo[];
```

- [ ] **Step 5: Thêm `groupForeignKeys` vào `sql-util.ts`**

Đặt ngay sau `groupColumnsByTable`:

```ts
/** Một dòng metadata FK, mỗi cột trong khóa là một dòng. */
export interface FkRow {
  name: string;
  column: string;
  refSchema?: string;
  refTable: string;
  refColumn: string;
  onDelete?: string;
  onUpdate?: string;
}

/**
 * Gom các dòng metadata thành danh sách khóa ngoại.
 * Người gọi PHẢI truyền rows đã sắp theo thứ tự cột trong khóa (ORDER BY ordinal):
 * `columns[i]` và `refColumns[i]` khớp nhau theo chỉ số, sai thứ tự sẽ tạo ra cặp cột sai.
 */
export function groupForeignKeys(rows: FkRow[]): ForeignKeyInfo[] {
  const map = new Map<string, ForeignKeyInfo>();
  for (const r of rows) {
    const found = map.get(r.name);
    if (found) {
      found.columns.push(r.column);
      found.refColumns.push(r.refColumn);
    } else {
      map.set(r.name, {
        name: r.name,
        columns: [r.column],
        refSchema: r.refSchema,
        refTable: r.refTable,
        refColumns: [r.refColumn],
        onDelete: r.onDelete,
        onUpdate: r.onUpdate,
      });
    }
  }
  return [...map.values()];
}
```

Thêm `ForeignKeyInfo` vào dòng `import type { ColumnFilter, SchemaObject } from '@shared/types';` ở đầu file.

- [ ] **Step 6: Chạy lại kiểm chứng**

Run: `npm run check:foreign-keys`
Expected: PASS — in `OK: foreign-keys`

- [ ] **Step 7: Typecheck (kỳ vọng ĐỎ)**

Run: `npm run typecheck`
Expected: FAIL — bốn adapter chưa trả `foreignKeys`. Đây là dấu hiệu trường bắt buộc đang làm đúng việc của nó; Task 2 và 3 sẽ làm xanh lại.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/main/adapters/sql-util.ts scripts/check-foreign-keys.ts package.json
git commit -m "$(cat <<'EOF'
feat(fk): kiểu ForeignKeyInfo + groupForeignKeys kèm script kiểm chứng

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Truy vấn FK ở hai adapter SQL

**Files:** `src/main/adapters/mariadb.ts` (`getStructure`, dòng ~199-229), `src/main/adapters/postgres.ts` (`getStructure`, dòng ~190-235)

**Interfaces consumed:** `groupForeignKeys(rows: FkRow[]): ForeignKeyInfo[]` từ `./sql-util`.

- [ ] **Step 1: MariaDB**

Trong `getStructure`, ngay trước `return`, thêm:

```ts
    // KEY_COLUMN_USAGE cho cặp cột, REFERENTIAL_CONSTRAINTS cho quy tắc ON DELETE/UPDATE.
    // ORDER BY ordinal_position là bắt buộc: groupForeignKeys ghép cột nguồn với cột đích
    // theo thứ tự dòng.
    const [fks] = await this.db().query(
      `SELECT k.constraint_name, k.column_name, k.referenced_table_name, k.referenced_column_name,
              r.delete_rule, r.update_rule
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = ? AND k.table_name = ? AND k.referenced_table_name IS NOT NULL
       ORDER BY k.constraint_name, k.ordinal_position`,
      [db, target.name],
    );
    const foreignKeys = groupForeignKeys(
      (fks as Record<string, string>[]).map((r) => ({
        name: r.constraint_name,
        column: r.column_name,
        refTable: r.referenced_table_name,
        refColumn: r.referenced_column_name,
        onDelete: r.delete_rule || undefined,
        onUpdate: r.update_rule || undefined,
      })),
    );

    return { columns, indexes: [...byName.values()], foreignKeys };
```

Xóa dòng `return { columns, indexes: [...byName.values()] };` cũ. Thêm `groupForeignKeys` vào import từ `./sql-util`.

- [ ] **Step 2: Postgres**

Trong `getStructure`, trước `return`, thêm:

```ts
    // unnest(...) WITH ORDINALITY trên CẢ HAI mảng rồi join theo thứ tự: conkey[i] phải
    // ghép đúng confkey[i]. Ghép sai thứ tự tạo ra FK hiển thị nhầm cặp cột ở khóa phức
    // và không có cách nào phát hiện bằng mắt.
    const fkRes = await this.db().query(
      `SELECT con.conname AS name,
              src.attname AS column_name,
              fn.nspname  AS ref_schema,
              ft.relname  AS ref_table,
              tgt.attname AS ref_column,
              con.confdeltype AS del_type,
              con.confupdtype AS upd_type,
              k.ord
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class ft ON ft.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = ft.relnamespace
       JOIN LATERAL unnest(con.conkey)  WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
       JOIN pg_attribute src ON src.attrelid = t.oid  AND src.attnum = k.attnum
       JOIN pg_attribute tgt ON tgt.attrelid = ft.oid AND tgt.attnum = fk.attnum
       WHERE con.contype = 'f' AND n.nspname = $1 AND t.relname = $2
       ORDER BY con.conname, k.ord`,
      [schema, target.name],
    );
    const foreignKeys = groupForeignKeys(
      fkRes.rows.map((r: Record<string, string>) => ({
        name: r.name,
        column: r.column_name,
        refSchema: r.ref_schema !== schema ? r.ref_schema : undefined,
        refTable: r.ref_table,
        refColumn: r.ref_column,
        onDelete: fkAction(r.del_type),
        onUpdate: fkAction(r.upd_type),
      })),
    );
```

Sửa `return` để kèm `foreignKeys`. Thêm `groupForeignKeys` vào import từ `./sql-util`.

Thêm helper ở cuối file `postgres.ts` (ngoài class):

```ts
/** pg_constraint lưu quy tắc FK bằng một ký tự; đổi sang chữ cho dễ đọc. */
function fkAction(code?: string): string | undefined {
  switch (code) {
    case 'a': return 'NO ACTION';
    case 'r': return 'RESTRICT';
    case 'c': return 'CASCADE';
    case 'n': return 'SET NULL';
    case 'd': return 'SET DEFAULT';
    default: return undefined;
  }
}
```

- [ ] **Step 3: Mongo và Redis trả mảng rỗng**

`mongo.ts` (`getStructure`, ~dòng 230) và `redis.ts` (~dòng 136): thêm `foreignKeys: []` vào object trả về, kèm comment ngắn (`// Không có khái niệm khóa ngoại.`).

- [ ] **Step 4: Gate**

Run: `npm run typecheck && npm run check:foreign-keys`
Expected: cả hai PASS. Typecheck giờ phải xanh trở lại vì cả bốn adapter đã khai báo `foreignKeys`.

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/
git commit -m "$(cat <<'EOF'
feat(fk): đọc khóa ngoại ở MariaDB và Postgres, giữ đúng thứ tự cột khóa phức

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Hiển thị trong StructureView

**Files:** `src/renderer/src/components/StructureView.tsx`

- [ ] **Step 1: Định nghĩa cột bảng FK**

Cạnh `indexCols` sẵn có, thêm:

```tsx
  const fkCols: ColumnsType<ForeignKeyInfo> = [
    { title: 'Tên', dataIndex: 'name', key: 'name' },
    { title: 'Cột', key: 'columns', render: (_, r) => r.columns.join(', ') },
    {
      title: 'Tham chiếu',
      key: 'ref',
      render: (_, r) =>
        `${r.refSchema ? `${r.refSchema}.` : ''}${r.refTable} (${r.refColumns.join(', ')})`,
    },
    { title: 'ON DELETE', dataIndex: 'onDelete', key: 'onDelete', render: (v?: string) => v ?? '—' },
    { title: 'ON UPDATE', dataIndex: 'onUpdate', key: 'onUpdate', render: (v?: string) => v ?? '—' },
  ];
```

Thêm `ForeignKeyInfo` vào import type từ `@shared/types`.

- [ ] **Step 2: Thêm mục FK dưới mục Index**

Ngay sau `<Table ... dataSource={struct?.indexes ?? []} ... />` (kết thúc ở dòng ~207):

```tsx
        <Space style={{ margin: '24px 0 8px', width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Khóa ngoại ({struct?.foreignKeys.length ?? 0})
          </Typography.Title>
        </Space>
        <Table
          size="small"
          rowKey="name"
          pagination={false}
          columns={fkCols}
          dataSource={struct?.foreignKeys ?? []}
          bordered
          locale={{ emptyText: 'Không có khóa ngoại' }}
        />
```

Mục vẫn hiện với số 0 khi bảng không có FK — để phân biệt "không có FK" với "chưa tải xong".

- [ ] **Step 3: Gate**

Run: `npm run typecheck && npm run build`
Expected: cả hai PASS.

- [ ] **Step 4: Kiểm tay**

Run: `npm run dev`. Theo tiêu chí trong PRD mục "Foreign key":
1. Bảng MariaDB có FK khóa đơn → đúng bảng/cột đích và ON DELETE/UPDATE.
2. Bảng có **FK khóa phức nhiều cột** → thứ tự cột nguồn khớp đúng thứ tự cột đích. Đây là ca quan trọng nhất.
3. Bảng Postgres có FK trỏ sang schema khác → hiện kèm tên schema.
4. Bảng không có FK → `Khóa ngoại (0)`.
5. Collection Mongo / keyspace Redis → mục trống, không lỗi.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/StructureView.tsx
git commit -m "$(cat <<'EOF'
feat(fk): bảng khóa ngoại trong tab Cấu hình

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage (PRD mục "Tính năng 3"):** `ForeignKeyInfo` đủ 7 trường ✓; `foreignKeys` bắt buộc ✓; MariaDB `KEY_COLUMN_USAGE`+`REFERENTIAL_CONSTRAINTS` ✓; Postgres `pg_constraint` + `unnest ... WITH ORDINALITY` hai mảng join theo `ord` ✓; hàm gom thuần trong `sql-util.ts` + script esbuild ✓; UI dưới mục Index, hiện cả khi 0 ✓; Mongo/Redis trả `[]` ✓.

**Placeholder scan:** không TBD; mọi step có mã đầy đủ; script kiểm có assertion cụ thể.

**Type consistency:** `FkRow` (Task 1) khớp đúng object mà hai adapter dựng ở Task 2; `ForeignKeyInfo` dùng nhất quán ở Task 1/2/3; `groupForeignKeys` một chữ ký duy nhất.

**Điểm cố ý:** Task 1 kết thúc với typecheck ĐỎ. Đây là lựa chọn có chủ ý — trường bắt buộc phải làm vỡ build cho tới khi cả bốn adapter khai báo, và Step 7 nói rõ điều đó để người thực hiện không tưởng là mình làm hỏng. Nếu chia lại để mỗi task đều xanh thì phải để `foreignKeys` optional, mất đúng cái bảo đảm mà PRD muốn.
