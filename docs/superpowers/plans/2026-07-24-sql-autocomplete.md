# SQL Autocomplete Theo Schema — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm autocomplete context-aware cho ô SQL trong `QueryPanel`, gợi ý tên bảng/cột từ schema của database đang chọn + từ khóa SQL.

**Architecture:** Backend thêm một IPC gom bảng+cột (`getSchemaObjects`, 1 query `information_schema` cho MariaDB & Postgres). Renderer có module `sql-completion.ts` với một pure function `computeSuggestions` (heuristic ngữ cảnh quanh con trỏ) + một Monaco completion provider đăng ký một lần đọc "active schema" (do `QueryPanel` nạp theo database đang chọn).

**Tech Stack:** Electron + React + TypeScript + Ant Design; Monaco editor; driver `mysql2` (MariaDB), `pg` (Postgres).

## Global Constraints

- Không có test framework. Gate tự động: `npm run typecheck` (node+web strict) + `npm run build` — phải PASS sau mỗi task.
- Verify hành vi bằng harness headless: `npx esbuild <harness>.ts --bundle --platform=node --format=esm --packages=external --outfile=<repo>/x.mjs` rồi `node <repo>/x.mjs`. **Xuất `.mjs` NẰM TRONG repo dir** để ESM resolve driver từ `node_modules` của repo. Xóa harness `.ts` + `.mjs` sau khi verify; KHÔNG commit harness.
- SQL test: harness tự spin `docker run` throwaway `mariadb:11` + `postgres:16`, teardown (`docker rm -f`) khi xong. Chờ ~15-25s để DB nhận kết nối; retry trước khi kết luận lỗi code.
- Chỉ hỗ trợ SQL (`mariadb`, `postgres`). KHÔNG đụng `mongo`/`redis` (method adapter là optional).
- Adapter/shared import `@shared/types` bằng `import type` (bị erase khi bundle) — giữ nguyên.
- `RendererApi` là interface preload phải hiện thực đầy đủ (`const api: RendererApi`): thêm method vào `RendererApi` BẮT BUỘC kèm hiện thực trong preload cùng lúc, nếu không `typecheck:node` fail.
- Comment/nhãn UI tiếng Việt, khớp văn phong hiện có.
- `.claude/settings.local.json` có thể hiện modified trong working tree — luôn để unstaged, không thuộc feature.
- Commit message kết thúc bằng: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File Structure

- `src/shared/types.ts` (modify) — `SchemaObject`; `IpcChannels.schemaObjects`; `DatabaseAdapter.getSchemaObjects?`; `RendererApi.getSchemaObjects`.
- `src/preload/index.ts` (modify) — expose `getSchemaObjects` (bắt buộc, cùng Task 1).
- `src/main/adapters/sql-util.ts` (modify) — helper `groupColumnsByTable`.
- `src/main/adapters/mariadb.ts` (modify) — `getSchemaObjects`.
- `src/main/adapters/postgres.ts` (modify) — `getSchemaObjects`.
- `src/main/ipc.ts` (modify) — handler `schema:objects`.
- `src/renderer/src/sql-completion.ts` (create) — `computeSuggestions` (pure) + `registerSqlCompletion` + `setActiveSchema`/`clearActiveSchema` + keyword list.
- `src/renderer/src/monaco-setup.ts` (modify) — gọi `registerSqlCompletion(monaco)`.
- `src/renderer/src/components/QueryPanel.tsx` (modify) — props `database`/`schema` + effect nạp metadata.
- `src/renderer/src/App.tsx` (modify) — truyền `database`/`schema` xuống `QueryPanel`.

---

### Task 1: Contracts + preload

Khai báo kiểu & chữ ký; hiện thực preload ngay để giữ typecheck xanh.

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: (không)
- Produces:
  - `interface SchemaObject { table: string; columns: string[] }`
  - `IpcChannels.schemaObjects = 'schema:objects'`
  - `DatabaseAdapter.getSchemaObjects?(database?: string, schema?: string): Promise<SchemaObject[]>`
  - `RendererApi.getSchemaObjects(connectionId: string, database?: string, schema?: string): Promise<SchemaObject[]>`
  - preload: `api.getSchemaObjects`

- [ ] **Step 1: Thêm `SchemaObject` + adapter sig trong `types.ts`**

