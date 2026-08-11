# Tìm tên bảng + Làm mới dữ liệu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm ô lọc theo tên bảng ở Sidebar và DatabaseOverview, thêm nút làm mới dữ liệu ở DataGridView.

**Architecture:** Toàn bộ nằm trong renderer, không thêm IPC/adapter. Logic lọc cây được tách ra module thuần `lib/tree-utils.ts` (kèm 3 tiện ích cây đang nằm cuối `Sidebar.tsx`) để kiểm chứng độc lập bằng script node; ba component chỉ nối UI vào. Nút làm mới tái dùng `load(page)` sẵn có nên giữ nguyên page/sort/search/filter.

**Tech Stack:** Electron + React 18 + TypeScript, antd 5, ag-grid-community 32, esbuild (có sẵn trong `node_modules/.bin` do vite kéo về — dùng gián tiếp, không khai báo thành dependency).

**Spec:** `docs/superpowers/specs/2026-08-11-table-search-refresh-design.md`

## Global Constraints

- Branch làm việc: `feat/table-search-refresh` (đã tạo, spec đã commit `ee5378d`).
- Không sửa `src/main/**`, `src/preload/**`, `src/shared/types.ts`. Không thêm dependency mới.
- Repo **không có test framework**. Kiểm chứng tự động chỉ áp dụng cho hàm thuần, chạy qua esbuild + node. Phần React kiểm bằng `npm run typecheck` + kiểm tra tay trong `npm run dev`.
- Cổng typecheck cho mọi task: `npm run typecheck` (chạy cả `typecheck:node` và `typecheck:web`) phải sạch.
- Chuỗi hiển thị bằng tiếng Việt, thống nhất với UI hiện có. Chuỗi chính xác:
  - Sidebar placeholder: `Lọc trong cây đang mở…`
  - Sidebar rỗng do lọc: `Không có node nào khớp`
  - Overview placeholder: `Tìm tên bảng…`
  - Overview rỗng do lọc: `Không có bảng nào khớp`
  - Nút làm mới DataGridView: `Tải lại`
- So khớp tên: `toLowerCase()` hai vế + `includes`. Không xử lý dấu tiếng Việt.
- Commit message tiếng Việt, prefix `feat(ui):` / `refactor(ui):`, kết thúc bằng dòng `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

| File | Trách nhiệm |
|---|---|
| `src/renderer/src/lib/tree-utils.ts` | **Mới.** Thao tác trên cây node dạng `{key, title, children?}`: tìm, chèn con, lọc. Thuần, không import React/antd. |
| `scripts/check-tree-utils.ts` | **Mới.** Script kiểm chứng `tree-utils.ts`, chạy bằng node sau khi bundle esbuild. Không nằm trong tsconfig nào nên không ảnh hưởng `npm run typecheck`. |
| `src/renderer/src/components/Sidebar.tsx` | Chỉ còn UI cây: ô lọc, expand có kiểm soát, highlight, menu chuột phải. Bỏ 3 hàm tiện ích ở cuối file. |
| `src/renderer/src/components/DatabaseOverview.tsx` | Thêm ô tìm tên bảng + nhãn đếm + trạng thái rỗng khi lọc. |
| `src/renderer/src/components/DataGridView.tsx` | Thêm nút `Tải lại`. |
| `src/renderer/src/styles.css` | Hàng chứa ô lọc trong sidebar. |
| `package.json` | Thêm script `check:tree-utils`. |

---

### Task 1: Module `tree-utils` + kiểm chứng

Tách 3 tiện ích cây khỏi `Sidebar.tsx` sang module mới và thêm `filterTree`. Kết thúc task: app chạy y hệt như trước (thuần refactor), `filterTree` đã có nhưng chưa ai dùng, và có script kiểm chứng chạy được.

**Files:**
- Create: `src/renderer/src/lib/tree-utils.ts`
- Create: `scripts/check-tree-utils.ts`
- Modify: `src/renderer/src/components/Sidebar.tsx` (thêm import; xóa 3 hàm ở dòng 372–403)
- Modify: `package.json` (thêm script `check:tree-utils`)

**Interfaces:**
- Consumes: không có (task đầu tiên).
- Produces:
  - `export interface TreeLike<T> { key: string; title: string; children?: T[] }`
  - `export interface FilterResult<T> { nodes: T[]; expandKeys: string[] }`
  - `export function findNode<T extends TreeLike<T>>(nodes: T[], key: string): T | undefined`
  - `export function findParentKey<T extends TreeLike<T>>(nodes: T[], childKey: string, parentKey?: string): string | undefined`
  - `export function insertChildren<T extends TreeLike<T>>(nodes: T[], key: string, children: T[]): T[]`
  - `export function filterTree<T extends TreeLike<T>>(nodes: T[], query: string): FilterResult<T>`

- [ ] **Step 1: Viết script kiểm chứng (sẽ fail vì module chưa tồn tại)**

Tạo `scripts/check-tree-utils.ts`:

```ts
import assert from 'node:assert/strict';
import { filterTree, findNode, findParentKey, insertChildren } from '../src/renderer/src/lib/tree-utils';

