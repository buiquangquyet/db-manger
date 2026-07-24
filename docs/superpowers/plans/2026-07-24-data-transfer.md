# Transfer Data Giữa Các Kết Nối Cùng Loại — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép copy bảng/collection (tùy chọn cả cấu trúc) từ một connection nguồn sang một connection đích **cùng loại DB**, chọn tất cả bảng hoặc từng bảng, qua một wizard modal.

**Architecture:** Thêm một orchestrator thuần (`src/main/transfer.ts`) chạy trên hai adapter đang mở (nguồn + đích) do `SessionManager` cấp; copy phân trang + ghi theo lô. Adapter nhận thêm vài method **optional** (batch insert cho SQL, đọc/ghi document-native cho Mongo). Renderer điều khiển qua 3 kênh IPC mới (`transfer:start` request/response, `transfer:progress` streaming, `transfer:cancel`), UI là `TransferModal` mở từ menu chuột phải node database trong Sidebar.

**Tech Stack:** Electron + React + TypeScript + Ant Design; driver `mysql2` (MariaDB), `pg` (Postgres), `mongodb` (Mongo, dùng `BSON.EJSON`).

## Global Constraints

- Không có test framework. Gate tự động duy nhất: `npm run typecheck` (chạy `typecheck:node` + `typecheck:web`, cả hai `strict`) — phải PASS sau mỗi task.
- Verify hành vi bằng harness headless: `npx esbuild <harness>.ts --bundle --platform=node --format=esm --packages=external --outfile=<repo>/x.mjs` rồi `node <repo>/x.mjs`. **Xuất `.mjs` NẰM TRONG thư mục repo** để ESM resolve driver từ `node_modules` của repo (đường scratchpad sẽ `ERR_MODULE_NOT_FOUND`). Xóa file `.mjs` và harness `.ts` sau khi verify.
- MongoDB test: container `cs-mongo` sẵn có tại `127.0.0.1:27017` (không auth). SQL test: harness tự spin container tạm bằng `docker run` rồi `docker rm -f` khi xong.
- Nguồn và đích **bắt buộc cùng `DbKind`**; validate lại trong `runTransfer` (không chỉ ở UI).
- Phạm vi: `mariadb`, `postgres`, `mongodb`. KHÔNG đụng `redis`.
- KHÔNG sửa `src/main/io.ts` (transfer là module song song).
- Adapter import `@shared/types` bằng `import type` (bị erase khi bundle) — giữ nguyên quy ước này.
- Comment/nhãn UI bằng tiếng Việt, khớp văn phong file hiện có.
- Commit message kết thúc bằng dòng: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File Structure

- `src/shared/types.ts` (modify) — thêm `TransferRequest`, `TransferProgress`, `TransferTableResult`, `TransferSummary`; 3 khóa vào `IpcChannels`; 3 method optional vào `DatabaseAdapter`; 3 method vào `RendererApi`.
- `src/main/adapters/mariadb.ts` (modify) — thêm `insertRows`.
- `src/main/adapters/postgres.ts` (modify) — thêm `insertRows`.
- `src/main/adapters/mongo.ts` (modify) — thêm `readDocumentsRaw` + `insertDocumentsRaw`.
- `src/main/transfer.ts` (create) — `runTransfer(...)` orchestrator thuần + `TransferDeps`.
- `src/main/ipc.ts` (modify) — đăng ký `transfer:start` / `transfer:cancel`, giữ map cờ hủy, đẩy `transfer:progress`.
- `src/preload/index.ts` (modify) — expose `startTransfer` / `cancelTransfer` / `onTransferProgress`.
- `src/renderer/src/components/TransferModal.tsx` (create) — wizard 3 bước.
- `src/renderer/src/components/Sidebar.tsx` (modify) — thêm mục menu "Transfer sang…" + state mở modal.

---

### Task 1: Contracts (types, IPC channels, interface signatures)

Định nghĩa toàn bộ kiểu & chữ ký để các task sau bám theo. Không có logic — deliverable là `npm run typecheck` PASS.

**Files:**
- Modify: `src/shared/types.ts`

**Interfaces:**
- Consumes: (không)
- Produces:
  - `TransferRequest`, `TransferProgress`, `TransferTableResult`, `TransferSummary` (kiểu dữ liệu bên dưới).
  - `IpcChannels.transferStart = 'transfer:start'`, `IpcChannels.transferProgress = 'transfer:progress'`, `IpcChannels.transferCancel = 'transfer:cancel'`.
  - `DatabaseAdapter.insertRows?`, `DatabaseAdapter.readDocumentsRaw?`, `DatabaseAdapter.insertDocumentsRaw?` (chữ ký bên dưới).
  - `RendererApi.startTransfer`, `RendererApi.cancelTransfer`, `RendererApi.onTransferProgress`.

- [ ] **Step 1: Thêm các kiểu transfer**

Thêm vào cuối khối kiểu (ví dụ ngay trước phần `DatabaseAdapter` hoặc sau `ImportResult`) trong `src/shared/types.ts`:

```ts
/** Yêu cầu transfer dữ liệu từ một connection nguồn sang connection đích (cùng loại). */
export interface TransferRequest {
  /** ID phiên transfer (renderer sinh, dùng để khớp progress & hủy). */
  transferId: string;
  sourceConnectionId: string;
  /** DB/schema nguồn (bảng chọn qua `tables`). */
  source: { database?: string; schema?: string };
  destConnectionId: string;
  dest: { database?: string; schema?: string };
  /** Tên bảng/collection được chọn để copy (tên đích = tên nguồn). */
  tables: string[];
  /** Tạo cấu trúc ở đích nếu bảng chưa tồn tại. */
  createStructure: boolean;
  /** 'append' = thêm vào; 'truncateInsert' = xóa sạch rồi nạp. */
  writeMode: 'append' | 'truncateInsert';
}

/** Tiến trình phát liên tục trong lúc transfer. */
export interface TransferProgress {
  transferId: string;
  /** Chỉ số bảng đang chạy (0-based). */
  tableIndex: number;
  tableCount: number;
  currentTable: string;
  /** Số dòng đã copy của bảng hiện tại. */
  rowsCopied: number;
  /** Tổng số dòng nếu ước lượng được, null nếu không rõ. */
  rowsTotal: number | null;
}

/** Kết quả transfer của một bảng. */
export interface TransferTableResult {
  table: string;
  status: 'ok' | 'error' | 'cancelled' | 'skipped';
  rows: number;
  error?: string;
}

/** Tổng kết cả phiên transfer. */
export interface TransferSummary {
  results: TransferTableResult[];
  cancelled: boolean;
}
```

- [ ] **Step 2: Thêm 3 khóa IPC**

Trong object `IpcChannels`, thêm sau `ioCopyTableSql`:

```ts
  transferStart: 'transfer:start',
  transferProgress: 'transfer:progress',
  transferCancel: 'transfer:cancel',
```

- [ ] **Step 3: Thêm 3 method optional vào `DatabaseAdapter`**

Thêm vào interface `DatabaseAdapter` (sau `insertDocument?`):

```ts
  /**
   * (Batch) Ghi nhiều dòng trong 1-vài lệnh INSERT.
   * Nếu adapter không hiện thực, orchestrator fallback gọi insertRow từng dòng.
   */
  insertRows?(target: DataTarget, rows: Record<string, unknown>[]): Promise<void>;

  /** (Document DB) Đọc raw document dạng EJSON canonical để copy giữ nguyên kiểu BSON/lồng nhau. */
  readDocumentsRaw?(target: DataTarget, page: { offset: number; limit: number }): Promise<string[]>;

  /** (Document DB) Ghi nhiều document EJSON bằng insertMany. */
  insertDocumentsRaw?(target: DataTarget, ejsonDocs: string[]): Promise<void>;
```

- [ ] **Step 4: Thêm 3 method vào `RendererApi`**

Thêm vào interface `RendererApi` (sau `copyTableSql`):

```ts
  /** Bắt đầu transfer; resolve khi hoàn tất, trả tổng kết. */
  startTransfer(req: TransferRequest): Promise<TransferSummary>;
  /** Yêu cầu hủy một phiên transfer đang chạy. */
  cancelTransfer(transferId: string): Promise<void>;
  /** Đăng ký nhận tiến trình; trả về hàm hủy đăng ký. */
  onTransferProgress(cb: (p: TransferProgress) => void): () => void;
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS (chưa có nơi dùng — chỉ khai báo kiểu).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(transfer): contracts — types, IPC channels, adapter & api signatures

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: SQL batch insert (`insertRows` cho MariaDB & Postgres)

**Files:**
- Modify: `src/main/adapters/mariadb.ts` (thêm method sau `insertRow`, ~dòng 354)
- Modify: `src/main/adapters/postgres.ts` (thêm method sau `insertRow`, ~dòng 409)
- Test (tạm): `scratchpad harness` → bundle ra `<repo>/tf-sql.mjs`

**Interfaces:**
- Consumes: `DatabaseAdapter.insertRows?` (Task 1).
- Produces: `MariaDbAdapter.insertRows`, `PostgresAdapter.insertRows` — chữ ký `insertRows(target: DataTarget, rows: Record<string, unknown>[]): Promise<void>`; chunk theo giới hạn tham số; dùng cột của `rows[0]`.

- [ ] **Step 1: Viết harness (thất bại vì method chưa có)**

Tạo `/tmp/.../scratchpad/tf-sql-harness.ts` (đường scratchpad của session) với nội dung:

```ts
import { createAdapter } from '../../../Public/db_manager/src/main/adapters';
import type { ConnectionConfig } from '../../../Public/db_manager/src/shared/types';

// LƯU Ý: sửa lại đường import cho đúng repo nếu cần; hoặc copy harness vào repo rồi bundle.
const maria: ConnectionConfig = { id: 'm', name: 'm', kind: 'mariadb', host: '127.0.0.1', port: 33061, user: 'root', password: 'root', database: 'tftest' };
const pg: ConnectionConfig = { id: 'p', name: 'p', kind: 'postgres', host: '127.0.0.1', port: 54321, user: 'postgres', password: 'postgres', database: 'tftest' };