Thêm kiểu (gần các kiểu metadata, ví dụ sau `TableStructure`):

```ts
/** Bảng + danh sách cột của nó, dùng cho autocomplete SQL. */
export interface SchemaObject {
  table: string;
  columns: string[];
}
```

Trong interface `DatabaseAdapter`, thêm (ví dụ sau `getCreateStatement`):

```ts
  /** (SQL) Lấy toàn bộ bảng + cột của một database/schema trong 1 truy vấn — cho autocomplete. */
  getSchemaObjects?(database?: string, schema?: string): Promise<SchemaObject[]>;
```

- [ ] **Step 2: Thêm IPC channel + RendererApi method**

Trong `IpcChannels`, thêm sau `transferCancel`:

```ts
  schemaObjects: 'schema:objects',
```

Trong interface `RendererApi`, thêm (sau `getTableList` hoặc cuối interface):

```ts
  /** (SQL) Lấy bảng + cột của database/schema cho autocomplete; [] nếu loại DB không hỗ trợ. */
  getSchemaObjects(connectionId: string, database?: string, schema?: string): Promise<SchemaObject[]>;
```

- [ ] **Step 3: Hiện thực trong preload**

Trong `src/preload/index.ts`, thêm `SchemaObject` không cần import (chỉ dùng trong RendererApi type; nhưng thêm vào khối `import type` nếu TS yêu cầu). Thêm vào object `api` (sau `getTableList`):

```ts
  getSchemaObjects: (connectionId: string, database?: string, schema?: string) =>
    ipcRenderer.invoke(IpcChannels.schemaObjects, connectionId, database, schema),
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS (chỉ khai báo + preload wiring; chưa có handler/adapter nên chưa gọi runtime).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/preload/index.ts
git commit -m "feat(sql-ac): contracts — SchemaObject, IPC channel, adapter & api sig + preload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backend `getSchemaObjects` (MariaDB + Postgres) + IPC handler

**Files:**
- Modify: `src/main/adapters/sql-util.ts` (thêm helper)
- Modify: `src/main/adapters/mariadb.ts` (thêm method, sau `getCreateStatement` ~dòng 293)
- Modify: `src/main/adapters/postgres.ts` (thêm method, sau `getCreateStatement` ~dòng 363)
- Modify: `src/main/ipc.ts` (thêm handler)
- Test (tạm): harness bundle ra `<repo>/sa-be.mjs`, docker throwaway

**Interfaces:**
- Consumes: `SchemaObject`, `IpcChannels.schemaObjects` (Task 1); helpers `quoteIdentMysql`/`quoteIdentPg`, `this.db()`, `this.config.database`.
- Produces:
  - `sql-util.ts`: `export function groupColumnsByTable(rows: { t: string; c: string }[]): SchemaObject[]`
  - `MariaDbAdapter.getSchemaObjects`, `PostgresAdapter.getSchemaObjects`
  - ipc handler `schema:objects` trả `SchemaObject[]` (`[]` nếu adapter không hỗ trợ)

- [ ] **Step 1: Viết harness (fail — method chưa có)**

Tạo `sa-be-harness.ts` trong repo root:

```ts
import { createAdapter } from './src/main/adapters';
import type { ConnectionConfig } from './src/shared/types';

const maria: ConnectionConfig = { id: 'm', name: 'm', kind: 'mariadb', host: '127.0.0.1', port: 33062, user: 'root', password: 'root', database: 'actest' };
const pg: ConnectionConfig = { id: 'p', name: 'p', kind: 'postgres', host: '127.0.0.1', port: 54322, user: 'postgres', password: 'postgres', database: 'actest' };

async function run(cfg: ConnectionConfig, ddl1: string, ddl2: string) {
  const a = createAdapter(cfg);
  await a.connect();
  await a.executeRaw('DROP TABLE IF EXISTS users', cfg.database);
  await a.executeRaw('DROP TABLE IF EXISTS orders', cfg.database);
  await a.executeRaw(ddl1, cfg.database);
  await a.executeRaw(ddl2, cfg.database);
  const objs = await a.getSchemaObjects!(cfg.database, cfg.kind === 'postgres' ? 'public' : undefined);
  await a.disconnect();
  const users = objs.find((o) => o.table === 'users');
  const orders = objs.find((o) => o.table === 'orders');
  if (!users || !orders) throw new Error(`${cfg.kind}: thiếu bảng, nhận ${JSON.stringify(objs.map((o) => o.table))}`);
  if (!(users.columns.includes('id') && users.columns.includes('name'))) throw new Error(`${cfg.kind}: users cột sai ${users.columns}`);
  console.log(`${cfg.kind}: OK users=[${users.columns}] orders=[${orders.columns}]`);
}