interface N {
  key: string;
  title: string;
  children?: N[];
}

const tree: N[] = [
  {
    key: 'conn:1',
    title: 'Local (mariadb)',
    children: [
      {
        key: 'conn:1:db:shop',
        title: 'shop',
        children: [
          { key: 'conn:1:tbl:orders', title: 'orders' },
          { key: 'conn:1:tbl:order_items', title: 'order_items' },
          { key: 'conn:1:tbl:users', title: 'users' },
        ],
      },
      {
        key: 'conn:1:db:blog',
        title: 'blog',
        children: [{ key: 'conn:1:tbl:posts', title: 'posts' }],
      },
    ],
  },
];

const names = (ns: N[]): string[] => ns.map((n) => n.title);

// query rỗng (kể cả toàn khoảng trắng) -> trả nguyên cây, không expand gì
{
  const r = filterTree(tree, '   ');
  assert.equal(r.nodes, tree);
  assert.deepEqual(r.expandKeys, []);
}

// khớp node lá -> chỉ giữ nhánh dẫn tới kết quả, expandKeys là tổ tiên
{
  const r = filterTree(tree, 'order');
  assert.deepEqual(names(r.nodes), ['Local (mariadb)']);
  assert.deepEqual(names(r.nodes[0].children!), ['shop']);
  assert.deepEqual(names(r.nodes[0].children![0].children!), ['orders', 'order_items']);
  assert.deepEqual([...r.expandKeys].sort(), ['conn:1', 'conn:1:db:shop']);
}

// khớp node cha -> giữ đủ toàn bộ con đã tải, bản thân nó không nằm trong expandKeys
{
  const r = filterTree(tree, 'shop');
  assert.deepEqual(names(r.nodes[0].children!), ['shop']);
  assert.deepEqual(names(r.nodes[0].children![0].children!), ['orders', 'order_items', 'users']);
  assert.deepEqual(r.expandKeys, ['conn:1']);
}

// không khớp gì -> cây rỗng
{
  assert.deepEqual(filterTree(tree, 'zzz').nodes, []);
}

// không phân biệt hoa/thường
{
  const r = filterTree(tree, 'POSTS');
  assert.deepEqual(names(r.nodes[0].children!), ['blog']);
}

// không sửa cây gốc
{
  filterTree(tree, 'order');
  assert.equal(tree[0].children!.length, 2);
  assert.equal(tree[0].children![0].children!.length, 3);
}

// 3 tiện ích chuyển từ Sidebar giữ nguyên hành vi
{
  assert.equal(findNode(tree, 'conn:1:tbl:users')?.title, 'users');
  assert.equal(findNode(tree, 'khong-co'), undefined);
  assert.equal(findParentKey(tree, 'conn:1:db:blog'), 'conn:1');
  assert.equal(findParentKey(tree, 'conn:1'), undefined);

  const next = insertChildren(tree, 'conn:1:db:blog', [{ key: 'conn:1:tbl:tags', title: 'tags' }]);
  assert.deepEqual(names(next[0].children![1].children!), ['tags']);
  assert.deepEqual(names(tree[0].children![1].children!), ['posts']); // gốc không đổi
}