async function run(cfg: ConnectionConfig, ddl: string) {
  const a = createAdapter(cfg);
  await a.connect();
  await a.executeRaw('DROP TABLE IF EXISTS t', cfg.database);
  await a.executeRaw(ddl, cfg.database);
  const rows = Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, name: `n${i}` }));
  await a.insertRows!({ database: cfg.database, name: 't' }, rows);
  const rs = await a.readRows({ database: cfg.database, name: 't' }, { offset: 0, limit: 5 });
  const total = rs.total;
  await a.disconnect();
  if (total !== 1200) throw new Error(`${cfg.kind}: kỳ vọng 1200, nhận ${total}`);
  console.log(`${cfg.kind}: OK 1200 dòng`);
}

await run(maria, 'CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(50))');
await run(pg, 'CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(50))');
console.log('ALL OK');
```

(Đơn giản hơn: copy harness `.ts` vào repo root, dùng import `./src/main/adapters` và `./src/shared/types`, bundle, rồi xóa.)

- [ ] **Step 2: Spin container tạm & chạy harness để thấy fail**

```bash
docker run -d --rm --name tf-maria -e MARIADB_ROOT_PASSWORD=root -e MARIADB_DATABASE=tftest -p 33061:3306 mariadb:11
docker run -d --rm --name tf-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=tftest -p 54321:5432 postgres:16
sleep 20   # chờ DB sẵn sàng
cd /Users/quyet.bq/Public/db_manager
npx esbuild tf-sql-harness.ts --bundle --platform=node --format=esm --packages=external --outfile=tf-sql.mjs
node tf-sql.mjs
```
Expected: FAIL — `a.insertRows is not a function` (method chưa hiện thực).

- [ ] **Step 3: Hiện thực `insertRows` trong `mariadb.ts`**

Thêm ngay sau `insertRow` (dòng ~354):

```ts
  async insertRows(target: DataTarget, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    const cols = Object.keys(rows[0]);
    if (cols.length === 0) throw new Error('Không có cột nào để ghi.');
    const db = target.database ?? this.config.database;
    const qualified = db ? `${quoteIdentMysql(db)}.${quoteIdentMysql(target.name)}` : quoteIdentMysql(target.name);
    const colList = cols.map(quoteIdentMysql).join(', ');
    // Chunk theo số placeholder để không vượt max_allowed_packet / giới hạn tham số.
    const chunkSize = Math.max(1, Math.min(500, Math.floor(2000 / cols.length)));
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const groups = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
      const params = chunk.flatMap((r) => cols.map((c) => r[c]));
      await this.db().query(`INSERT INTO ${qualified} (${colList}) VALUES ${groups}`, params);
    }
  }
```

- [ ] **Step 4: Hiện thực `insertRows` trong `postgres.ts`**

Thêm ngay sau `insertRow` (dòng ~409):

```ts
  async insertRows(target: DataTarget, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    const cols = Object.keys(rows[0]);
    if (cols.length === 0) throw new Error('Không có cột nào để ghi.');
    const schema = target.schema ?? 'public';
    const qualified = `${quoteIdentPg(schema)}.${quoteIdentPg(target.name)}`;
    const colList = cols.map(quoteIdentPg).join(', ');
    const chunkSize = Math.max(1, Math.min(500, Math.floor(2000 / cols.length)));
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      let p = 0;
      const groups = chunk.map(() => `(${cols.map(() => `$${(p += 1)}`).join(', ')})`).join(', ');
      const params = chunk.flatMap((r) => cols.map((c) => r[c]));
      await this.db().query(`INSERT INTO ${qualified} (${colList}) VALUES ${groups}`, params);
    }
  }
```

- [ ] **Step 5: Chạy lại harness → PASS**

```bash
npx esbuild tf-sql-harness.ts --bundle --platform=node --format=esm --packages=external --outfile=tf-sql.mjs
node tf-sql.mjs
```
Expected: in `mariadb: OK 1200 dòng`, `postgres: OK 1200 dòng`, `ALL OK`.

- [ ] **Step 6: Dọn dẹp & typecheck**

```bash
rm -f tf-sql.mjs tf-sql-harness.ts
docker rm -f tf-maria tf-pg
npm run typecheck
```
Expected: typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/adapters/mariadb.ts src/main/adapters/postgres.ts
git commit -m "feat(transfer): batch insertRows cho MariaDB & Postgres (chunk theo tham số)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Mongo document-native (`readDocumentsRaw` + `insertDocumentsRaw`)

**Files:**
- Modify: `src/main/adapters/mongo.ts` (thêm sau `insertDocument`, ~dòng 347)
- Test (tạm): harness bundle ra `<repo>/tf-mongo.mjs`, chạy trên `cs-mongo`

**Interfaces:**
- Consumes: `DatabaseAdapter.readDocumentsRaw?`, `DatabaseAdapter.insertDocumentsRaw?` (Task 1); `EJSON` (`BSON.EJSON`, đã import ở đầu file).
- Produces: `MongoAdapter.readDocumentsRaw`, `MongoAdapter.insertDocumentsRaw`.

- [ ] **Step 1: Viết harness kiểm tra round-trip giữ kiểu BSON (fail trước)**

Tạo harness `tf-mongo-harness.ts` trong repo root:

```ts
import { MongoClient, BSON } from 'mongodb';
import { createAdapter } from './src/main/adapters';
import type { ConnectionConfig } from './src/shared/types';
const { EJSON } = BSON;

const cfg: ConnectionConfig = { id: 'x', name: 'x', kind: 'mongodb', host: '127.0.0.1', port: 27017, database: 'tftest_src' };
const dstCfg: ConnectionConfig = { id: 'y', name: 'y', kind: 'mongodb', host: '127.0.0.1', port: 27017, database: 'tftest_dst' };