await run(maria, 'CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50))', 'CREATE TABLE orders (oid INT, amount INT)');
await run(pg, 'CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50))', 'CREATE TABLE orders (oid INT, amount INT)');
console.log('ALL OK');
```

- [ ] **Step 2: Spin docker & chạy → FAIL**

```bash
docker run -d --rm --name sa-maria -e MARIADB_ROOT_PASSWORD=root -e MARIADB_DATABASE=actest -p 33062:3306 mariadb:11
docker run -d --rm --name sa-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=actest -p 54322:5432 postgres:16
sleep 22
cd /Users/quyet.bq/Public/db_manager
npx esbuild sa-be-harness.ts --bundle --platform=node --format=esm --packages=external --outfile=sa-be.mjs
node sa-be.mjs
```
Expected: FAIL — `a.getSchemaObjects is not a function`.

- [ ] **Step 3: Thêm helper vào `sql-util.ts`**

```ts
import type { SchemaObject } from '@shared/types';

/** Gom các dòng {t: table, c: column} (đã ORDER BY table, ordinal) thành SchemaObject[]. */
export function groupColumnsByTable(rows: { t: string; c: string }[]): SchemaObject[] {
  const map = new Map<string, string[]>();
  for (const { t, c } of rows) {
    const cols = map.get(t);
    if (cols) cols.push(c);
    else map.set(t, [c]);
  }
  return [...map.entries()].map(([table, columns]) => ({ table, columns }));
}
```

(Đặt `import type` cùng nhóm import hiện có ở đầu file.)

- [ ] **Step 4: `getSchemaObjects` trong `mariadb.ts`**

Thêm sau `getCreateStatement` (~dòng 293). Import `groupColumnsByTable` từ `./sql-util` (thêm vào import hiện có nếu có, hoặc dòng import mới).

```ts
  async getSchemaObjects(database?: string): Promise<SchemaObject[]> {
    const db = database ?? this.config.database;
    const [rows] = await this.db().query(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = ? ORDER BY table_name, ordinal_position`,
      [db],
    );
    return groupColumnsByTable(rows as { t: string; c: string }[]);
  }
```

Thêm `SchemaObject` vào khối `import type { … } from '@shared/types'` của file.

- [ ] **Step 5: `getSchemaObjects` trong `postgres.ts`**

Thêm sau `getCreateStatement` (~dòng 363). Import `groupColumnsByTable` từ `./sql-util`.

```ts
  async getSchemaObjects(_database?: string, schema?: string): Promise<SchemaObject[]> {
    const s = schema ?? 'public';
    const res = await this.db().query(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
      [s],
    );
    return groupColumnsByTable(res.rows as { t: string; c: string }[]);
  }
```

Thêm `SchemaObject` vào khối `import type { … } from '@shared/types'` của file.

- [ ] **Step 6: Handler IPC trong `ipc.ts`**

Thêm (sau handler `treeTableList` hoặc gần các handler tree):

```ts
  ipcMain.handle(
    IpcChannels.schemaObjects,
    (_e, connectionId: string, database?: string, schema?: string) => {
      const adapter = sessions.get(connectionId);
      return adapter.getSchemaObjects ? adapter.getSchemaObjects(database, schema) : [];
    },
  );
```

- [ ] **Step 7: Bundle & chạy → PASS, rồi dọn dẹp**

```bash
npx esbuild sa-be-harness.ts --bundle --platform=node --format=esm --packages=external --outfile=sa-be.mjs
node sa-be.mjs
# Expected: "mariadb: OK ...", "postgres: OK ...", "ALL OK"
rm -f sa-be.mjs sa-be-harness.ts
docker rm -f sa-maria sa-pg
npm run typecheck
```
Expected: harness in ALL OK; typecheck PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/adapters/sql-util.ts src/main/adapters/mariadb.ts src/main/adapters/postgres.ts src/main/ipc.ts
git commit -m "feat(sql-ac): getSchemaObjects (Maria+PG, 1 information_schema query) + IPC handler

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Renderer `sql-completion.ts` — pure heuristic + provider + state

**Files:**
- Create: `src/renderer/src/sql-completion.ts`
- Test (tạm): harness bundle ra `<repo>/sa-fe.mjs` (test `computeSuggestions` thuần, không cần DB/Monaco)

**Interfaces:**
- Consumes: `SchemaObject` (Task 1); type-only `import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'`.
- Produces:
  - `type SuggestionKind = 'table' | 'column' | 'keyword'`
  - `interface Suggestion { label: string; kind: SuggestionKind }`
  - `computeSuggestions(textUntilCursor: string, fullText: string, schema: SchemaObject[]): Suggestion[]`
  - `setActiveSchema(objs: SchemaObject[]): void`, `clearActiveSchema(): void`
  - `registerSqlCompletion(monaco: typeof Monaco): void`

- [ ] **Step 1: Viết harness (fail — module chưa có)**

Tạo `sa-fe-harness.ts` trong repo root:

```ts
import { computeSuggestions } from './src/renderer/src/sql-completion';
import type { SchemaObject } from './src/shared/types';

const schema: SchemaObject[] = [
  { table: 'users', columns: ['id', 'name', 'email'] },
  { table: 'orders', columns: ['oid', 'amount'] },
];
const labels = (t: string, full = t) => computeSuggestions(t, full, schema).map((s) => `${s.kind}:${s.label}`);

// 1. sau FROM -> bảng
const a = labels('SELECT * FROM ');
if (!(a.includes('table:users') && a.includes('table:orders'))) throw new Error('FROM fail: ' + a);
// 2. users. -> cột users
const b = labels('SELECT users.', 'SELECT users. FROM users');
if (!(b.includes('column:id') && b.includes('column:email') && !b.some((x) => x.startsWith('table:')))) throw new Error('users. fail: ' + b);
// 3. alias u. với FROM users u -> cột users
const c = labels('SELECT u.', 'SELECT u. FROM users u');
if (!(c.includes('column:id') && c.includes('column:name'))) throw new Error('alias fail: ' + c);
// 4. alias không binding -> []
const d = labels('SELECT x.', 'SELECT x. FROM users u');
if (d.length !== 0) throw new Error('unbound alias should be empty: ' + d);
// 5. giữa câu -> có keyword + bảng
const e = labels('SELECT ');
if (!(e.some((x) => x.startsWith('keyword:')) && e.includes('table:users'))) throw new Error('default fail: ' + e);
// 6. case-insensitive: FROM Users
const f = labels('SELECT Users.', 'SELECT Users. FROM Users');
if (!f.includes('column:id')) throw new Error('case-insensitive fail: ' + f);
console.log('ALL OK');
```

- [ ] **Step 2: Bundle & chạy → FAIL**

```bash
cd /Users/quyet.bq/Public/db_manager
npx esbuild sa-fe-harness.ts --bundle --platform=node --format=esm --packages=external --outfile=sa-fe.mjs
node sa-fe.mjs
```
Expected: FAIL — không resolve `./src/renderer/src/sql-completion`.

- [ ] **Step 3: Tạo `src/renderer/src/sql-completion.ts`**

```ts
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { SchemaObject } from '@shared/types';

export type SuggestionKind = 'table' | 'column' | 'keyword';
export interface Suggestion {
  label: string;
  kind: SuggestionKind;
}

/** Từ khóa SQL cơ bản gợi ý ở ngữ cảnh chung. */
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'GROUP BY',
  'ORDER BY', 'LIMIT', 'OFFSET', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET',
  'VALUES', 'AND', 'OR', 'NOT', 'NULL', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG',
  'MIN', 'MAX', 'LIKE', 'IN', 'BETWEEN', 'IS', 'ASC', 'DESC',
];

/** Từ khóa mà ngay sau nó nên gợi ý tên bảng. */
const TABLE_CONTEXT = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE']);

/** Tìm cột cho `name`: là tên bảng trực tiếp, hoặc alias trong FROM/JOIN cấp một. */
function resolveColumns(name: string, fullText: string, schema: SchemaObject[]): string[] {
  const lower = name.toLowerCase();
  const direct = schema.find((o) => o.table.toLowerCase() === lower);
  if (direct) return direct.columns;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b(?:FROM|JOIN)\\s+[\`"\\[]?(\\w+)[\`"\\]]?\\s+(?:AS\\s+)?${esc}\\b`, 'i');
  const m = fullText.match(re);
  if (m) {
    const tbl = m[1].toLowerCase();
    const found = schema.find((o) => o.table.toLowerCase() === tbl);
    if (found) return found.columns;
  }
  return [];
}