console.log('OK: tree-utils');
```

- [ ] **Step 2: Thêm npm script**

Trong `package.json`, thêm vào `"scripts"` ngay sau `"typecheck"`:

```json
    "check:tree-utils": "esbuild scripts/check-tree-utils.ts --bundle --format=esm --platform=node --outfile=node_modules/.cache/check-tree-utils.mjs && node node_modules/.cache/check-tree-utils.mjs",
```

- [ ] **Step 3: Chạy để xác nhận fail**

Run: `npm run check:tree-utils`
Expected: FAIL — esbuild báo `Could not resolve "../src/renderer/src/lib/tree-utils"`

- [ ] **Step 4: Tạo module `tree-utils.ts`**

Tạo `src/renderer/src/lib/tree-utils.ts`:

```ts
/** Node tối thiểu mà các tiện ích dưới đây cần: có key, nhãn hiển thị và (tùy chọn) con. */
export interface TreeLike<T> {
  key: string;
  title: string;
  children?: T[];
}

export interface FilterResult<T> {
  /** Cây sau khi lọc. */
  nodes: T[];
  /** Key của các node tổ tiên chứa kết quả -> dùng để tự mở nhánh. */
  expandKeys: string[];
}

/** Tìm node theo key (đệ quy). */
export function findNode<T extends TreeLike<T>>(nodes: T[], key: string): T | undefined {
  for (const n of nodes) {
    if (n.key === key) return n;
    if (n.children) {
      const found = findNode(n.children, key);
      if (found) return found;
    }
  }
  return undefined;
}

/** Tìm key của node cha chứa childKey (đệ quy). */
export function findParentKey<T extends TreeLike<T>>(
  nodes: T[],
  childKey: string,
  parentKey?: string,
): string | undefined {
  for (const n of nodes) {
    if (n.key === childKey) return parentKey;
    if (n.children) {
      const found = findParentKey(n.children, childKey, n.key);
      if (found) return found;
    }
  }
  return undefined;
}

/** Chèn danh sách con vào node có key cho trước (đệ quy, trả cây mới). */
export function insertChildren<T extends TreeLike<T>>(nodes: T[], key: string, children: T[]): T[] {
  return nodes.map((n) => {
    if (n.key === key) return { ...n, children };
    if (n.children) return { ...n, children: insertChildren(n.children, key, children) };
    return n;
  });
}

/**
 * Lọc cây theo tên node.
 *
 * - Giữ node khi chính nó khớp, hoặc khi có con cháu khớp.
 * - Node tự khớp thì giữ nguyên toàn bộ con đã tải (không lọc tiếp xuống dưới),
 *   để gõ tên database vẫn xem được đầy đủ bảng bên trong.
 * - query rỗng trả về chính mảng đầu vào, không tạo bản sao.
 */
export function filterTree<T extends TreeLike<T>>(nodes: T[], query: string): FilterResult<T> {
  const q = query.trim().toLowerCase();
  if (!q) return { nodes, expandKeys: [] };

  const expandKeys: string[] = [];

  const walk = (list: T[]): T[] => {
    const kept: T[] = [];
    for (const n of list) {
      if (n.title.toLowerCase().includes(q)) {
        kept.push(n);
        continue;
      }
      const children = n.children ? walk(n.children) : [];
      if (children.length > 0) {
        expandKeys.push(n.key);
        kept.push({ ...n, children });
      }
    }
    return kept;
  };

  return { nodes: walk(nodes), expandKeys };
}
```

- [ ] **Step 5: Chạy lại kiểm chứng**

Run: `npm run check:tree-utils`
Expected: PASS — in ra `OK: tree-utils`

- [ ] **Step 6: Chuyển Sidebar sang dùng module mới**

Trong `src/renderer/src/components/Sidebar.tsx`:

Thêm import (sau dòng import `buildTableMenu`):

```tsx
import { findNode, findParentKey, insertChildren } from '../lib/tree-utils';
```

Xóa toàn bộ 3 hàm ở cuối file (từ comment `/** Tìm node theo key (đệ quy). */` đến hết `insertChildren`, dòng 372–403). Phần còn lại của file không đổi — chữ ký ba hàm giữ nguyên nên chỗ gọi không cần sửa.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS, không lỗi

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/lib/tree-utils.ts scripts/check-tree-utils.ts src/renderer/src/components/Sidebar.tsx package.json
git commit -m "$(cat <<'EOF'
refactor(ui): tách tiện ích cây sang lib/tree-utils + thêm filterTree

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Ô lọc ở Sidebar

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/styles.css:28-33`