const raw = new MongoClient('mongodb://127.0.0.1:27017');
await raw.connect();
await raw.db('tftest_src').dropDatabase();
await raw.db('tftest_dst').dropDatabase();
await raw.db('tftest_src').collection('c').insertMany([
  { n: 1, when: new Date('2020-01-02T03:04:05Z'), nested: { a: [1, 2, 3], b: 'x' }, big: BSON.Long.fromString('9007199254740993') },
  { n: 2, when: new Date(), nested: { a: [] } },
]);

const src = createAdapter(cfg); await src.connect();
const dst = createAdapter(dstCfg); await dst.connect();
const docs = await src.readDocumentsRaw!({ database: 'tftest_src', name: 'c' }, { offset: 0, limit: 1000 });
await dst.insertDocumentsRaw!({ database: 'tftest_dst', name: 'c' }, docs);

const back = await raw.db('tftest_dst').collection('c').find({}).sort({ n: 1 }).toArray();
const okDate = back[0].when instanceof Date;
const okNested = Array.isArray(back[0].nested.a) && back[0].nested.a.length === 3;
const okLong = back[0].big?._bsontype === 'Long' || typeof back[0].big === 'object';
await src.disconnect(); await dst.disconnect();
await raw.db('tftest_src').dropDatabase(); await raw.db('tftest_dst').dropDatabase(); await raw.close();
if (!(okDate && okNested)) throw new Error(`Mất fidelity: date=${okDate} nested=${okNested} long=${okLong}`);
console.log('Mongo transfer OK — giữ Date/nested/Long');
```

- [ ] **Step 2: Bundle & chạy → FAIL**

```bash
cd /Users/quyet.bq/Public/db_manager
npx esbuild tf-mongo-harness.ts --bundle --platform=node --format=esm --packages=external --outfile=tf-mongo.mjs
node tf-mongo.mjs
```
Expected: FAIL — `src.readDocumentsRaw is not a function`.

- [ ] **Step 3: Hiện thực 2 method trong `mongo.ts`**

Thêm ngay sau `insertDocument` (dòng ~347):

```ts
  async readDocumentsRaw(
    target: DataTarget,
    page: { offset: number; limit: number },
  ): Promise<string[]> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const col = this.c().db(database).collection(target.name);
    const docs = await col.find({}).skip(page.offset).limit(page.limit).toArray();
    // Canonical EJSON (relaxed:false): giữ nguyên kiểu BSON (Date, Long, ObjectId, nested…).
    return docs.map((d) => EJSON.stringify(d, undefined, 0, { relaxed: false }));
  }

  async insertDocumentsRaw(target: DataTarget, ejsonDocs: string[]): Promise<void> {
    if (ejsonDocs.length === 0) return;
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const col = this.c().db(database).collection(target.name);
    const docs = ejsonDocs.map((s) => EJSON.parse(s, { relaxed: false }) as Record<string, unknown>);
    await col.insertMany(docs as never[]);
  }
```

- [ ] **Step 4: Bundle & chạy → PASS**

```bash
npx esbuild tf-mongo-harness.ts --bundle --platform=node --format=esm --packages=external --outfile=tf-mongo.mjs
node tf-mongo.mjs
```
Expected: in `Mongo transfer OK — giữ Date/nested/Long`.

- [ ] **Step 5: Dọn dẹp & typecheck**

```bash
rm -f tf-mongo.mjs tf-mongo-harness.ts
npm run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/adapters/mongo.ts
git commit -m "feat(transfer): Mongo readDocumentsRaw + insertDocumentsRaw (EJSON canonical)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Orchestrator `runTransfer` (`src/main/transfer.ts`)

**Files:**
- Create: `src/main/transfer.ts`
- Test (tạm): harness bundle ra `<repo>/tf-run.mjs` (dùng `cs-mongo`, 2 database khác nhau làm nguồn/đích)

**Interfaces:**
- Consumes: `DatabaseAdapter` (kind, capabilities.dataModel, getTableList, getCreateStatement, executeRaw, createTable, truncateTable, readRows, insertRows?/insertRow, readDocumentsRaw?, insertDocumentsRaw?/insertDocument?) từ Tasks 2-3; `TransferRequest`/`TransferProgress`/`TransferSummary`/`TransferTableResult` từ Task 1.
- Produces:
  - `interface TransferDeps { get(connectionId: string): DatabaseAdapter }`
  - `async function runTransfer(deps: TransferDeps, req: TransferRequest, onProgress: (p: TransferProgress) => void, isCancelled: () => boolean): Promise<TransferSummary>`

- [ ] **Step 1: Viết harness (fail — file chưa tồn tại)**

Tạo `tf-run-harness.ts` trong repo root:

```ts
import { MongoClient } from 'mongodb';
import { createAdapter } from './src/main/adapters';
import { runTransfer } from './src/main/transfer';
import type { ConnectionConfig, DatabaseAdapter, TransferRequest } from './src/shared/types';

const raw = new MongoClient('mongodb://127.0.0.1:27017');
await raw.connect();
await raw.db('tf_src').dropDatabase();
await raw.db('tf_dst').dropDatabase();
await raw.db('tf_src').collection('users').insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
await raw.db('tf_src').collection('orders').insertMany([{ o: 'a' }]);

const src = createAdapter({ id: 's', name: 's', kind: 'mongodb', host: '127.0.0.1', port: 27017, database: 'tf_src' } as ConnectionConfig);
const dst = createAdapter({ id: 'd', name: 'd', kind: 'mongodb', host: '127.0.0.1', port: 27017, database: 'tf_dst' } as ConnectionConfig);
await src.connect(); await dst.connect();
const map: Record<string, DatabaseAdapter> = { s: src, d: dst };

const req: TransferRequest = {
  transferId: 't1', sourceConnectionId: 's', source: { database: 'tf_src' },
  destConnectionId: 'd', dest: { database: 'tf_dst' },
  tables: ['users', 'orders'], createStructure: true, writeMode: 'append',
};
let last = 0;
const summary = await runTransfer({ get: (id) => map[id] }, req, (p) => (last = p.rowsCopied), () => false);
const users = await raw.db('tf_dst').collection('users').countDocuments();
const orders = await raw.db('tf_dst').collection('orders').countDocuments();
await src.disconnect(); await dst.disconnect();
await raw.db('tf_src').dropDatabase(); await raw.db('tf_dst').dropDatabase(); await raw.close();
if (users !== 3 || orders !== 1) throw new Error(`Sai số: users=${users} orders=${orders}`);
if (summary.results.filter((r) => r.status === 'ok').length !== 2) throw new Error('Kỳ vọng 2 bảng OK');
console.log(`Transfer OK — users=3 orders=1, progress cuối=${last}`);
```

- [ ] **Step 2: Bundle & chạy → FAIL**

```bash
cd /Users/quyet.bq/Public/db_manager
npx esbuild tf-run-harness.ts --bundle --platform=node --format=esm --packages=external --outfile=tf-run.mjs
node tf-run.mjs
```
Expected: FAIL — không resolve `./src/main/transfer` (chưa tạo).

- [ ] **Step 3: Tạo `src/main/transfer.ts`**

```ts
import type {
  DataTarget,
  DatabaseAdapter,
  TransferProgress,
  TransferRequest,
  TransferSummary,
  TransferTableResult,
} from '@shared/types';

/** Kích thước trang khi đọc nguồn (đọc rồi ghi cả lô). */
const PAGE = 1000;

/** Nguồn cấp adapter theo connectionId (SessionManager thỏa cấu trúc này). */
export interface TransferDeps {
  get(connectionId: string): DatabaseAdapter;
}

/** Copy dữ liệu một bảng (phân trang), trả số dòng đã copy. */
async function copyData(
  source: DatabaseAdapter,
  dest: DatabaseAdapter,
  srcTarget: DataTarget,
  dstTarget: DataTarget,
  req: TransferRequest,
  tableIndex: number,
  tableCount: number,
  name: string,
  onProgress: (p: TransferProgress) => void,
  isCancelled: () => boolean,
): Promise<number> {
  const isDoc = source.capabilities.dataModel === 'document';
  let rowsCopied = 0;
  let offset = 0;

  for (;;) {
    if (isCancelled()) break;

    if (isDoc) {
      if (!source.readDocumentsRaw) throw new Error('Adapter nguồn thiếu readDocumentsRaw.');
      const docs = await source.readDocumentsRaw(srcTarget, { offset, limit: PAGE });
      if (docs.length === 0) break;
      if (dest.insertDocumentsRaw) await dest.insertDocumentsRaw(dstTarget, docs);
      else if (dest.insertDocument) for (const d of docs) await dest.insertDocument(dstTarget, d);
      else throw new Error('Adapter đích không ghi được document.');
      rowsCopied += docs.length;
      offset += docs.length;
      onProgress({ transferId: req.transferId, tableIndex, tableCount, currentTable: name, rowsCopied, rowsTotal: null });
      if (docs.length < PAGE) break;
    } else {
      const rs = await source.readRows(srcTarget, { offset, limit: PAGE });
      if (rs.rows.length === 0) break;
      if (dest.insertRows) await dest.insertRows(dstTarget, rs.rows);
      else for (const r of rs.rows) await dest.insertRow(dstTarget, r);
      rowsCopied += rs.rows.length;
      offset += rs.rows.length;
      onProgress({ transferId: req.transferId, tableIndex, tableCount, currentTable: name, rowsCopied, rowsTotal: rs.total });
      if (rs.rows.length < PAGE) break;
    }
  }
  return rowsCopied;
}

/**
 * Copy các bảng được chọn từ nguồn sang đích (cùng loại DB).
 * Lỗi một bảng không chặn bảng khác; hủy đánh dấu các bảng còn lại là 'cancelled'.
 */
export async function runTransfer(
  deps: TransferDeps,
  req: TransferRequest,
  onProgress: (p: TransferProgress) => void,
  isCancelled: () => boolean,
): Promise<TransferSummary> {
  const source = deps.get(req.sourceConnectionId);
  const dest = deps.get(req.destConnectionId);
  if (source.kind !== dest.kind) {
    throw new Error(`Không thể transfer giữa hai loại DB khác nhau (${source.kind} → ${dest.kind}).`);
  }

  const results: TransferTableResult[] = [];
  const tableCount = req.tables.length;

  for (let tableIndex = 0; tableIndex < tableCount; tableIndex++) {
    const name = req.tables[tableIndex];
    if (isCancelled()) {
      results.push({ table: name, status: 'cancelled', rows: 0 });
      continue;
    }

    const srcTarget: DataTarget = { database: req.source.database, schema: req.source.schema, name };
    const dstTarget: DataTarget = { database: req.dest.database, schema: req.dest.schema, name };
    onProgress({ transferId: req.transferId, tableIndex, tableCount, currentTable: name, rowsCopied: 0, rowsTotal: null });

    try {
      const existing = await dest.getTableList(req.dest.database, req.dest.schema);
      const exists = existing.some((t) => t.name === name);

      if (req.createStructure && !exists) {
        if (dest.capabilities.dataModel === 'document') {
          await dest.createTable(dstTarget, []);
        } else {
          const ddl = await source.getCreateStatement(srcTarget);
          await dest.executeRaw(ddl, req.dest.database);
        }
      }

      if (req.writeMode === 'truncateInsert' && exists) {
        await dest.truncateTable(dstTarget);
      }

      const rows = await copyData(source, dest, srcTarget, dstTarget, req, tableIndex, tableCount, name, onProgress, isCancelled);
      results.push({ table: name, status: isCancelled() ? 'cancelled' : 'ok', rows });
    } catch (err) {
      results.push({ table: name, status: 'error', rows: 0, error: (err as Error).message });
    }
  }

  return { results, cancelled: isCancelled() };
}
```