/** Phân tích ngữ cảnh quanh con trỏ để chọn loại gợi ý. Thuần, không phụ thuộc Monaco/DOM. */
export function computeSuggestions(
  textUntilCursor: string,
  fullText: string,
  schema: SchemaObject[],
): Suggestion[] {
  // 1. `<X>.` -> cột của X (bảng hoặc alias)
  const dot = textUntilCursor.match(/([A-Za-z_][\w$]*)\.\s*$/);
  if (dot) {
    return resolveColumns(dot[1], fullText, schema).map((c) => ({ label: c, kind: 'column' as const }));
  }
  // 2. Ngay sau FROM/JOIN/INTO/UPDATE/TABLE (có khoảng trắng) -> tên bảng
  const kw = textUntilCursor.match(/\b([A-Za-z_]+)\s+$/);
  if (kw && TABLE_CONTEXT.has(kw[1].toUpperCase())) {
    return schema.map((o) => ({ label: o.table, kind: 'table' as const }));
  }
  // 3. Mặc định: keyword + tên bảng
  return [
    ...KEYWORDS.map((k) => ({ label: k, kind: 'keyword' as const })),
    ...schema.map((o) => ({ label: o.table, kind: 'table' as const })),
  ];
}

/* ---- Active schema (module-level: chỉ 1 query editor SQL hoạt động 1 lúc) ---- */