**Interfaces:**
- Consumes: `filterTree` từ `../lib/tree-utils` — `filterTree<T extends TreeLike<T>>(nodes: T[], query: string): { nodes: T[]; expandKeys: string[] }`. `UiNode` trong `Sidebar.tsx` đã thỏa `TreeLike<UiNode>` (có `key: string`, `title: string`, `children?: UiNode[]`) nên không cần đổi type.
- Produces: không có (thay đổi cục bộ trong component).

- [ ] **Step 1: Cập nhật import**

Trong `src/renderer/src/components/Sidebar.tsx`:

```tsx
import { Button, Dropdown, Empty, Input, Modal, Tree, message } from 'antd';
```

```tsx
import {
  DatabaseOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  TableOutlined,
  FolderOutlined,
  KeyOutlined,
} from '@ant-design/icons';
```

```tsx
import { filterTree, findNode, findParentKey, insertChildren } from '../lib/tree-utils';
```

- [ ] **Step 2: Thêm helper highlight ở cấp module**

Đặt ngay sau hàm `iconFor` (trước `export function Sidebar`):

```tsx
/** Bọc phần khớp trong nhãn bằng <mark> để dễ nhìn khi đang lọc. */
function highlight(title: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return title;
  const i = title.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return title;
  return (
    <>
      {title.slice(0, i)}
      <mark style={{ background: '#ffe58f', padding: 0 }}>{title.slice(i, i + q.length)}</mark>
      {title.slice(i + q.length)}
    </>
  );
}
```

- [ ] **Step 3: Thêm state lọc và expand có kiểm soát**

Ngay sau `const [transferSrc, setTransferSrc] = useState<TransferSource | null>(null);`:

```tsx
  // Chuỗi lọc cây (client-side, chỉ trên node đã tải).
  const [query, setQuery] = useState('');
  // Trạng thái mở do người dùng tự bấm — nguồn sự thật khi không lọc.
  const [userExpandedKeys, setUserExpandedKeys] = useState<React.Key[]>([]);
```

Ngay sau khối `useMemo` dựng `rootNodes`:

```tsx
  const { nodes: visibleNodes, expandKeys } = useMemo(() => filterTree(rootNodes, query), [rootNodes, query]);

  // Khi lọc: mở thêm các nhánh chứa kết quả. Xóa ô lọc -> tự quay về trạng thái người dùng đã mở.
  const expandedKeys = useMemo(
    () => (query.trim() ? Array.from(new Set([...userExpandedKeys, ...expandKeys])) : userExpandedKeys),
    [query, userExpandedKeys, expandKeys],
  );
```

- [ ] **Step 4: Thêm ô lọc vào header**

Ngay sau `</div>` đóng `<div className="sidebar-header">`, thêm:

```tsx
      <div className="sidebar-filter">
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder="Lọc trong cây đang mở…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
```

- [ ] **Step 5: Nối cây với kết quả lọc**

Đổi điều kiện render trong `<div className="sidebar-tree">`:

```tsx
        {connections.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có kết nối" />
        ) : visibleNodes.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có node nào khớp" />
        ) : (
```

Đổi props của `<Tree>` (giữ nguyên các props khác):