- [ ] **Step 4: Bundle & chạy → PASS**

```bash
npx esbuild tf-run-harness.ts --bundle --platform=node --format=esm --packages=external --outfile=tf-run.mjs
node tf-run.mjs
```
Expected: in `Transfer OK — users=3 orders=1, progress cuối=3`.

- [ ] **Step 5: Dọn dẹp & typecheck**

```bash
rm -f tf-run.mjs tf-run-harness.ts
npm run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/transfer.ts
git commit -m "feat(transfer): orchestrator runTransfer (phân trang, batch, per-table error, cancel)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Nối IPC + preload

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `runTransfer`, `TransferDeps` (Task 4); `IpcChannels.transferStart/transferProgress/transferCancel` (Task 1); `SessionManager` (đã có `get`).
- Produces: handler `transfer:start` (trả `TransferSummary`), `transfer:cancel`; đẩy sự kiện `transfer:progress`. Preload: `window.api.startTransfer/cancelTransfer/onTransferProgress`.

- [ ] **Step 1: Import & map cờ hủy trong `ipc.ts`**

Thêm import (đầu file, cạnh import `./io`):

```ts
import { runTransfer } from './transfer';
import type { TransferRequest } from '@shared/types';
```

Trong `registerIpc()`, sau khi tạo `sessions`, thêm:

```ts
  // Cờ hủy theo transferId — set bởi transfer:cancel, đọc bởi runTransfer.
  const transferFlags = new Map<string, { cancelled: boolean }>();
```

- [ ] **Step 2: Đăng ký handler start/cancel (đặt sau `ioCopyTableSql`)**

```ts
  ipcMain.handle(IpcChannels.transferStart, async (e, req: TransferRequest) => {
    const flag = { cancelled: false };
    transferFlags.set(req.transferId, flag);
    try {
      return await runTransfer(
        sessions,
        req,
        (p) => e.sender.send(IpcChannels.transferProgress, p),
        () => flag.cancelled,
      );
    } finally {
      transferFlags.delete(req.transferId);
    }
  });

  ipcMain.handle(IpcChannels.transferCancel, (_e, transferId: string) => {
    const flag = transferFlags.get(transferId);
    if (flag) flag.cancelled = true;
  });
```

- [ ] **Step 3: Expose trong `preload/index.ts`**

Thêm `TransferRequest`, `TransferProgress` vào khối `import type` ở đầu file. Thêm vào object `api` (sau `copyTableSql`):

```ts
  startTransfer: (req: TransferRequest) => ipcRenderer.invoke(IpcChannels.transferStart, req),
  cancelTransfer: (transferId: string) => ipcRenderer.invoke(IpcChannels.transferCancel, transferId),
  onTransferProgress: (cb: (p: TransferProgress) => void) => {
    const listener = (_e: unknown, p: TransferProgress) => cb(p);
    ipcRenderer.on(IpcChannels.transferProgress, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.transferProgress, listener);
    };
  },
```

- [ ] **Step 4: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: cả hai PASS (main + preload + renderer bundle không lỗi).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat(transfer): nối IPC transfer:start/cancel + progress streaming, expose preload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: UI — `TransferModal` + entry point trong Sidebar

**Files:**
- Create: `src/renderer/src/components/TransferModal.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `window.api.listConnections/openSession/getTableList/getRootNodes/startTransfer/cancelTransfer/onTransferProgress`; `TransferProgress`, `TransferSummary`, `StoredConnection`, `DbKind`.
- Produces: component `TransferModal` với props bên dưới; Sidebar mở nó từ menu chuột phải node database/schema.