let activeSchema: SchemaObject[] | null = null;

export function setActiveSchema(objs: SchemaObject[]): void {
  activeSchema = objs;
}

export function clearActiveSchema(): void {
  activeSchema = null;
}

/** Đăng ký completion provider cho language 'sql'. Gọi 1 lần từ monaco-setup. */
export function registerSqlCompletion(monaco: typeof Monaco): void {
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      if (!activeSchema) return { suggestions: [] };
      const textUntilCursor = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const kindOf = (k: SuggestionKind): Monaco.languages.CompletionItemKind =>
        k === 'column'
          ? monaco.languages.CompletionItemKind.Field
          : k === 'table'
            ? monaco.languages.CompletionItemKind.Struct
            : monaco.languages.CompletionItemKind.Keyword;
      const suggestions = computeSuggestions(textUntilCursor, model.getValue(), activeSchema).map((s) => ({
        label: s.label,
        kind: kindOf(s.kind),
        insertText: s.label,
        range,
      }));
      return { suggestions };
    },
  });
}
```

- [ ] **Step 4: Bundle & chạy → PASS, dọn dẹp**

```bash
npx esbuild sa-fe-harness.ts --bundle --platform=node --format=esm --packages=external --outfile=sa-fe.mjs
node sa-fe.mjs
# Expected: ALL OK
rm -f sa-fe.mjs sa-fe-harness.ts
npm run typecheck
```
Expected: harness ALL OK; typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/sql-completion.ts
git commit -m "feat(sql-ac): sql-completion — computeSuggestions (context-aware) + Monaco provider + active schema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire — monaco-setup + QueryPanel + App

**Files:**
- Modify: `src/renderer/src/monaco-setup.ts`
- Modify: `src/renderer/src/components/QueryPanel.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `registerSqlCompletion`, `setActiveSchema`, `clearActiveSchema` (Task 3); `window.api.getSchemaObjects` (Task 1/2); `App.dbSelection` + `session.connection.database`.
- Produces: `QueryPanel` nhận props `database?: string`, `schema?: string`; autocomplete hoạt động end-to-end.

- [ ] **Step 1: `monaco-setup.ts` — đăng ký provider một lần**

Thêm import và gọi trước `export { monaco }`:

```ts
import { registerSqlCompletion } from './sql-completion';
```
```ts
registerSqlCompletion(monaco);

export { monaco };
```