```tsx
            treeData={visibleNodes as unknown as DataNode[]}
            expandedKeys={expandedKeys}
            autoExpandParent={false}
            onExpand={(keys) => setUserExpandedKeys(keys)}
```

- [ ] **Step 6: Highlight nhãn ở cả 4 nhánh của `titleRender`**

Thay từng chỗ render nhãn:

1. Node kết nối:

```tsx
                    <span style={{ fontWeight: ui.connectionId === activeConnectionId ? 600 : 400 }}>
                      {highlight(ui.title, query)}
                    </span>
```

2. Nhánh sớm khi không quản lý được (`if (!raw || !conn || !canManage(conn.kind))`):

```tsx
              if (!raw || !conn || !canManage(conn.kind)) return <span>{highlight(ui.title, query)}</span>;
```

3. Node database/schema — trong `<Dropdown>`:

```tsx
                    <span>{highlight(ui.title, query)}</span>
```

4. Node bảng/view/collection — trong `<Dropdown>`:

```tsx
                    <span>{highlight(ui.title, query)}</span>
```

5. Dòng `return` cuối cùng của `titleRender`:

```tsx
              return <span>{highlight(ui.title, query)}</span>;
```

- [ ] **Step 7: CSS cho hàng lọc**

Trong `src/renderer/src/styles.css`, bỏ `border-bottom` khỏi `.sidebar-header` và thêm rule mới ngay sau nó:

```css
.sidebar-header {
  padding: 8px;
  display: flex;
  gap: 8px;
}

.sidebar-filter {
  padding: 0 8px 8px;
  border-bottom: 1px solid #f0f0f0;
}
```

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 9: Kiểm tra tay**

Run: `npm run dev`

Kiểm đủ 5 điểm:
1. Mở ≥1 kết nối, expand vài database → ô lọc hiện dưới hàng nút, cây đầy đủ.
2. Gõ một phần tên bảng → chỉ còn nhánh chứa bảng khớp, nhánh tự mở, phần khớp nền vàng.
3. Gõ tên database → database đó hiện kèm **đủ** bảng bên trong.
4. Gõ chuỗi vô nghĩa → hiện `Không có node nào khớp`.
5. Bấm nút xóa (allowClear) → cây trở lại đúng các nhánh đang mở trước khi lọc; menu chuột phải trên node vẫn hoạt động.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx src/renderer/src/styles.css
git commit -m "$(cat <<'EOF'
feat(ui): ô lọc tên node ở sidebar (client-side, auto-expand + highlight)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Ô tìm tên bảng ở DatabaseOverview

**Files:**
- Modify: `src/renderer/src/components/DatabaseOverview.tsx`

**Interfaces:**
- Consumes: không phụ thuộc task trước (chỉ dùng `TableSummary` từ `@shared/types`, đã có).
- Produces: không có.

- [ ] **Step 1: Cập nhật import**

Trong `src/renderer/src/components/DatabaseOverview.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Menu, Space, Spin, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DatabaseOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
```

- [ ] **Step 2: Thêm state và danh sách đã lọc**

Ngay sau `const [ctx, setCtx] = useState<...>(null);`:

```tsx
  // Chuỗi tìm theo tên bảng (lọc client trên danh sách đã tải).
  const [query, setQuery] = useState('');
```

Ngay sau khối `reload`:

```tsx
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tables ?? [];
    return (tables ?? []).filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, query]);
```

- [ ] **Step 3: Reset ô tìm khi đổi database/schema**

Trong `useEffect` nạp danh sách, thêm `setQuery('')` ngay sau `setTables(null);`:

```tsx
    setLoading(true);
    setTables(null);
    setQuery('');
```

- [ ] **Step 4: Nhãn đếm theo ngữ cảnh lọc**

Thay phần đếm trong `Typography.Title`:

```tsx
        <Typography.Title level={5} style={{ margin: 0 }}>
          <DatabaseOutlined /> {label}
          {tables ? (
            <Typography.Text type="secondary">
              {' · '}
              {query.trim() ? `${visible.length}/${tables.length}` : tables.length} bảng
            </Typography.Text>
          ) : null}
        </Typography.Title>
```