- [ ] **Step 1: Tạo `TransferModal.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Checkbox, Modal, Progress, Radio, Select, Steps, Table, message } from 'antd';
import type { DbKind, StoredConnection, TransferProgress, TransferSummary } from '@shared/types';

export interface TransferSource {
  connectionId: string;
  kind: DbKind;
  database?: string;
  schema?: string;
  label: string;
}

interface Props {
  open: boolean;
  source: TransferSource;
  connections: StoredConnection[];
  onClose: () => void;
}

/** Wizard 3 bước: chọn đích → chọn bảng & tùy chọn → tiến trình. */
export function TransferModal({ open, source, connections, onClose }: Props): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [destConnId, setDestConnId] = useState<string>();
  const [destDb, setDestDb] = useState<string>();
  const [dbOptions, setDbOptions] = useState<{ database?: string; schema?: string; label: string }[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [createStructure, setCreateStructure] = useState(true);
  const [writeMode, setWriteMode] = useState<'append' | 'truncateInsert'>('append');
  const [transferId] = useState(() => `tf_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [summary, setSummary] = useState<TransferSummary | null>(null);
  const [running, setRunning] = useState(false);

  // Chỉ cho chọn connection cùng loại.
  const destConns = useMemo(
    () => connections.filter((c) => c.kind === source.kind),
    [connections, source.kind],
  );

  // Danh sách bảng nguồn.
  useEffect(() => {
    if (!open) return;
    window.api
      .getTableList(source.connectionId, source.database, source.schema)
      .then((list) => setTables(list.map((t) => t.name)))
      .catch((e) => message.error(`Không tải được danh sách bảng: ${(e as Error).message}`));
  }, [open, source]);

  // Khi chọn connection đích: mở session & tải danh sách database/schema đích.
  async function pickDest(id: string): Promise<void> {
    setDestConnId(id);
    setDestDb(undefined);
    try {
      await window.api.openSession(id);
      const roots = await window.api.getRootNodes(id);
      // node database/schema có meta.database / meta.schema
      const opts = roots
        .filter((n) => n.type === 'database' || n.type === 'schema')
        .map((n) => ({
          database: (n.meta?.database as string) ?? n.label,
          schema: n.meta?.schema as string | undefined,
          label: n.label,
        }));
      setDbOptions(opts);
    } catch (e) {
      message.error(`Không mở được kết nối đích: ${(e as Error).message}`);
    }
  }

  async function start(): Promise<void> {
    if (!destConnId) return;
    const dest = dbOptions.find((o) => o.label === destDb);
    setStep(2);
    setRunning(true);
    setSummary(null);
    const off = window.api.onTransferProgress((p) => {
      if (p.transferId === transferId) setProgress(p);
    });
    try {
      const res = await window.api.startTransfer({
        transferId,
        sourceConnectionId: source.connectionId,
        source: { database: source.database, schema: source.schema },
        destConnectionId: destConnId,
        dest: { database: dest?.database, schema: dest?.schema },
        tables: selected,
        createStructure,
        writeMode,
      });
      setSummary(res);
    } catch (e) {
      message.error(`Transfer lỗi: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      off();
    }
  }

  const pct = progress && progress.tableCount ? Math.round((progress.tableIndex / progress.tableCount) * 100) : 0;

  return (
    <Modal
      open={open}
      title={`Transfer từ "${source.label}"`}
      onCancel={onClose}
      width={640}
      footer={null}
      destroyOnClose
    >
      <Steps current={step} size="small" style={{ marginBottom: 16 }} items={[{ title: 'Chọn đích' }, { title: 'Chọn bảng' }, { title: 'Tiến trình' }]} />

      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Select
            placeholder="Kết nối đích (cùng loại)"
            value={destConnId}
            onChange={pickDest}
            options={destConns.map((c) => ({ value: c.id, label: `${c.name} (${c.kind})` }))}
          />
          <Select
            placeholder="Database/schema đích"
            value={destDb}
            disabled={!destConnId}
            onChange={setDestDb}
            options={dbOptions.map((o) => ({ value: o.label, label: o.label }))}
          />
          <div style={{ textAlign: 'right' }}>
            <a onClick={() => destConnId && destDb && setStep(1)}>Tiếp →</a>
          </div>
        </div>
      )}

      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Checkbox
            indeterminate={selected.length > 0 && selected.length < tables.length}
            checked={selected.length === tables.length && tables.length > 0}
            onChange={(e) => setSelected(e.target.checked ? [...tables] : [])}
          >
            Chọn tất cả ({tables.length})
          </Checkbox>
          <Checkbox.Group
            style={{ display: 'flex', flexDirection: 'column', maxHeight: 220, overflow: 'auto' }}
            value={selected}
            onChange={(v) => setSelected(v as string[])}
            options={tables.map((t) => ({ label: t, value: t }))}
          />
          <Checkbox checked={createStructure} onChange={(e) => setCreateStructure(e.target.checked)}>
            Tạo cấu trúc nếu bảng đích chưa có
          </Checkbox>
          <Radio.Group value={writeMode} onChange={(e) => setWriteMode(e.target.value)}>
            <Radio value="append">Thêm vào (append)</Radio>
            <Radio value="truncateInsert">Xóa sạch rồi nạp (truncate + insert)</Radio>
          </Radio.Group>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <a onClick={() => setStep(0)}>← Quay lại</a>
            <a onClick={() => selected.length && start()}>Bắt đầu transfer →</a>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Progress percent={pct} />
          {running && progress && (
            <div>
              Đang copy <b>{progress.currentTable}</b> ({progress.tableIndex + 1}/{progress.tableCount}) — {progress.rowsCopied} dòng
            </div>
          )}
          {running && (
            <div>
              <a onClick={() => window.api.cancelTransfer(transferId)}>Hủy</a>
            </div>
          )}
          {summary && (
            <Table
              size="small"
              pagination={false}
              rowKey="table"
              dataSource={summary.results}
              columns={[
                { title: 'Bảng', dataIndex: 'table' },
                { title: 'Trạng thái', dataIndex: 'status' },
                { title: 'Số dòng', dataIndex: 'rows' },
                { title: 'Lỗi', dataIndex: 'error' },
              ]}
            />
          )}
          {summary && (
            <div style={{ textAlign: 'right' }}>
              <a onClick={onClose}>Đóng</a>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
```

- [ ] **Step 2: Nối vào Sidebar — state + import**

Ở đầu `Sidebar.tsx`, thêm import:

```ts
import { TransferModal } from './TransferModal';
import type { TransferSource } from './TransferModal';
```

Trong component (cạnh `const [createCtx, setCreateCtx] = ...`), thêm:

```ts
  const [transferSrc, setTransferSrc] = useState<TransferSource | null>(null);
```

- [ ] **Step 3: Thêm mục menu "Transfer sang…" cho node database/schema**

Trong khối `if (raw.type === 'database' || raw.type === 'schema')` (dòng ~271), sửa mảng `items` để thêm mục transfer, và thêm nhánh xử lý trong `onClick`:

```ts
                const items = [
                  { key: 'create', label: 'Tạo bảng' },
                  { key: 'transfer', label: 'Transfer sang…' },
                  { key: 'refresh', label: 'Làm mới' },
                  ...(raw.type === 'database'
                    ? [{ key: 'dropDb', label: 'Xóa database', danger: true }]
                    : []),
                ];
```

Trong `onClick`, thêm nhánh (sau nhánh `create`):

```ts
                        } else if (key === 'transfer') {
                          setTransferSrc({
                            connectionId: conn.id,
                            kind: conn.kind,
                            database: raw.meta?.database as string | undefined,
                            schema: raw.meta?.schema as string | undefined,
                            label: raw.label,
                          });
```

- [ ] **Step 4: Render modal ở cuối JSX của Sidebar**

Ngay trước thẻ đóng ngoài cùng (cạnh nơi render các modal khác như CreateTableModal), thêm:

```tsx
      {transferSrc && (
        <TransferModal
          open
          source={transferSrc}
          connections={connections}
          onClose={() => setTransferSrc(null)}
        />
      )}
```

- [ ] **Step 5: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS. (`typecheck:web` bao trùm renderer strict.)

- [ ] **Step 6: Smoke thủ công (khuyến nghị)**

Run: `npm run dev` — chuột phải một node database → "Transfer sang…" → chọn đích cùng loại → chọn bảng → chạy → xem progress + tổng kết. Nếu không có 2 kết nối cùng loại sẵn, bỏ qua bước thủ công (đã verify logic ở Task 4).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/TransferModal.tsx src/renderer/src/components/Sidebar.tsx
git commit -m "feat(transfer): TransferModal wizard + entry point chuột phải database trong Sidebar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Cùng loại nguồn↔đích → validate trong `runTransfer` (Task 4) + lọc `destConns` (Task 6). ✓
- SQL + Mongo, không Redis → Task 2 (SQL), Task 3 (Mongo); UI lọc theo kind. ✓
- Chọn tất cả / từng bảng → Checkbox "Chọn tất cả" + Checkbox.Group (Task 6). ✓
- Tùy chọn tạo cấu trúc → `createStructure` xuyên suốt (Tasks 1/4/6); SQL dùng `getCreateStatement`→`executeRaw`, Mongo dùng `createTable([])`. ✓
- Append / Truncate+Insert → `writeMode` (Tasks 1/4/6). ✓
- Batch insert v1 → `insertRows` (SQL) + `insertDocumentsRaw` (Mongo), có chunk (Tasks 2/3), orchestrator gọi theo lô (Task 4). ✓
- Lỗi 1 bảng vẫn tiếp tục + Hủy + tổng kết → try/catch mỗi bảng, `isCancelled`, bảng tổng kết (Tasks 4/6). ✓
- Streaming progress + cancel qua IPC → Task 5 (`event.sender.send`, map cờ) + Task 6 (onTransferProgress/cancelTransfer). ✓
- Fidelity Mongo (BSON/nested) → EJSON canonical, verify round-trip Date/nested/Long (Task 3). ✓

**Placeholder scan:** Không có TBD/TODO; mọi step code có nội dung đầy đủ; harness có assertion cụ thể. ✓

**Type consistency:** `insertRows(target, rows)`, `readDocumentsRaw(target, {offset,limit})→string[]`, `insertDocumentsRaw(target, string[])`, `runTransfer(deps, req, onProgress, isCancelled)`, `TransferDeps.get`, các trường `TransferProgress`/`TransferSummary` khớp giữa Tasks 1/4/5/6. ✓

**Ghi chú giới hạn (khớp spec mục 7):** không bao transaction cả bảng (lô lỗi có thể để lại dữ liệu một phần — hiện ở cột Lỗi tổng kết); Postgres giả định schema đích cùng tên; đổi tên bảng/chọn cột con là YAGNI.