- [ ] **Step 2: `QueryPanel.tsx` — props + effect nạp metadata**

Thêm import:

```ts
import { setActiveSchema, clearActiveSchema } from '../sql-completion';
```

Mở rộng `Props`:

```ts
interface Props {
  connectionId: string;
  language: 'sql' | 'plaintext';
  placeholder: string;
  database?: string;
  schema?: string;
}
```

Cập nhật chữ ký component: `export function QueryPanel({ connectionId, language, placeholder, database, schema }: Props) {`

Thêm effect (sau effect tạo editor):

```ts
  // Nạp schema cho autocomplete khi là SQL và khi database/schema đổi.
  useEffect(() => {
    if (language !== 'sql') return;
    let cancelled = false;
    window.api
      .getSchemaObjects(connectionId, database, schema)
      .then((objs) => {
        if (!cancelled) setActiveSchema(objs);
      })
      .catch(() => {
        /* mất autocomplete không chặn gõ query */
      });
    return () => {
      cancelled = true;
      clearActiveSchema();
    };
  }, [connectionId, database, schema, language]);
```

- [ ] **Step 3: `App.tsx` — truyền database/schema**

Sửa chỗ render `<QueryPanel …/>` (dòng ~117). Chỉ truyền db/schema khi `dbSelection` thuộc đúng kết nối đang mở; fallback về database mặc định của kết nối:

```tsx
            <QueryPanel
              connectionId={session.connection.id}
              language={session.capabilities.sql ? 'sql' : 'plaintext'}
              placeholder={queryPlaceholder(session.capabilities)}
              database={
                dbSelection?.connectionId === session.connection.id
                  ? dbSelection.database ?? session.connection.database
                  : session.connection.database
              }
              schema={
                dbSelection?.connectionId === session.connection.id ? dbSelection.schema : undefined
              }
            />
```

- [ ] **Step 4: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: cả hai PASS.

- [ ] **Step 5: Smoke thủ công (khuyến nghị, cần DB SQL sống)**

Run `npm run dev`; mở kết nối MariaDB/Postgres, chọn một database ở sidebar, mở tab query:
- Gõ `SELECT * FROM ` → danh sách bảng hiện ra.
- Gõ `<tên_bảng>.` → cột của bảng đó.
- Gõ `SELECT * FROM users u WHERE u.` → cột của users.
Nếu không có DB SQL sống, bỏ qua (logic đã verify ở Task 2/3).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/monaco-setup.ts src/renderer/src/components/QueryPanel.tsx src/renderer/src/App.tsx
git commit -m "feat(sql-ac): nối autocomplete — provider 1 lần, QueryPanel nạp schema theo db đang chọn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- SQL-only → adapter method optional + handler trả `[]`; QueryPanel gate `language==='sql'` (Tasks 1/2/4). ✓
- Metadata theo database đang chọn (fallback db mặc định) → App truyền `dbSelection?.database ?? session.connection.database`, guard theo connectionId (Task 4). ✓
- Context-aware: FROM/JOIN→bảng, `x.`→cột (alias FROM/JOIN cấp một), khác→keyword+bảng → `computeSuggestions` (Task 3), verify 6 case gồm alias & case-insensitive. ✓
- 1 IPC gom bảng+cột → `getSchemaObjects` 1 query information_schema (Task 2). ✓
- Provider đăng ký một lần + active schema module-level → Task 3/4. ✓
- Fetch on open + on db change, cache in-memory, clear on unmount → effect deps `[connectionId, database, schema, language]` (Task 4). ✓

**Placeholder scan:** Không TBD/TODO; mọi step có code đầy đủ; harness có assertion cụ thể. ✓

**Type consistency:** `SchemaObject{table,columns}`, `getSchemaObjects(database?,schema?)`, `computeSuggestions(textUntilCursor, fullText, schema)`, `setActiveSchema/clearActiveSchema`, `registerSqlCompletion(monaco)` khớp giữa Tasks 1/2/3/4. Helper `groupColumnsByTable({t,c}[])` dùng chung 2 adapter (DRY, không trùng lặp logic block). ✓

**Giới hạn (khớp spec §6):** không refresh schema thủ công (đổi tab/mở lại để nạp lại); alias chỉ FROM/JOIN cấp một; một database; heuristic regex (không parser đầy đủ).