- [ ] **Step 5: Thêm ô tìm cạnh nút "Tải lại"**

Thay nút "Tải lại" đứng một mình bằng:

```tsx
        <Space>
          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
            placeholder="Tìm tên bảng…"
            style={{ width: 220 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={reload} loading={loading}>
            Tải lại
          </Button>
        </Space>
```

- [ ] **Step 6: Nối bảng với danh sách đã lọc + trạng thái rỗng**

Thay khối render trong `<Spin>`:

```tsx
          {tables && tables.length === 0 ? (
            <Empty description="Database rỗng — chưa có bảng nào" />
          ) : tables && visible.length === 0 ? (
            <Empty description="Không có bảng nào khớp" />
          ) : (
            <Table<TableSummary>
              rowKey="name"
              size="small"
              columns={columns}
              dataSource={visible}
              pagination={false}
              onRow={(record) => ({
                style: { cursor: 'pointer' },
                onClick: () => onOpenTable({ database, schema, name: record.name }),
                onContextMenu: (e) => {
                  e.preventDefault();
                  setCtx({ row: record, x: e.clientX, y: e.clientY });
                },
              })}
            />
          )}
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Kiểm tra tay**

Run: `npm run dev`

1. Click một database ở sidebar → panel phải hiện danh sách, tiêu đề `· N bảng`.
2. Gõ một phần tên bảng → danh sách rút gọn, tiêu đề đổi thành `· k/N bảng`.
3. Sort theo cột và chuột phải trên dòng đã lọc → vẫn hoạt động.
4. Gõ chuỗi vô nghĩa → `Không có bảng nào khớp` (khác với database rỗng).
5. Chuyển sang database khác → ô tìm tự trống, danh sách đầy đủ.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/components/DatabaseOverview.tsx
git commit -m "$(cat <<'EOF'
feat(ui): ô tìm tên bảng trong DatabaseOverview + nhãn đếm theo bộ lọc

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Nút làm mới ở DataGridView

**Files:**
- Modify: `src/renderer/src/components/DataGridView.tsx`

**Interfaces:**
- Consumes: `load(p: number): Promise<void>` — `useCallback` sẵn có trong component, đã đọc `orderBy`, `search` và `filtersRef.current` nên tự giữ nguyên ngữ cảnh. Không sửa `load`.
- Produces: không có.

- [ ] **Step 1: Thêm icon vào import**

```tsx
import { DeleteOutlined, DownloadOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
```

- [ ] **Step 2: Thêm nút vào đầu thanh công cụ**

Trong `<Space>` của thanh công cụ, chèn ngay trước nút "Thêm dòng":

```tsx
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load(page)}>
            Tải lại
          </Button>
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Kiểm tra tay**

Run: `npm run dev`

1. Mở một bảng có >200 dòng, sang trang 3, sort theo một cột, đặt một filter cột và gõ chuỗi vào ô "Tìm trên toàn bảng".
2. Bấm `Tải lại` → nút quay vòng rồi dừng; vẫn ở trang 3, sort/filter/search giữ nguyên, dữ liệu được đọc lại.
3. Sửa dữ liệu bằng công cụ ngoài (hoặc tab khác) rồi bấm `Tải lại` → thấy giá trị mới.
4. Ngắt kết nối DB rồi bấm `Tải lại` → hiện `Đọc dữ liệu thất bại: …`, spinner tắt, nút bấm lại được.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/DataGridView.tsx
git commit -m "$(cat <<'EOF'
feat(ui): nút Tải lại ở data grid, giữ nguyên trang/sort/filter/search

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Sau khi xong 4 task

- [ ] Chạy lại toàn bộ cổng kiểm: `npm run typecheck && npm run check:tree-utils`
- [ ] `git log --oneline main..HEAD` — kỳ vọng 5 commit (1 spec + 4 task)
- [ ] Quyết định merge/PR theo `superpowers:finishing-a-development-branch`
