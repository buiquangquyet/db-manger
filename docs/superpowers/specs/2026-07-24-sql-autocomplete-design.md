# Thiết kế: SQL autocomplete theo schema

Ngày: 2026-07-24
Trạng thái: Đã duyệt thiết kế, chờ viết plan.

## 1. Mục tiêu & phạm vi

Thêm gợi ý (autocomplete) **context-aware** cho ô SQL trong `QueryPanel`, dựa trên
schema thật của database đang chọn: gợi ý tên bảng, tên cột và từ khóa SQL đúng ngữ
cảnh con trỏ.

Phạm vi v1:

- Chỉ áp dụng cho kết nối **SQL** (MariaDB, Postgres) — nơi `QueryPanel` dùng
  `language === 'sql'`. Mongo/Redis (`plaintext`) không có autocomplete schema.
- Metadata (bảng + cột) lấy theo **database/schema đang chọn ở sidebar**, fallback
  về database mặc định của kết nối nếu chưa chọn.
- Gợi ý **context-aware theo vị trí con trỏ** (không phải danh sách phẳng):
  - Sau `FROM | JOIN | INTO | UPDATE | TABLE` → gợi ý tên bảng.
  - Sau `<tên_bảng>.` hoặc `<alias>.` → gợi ý cột của bảng đó (alias resolve từ
    mệnh đề FROM/JOIN cấp một).
  - Ngữ cảnh khác → keyword SQL + tên bảng.

Ngoài phạm vi (YAGNI v1): refresh schema thủ công (đổi schema xong cần chuyển
tab/mở lại panel để nạp lại); alias-resolution trong subquery/CTE; autocomplete cho
Mongo shell / Redis; gợi ý theo nhiều database cùng lúc.

## 2. Bối cảnh mã nguồn hiện tại

- `src/renderer/src/monaco-setup.ts`: khởi tạo Monaco, mới chỉ nạp SQL
  *highlighting* (`basic-languages/sql`), **chưa** có completion provider.
- `src/renderer/src/components/QueryPanel.tsx`: tạo một Monaco editor cho mỗi phiên;
  nhận props `connectionId`, `language`, `placeholder`. Hiện KHÔNG biết database đang
  chọn.
- `src/renderer/src/App.tsx`: giữ state `dbSelection` (`connectionId`, `database?`,
  `schema?`, `label`) từ `Sidebar.onSelectDatabase`, và `session.connection`
  (`StoredConnection`, có `database?`). `QueryPanel` được mount trong tab `query`.
- Metadata sẵn có qua `getTableList` (bảng) và `getStructure` (cột từng bảng), nhưng
  lấy cột cho mọi bảng bằng `getStructure` là N+1 round-trip — chậm.
- Adapter SQL: `MariaDbAdapter`, `PostgresAdapter` có sẵn `this.db()`,
  `quoteIdentMysql`/`quoteIdentPg`, và các truy vấn `information_schema` (đã dùng
  trong `columnNames`/`primaryKeys`).

## 3. Kiến trúc

### 3.1 Backend — 1 IPC gom bảng + cột

Thêm method vào `DatabaseAdapter` (optional, chỉ SQL hiện thực):

```ts
/** (SQL) Lấy toàn bộ bảng + cột của một database/schema trong 1 truy vấn — cho autocomplete. */
getSchemaObjects?(database?: string, schema?: string): Promise<SchemaObject[]>;

export interface SchemaObject {
  table: string;
  columns: string[];
}
```

- **MariaDB**: một query
  `SELECT table_name, column_name FROM information_schema.columns
   WHERE table_schema = ? ORDER BY table_name, ordinal_position`
  (dùng `database ?? this.config.database`), gom theo `table_name`.
- **Postgres**: tương tự với `table_schema = $1` (dùng `schema ?? 'public'`).
- Mongo/Redis: không hiện thực (method optional).

IPC: thêm `IpcChannels.schemaObjects = 'schema:objects'`; handler trong `ipc.ts`
gọi `sessions.get(connectionId).getSchemaObjects?.(database, schema)` (trả `[]` nếu
adapter không hỗ trợ). Preload + `RendererApi`:
`getSchemaObjects(connectionId, database?, schema?): Promise<SchemaObject[]>`.

### 3.2 Renderer — completion provider + cache

Module mới `src/renderer/src/sql-completion.ts`:

- `registerSqlCompletion(monaco)` — gọi **một lần** từ `monaco-setup.ts`. Đăng ký
  `monaco.languages.registerCompletionItemProvider('sql', provider)` với
  `triggerCharacters: ['.']` (cộng với gõ ký tự thường mặc định).
- State module-level:
  ```ts
  let activeSchema: Map<string, string[]> | null = null; // table (lowercase) -> columns
  export function setActiveSchema(objs: SchemaObject[]): void;
  export function clearActiveSchema(): void;
  ```
  Chỉ có một query editor SQL hoạt động tại một thời điểm nên state global là đủ.
- Provider đọc text tới con trỏ, gọi hàm thuần `computeSuggestions` (mục 3.3), rồi
  map kết quả sang `monaco.languages.CompletionItem` với `kind` phù hợp
  (Field cho cột, Struct/Class cho bảng, Keyword cho từ khóa).

`QueryPanel`:

- Nhận thêm props `database?: string`, `schema?: string`.
- `useEffect` phụ thuộc `[connectionId, database, schema, language]`: nếu
  `language === 'sql'`, gọi `window.api.getSchemaObjects(connectionId, database, schema)`
  → `setActiveSchema(objs)`. Cleanup: `clearActiveSchema()` khi unmount.
- Lỗi fetch metadata: nuốt (chỉ mất autocomplete, không chặn gõ query); có thể log.

### 3.3 Heuristic context — hàm thuần (test được headless)

```ts
export type SuggestionKind = 'table' | 'column' | 'keyword';
export interface Suggestion { label: string; kind: SuggestionKind }

/** Phân tích ngữ cảnh quanh con trỏ để chọn loại gợi ý. Thuần, không phụ thuộc Monaco/DOM. */
export function computeSuggestions(
  textUntilCursor: string,
  fullText: string,
  schema: Map<string, string[]>,
): Suggestion[];
```

Quy tắc (áp dụng theo thứ tự):

1. **`<X>.` trước con trỏ** — regex `/([A-Za-z_][\w$]*)\.\s*$/` trên `textUntilCursor`
   → tên `X`. Resolve:
   - Nếu `schema` có key `X.toLowerCase()` → trả cột của `X` (kind `column`).
   - Ngược lại, dò alias trong `fullText`:
     `/\b(?:FROM|JOIN)\s+[`"\[]?(\w+)[`"\]]?\s+(?:AS\s+)?X\b/i` (X chèn literal) →
     bảng thật → trả cột. Không tìm được → `[]`.
2. **Từ khóa ngay trước con trỏ** (token chữ cuối trong `textUntilCursor`, không tính
   dấu cách) ∈ `{FROM, JOIN, INTO, UPDATE, TABLE}` → trả toàn bộ tên bảng (kind
   `table`).
3. **Mặc định** → keyword SQL (danh sách tĩnh: SELECT, FROM, WHERE, JOIN, LEFT, INNER,
   ON, GROUP BY, ORDER BY, LIMIT, INSERT, UPDATE, DELETE, SET, VALUES, AND, OR, NOT,
   NULL, AS, DISTINCT, COUNT…) + tên bảng.

So khớp tên bảng/alias không phân biệt hoa thường (lưu key lowercase, hiển thị tên
gốc — giữ map thứ hai `displayName` nếu cần, hoặc lưu `SchemaObject.table` nguyên
văn và so khớp lowercase khi tra cứu).

### 3.4 Data flow

```
Sidebar.onSelectDatabase → App.dbSelection
App: database = dbSelection?.database ?? session.connection.database
     schema   = dbSelection?.schema
  → <QueryPanel database=... schema=... />
QueryPanel effect → api.getSchemaObjects(connectionId, database, schema)
  → setActiveSchema(objs)   (module state trong sql-completion.ts)
Monaco provider (đăng ký 1 lần) → computeSuggestions(textUntilCursor, fullText, activeSchema)
  → hiển thị gợi ý
```

## 4. Testing

Không có test framework. Gate: `npm run typecheck` + `npm run build`.

- **Hàm `computeSuggestions`** là pure → verify bằng harness esbuild/node
  (`--bundle --platform=node --format=esm --packages=external`, xuất `.mjs` trong
  repo). Case tối thiểu:
  - sau `FROM ` → trả danh sách bảng;
  - `SELECT ` giữa câu → có keyword + bảng;
  - `users.` (users là bảng) → trả cột của users;
  - `u.` với `FROM users u` trong câu → trả cột của users (alias resolve);
  - `u.` không có binding → `[]`;
  - so khớp không phân biệt hoa thường (`FROM Users`, tra `users`).
- **Backend `getSchemaObjects`**: verify bằng harness với docker throwaway
  `postgres:16` + `mariadb:11` (giống pattern feature transfer): seed 2 bảng vài cột,
  gọi method, assert gom đúng bảng→cột.
- Monaco provider + tích hợp GUI: smoke thủ công `npm run dev` (gõ trong ô SQL, kiểm
  gợi ý bảng sau FROM và cột sau `table.`).

## 5. Cấu trúc file

- `src/shared/types.ts` (modify) — `SchemaObject`; `IpcChannels.schemaObjects`;
  `DatabaseAdapter.getSchemaObjects?`; `RendererApi.getSchemaObjects`.
- `src/main/adapters/mariadb.ts` (modify) — `getSchemaObjects`.
- `src/main/adapters/postgres.ts` (modify) — `getSchemaObjects`.
- `src/main/ipc.ts` (modify) — handler `schema:objects`.
- `src/preload/index.ts` (modify) — expose `getSchemaObjects`.
- `src/renderer/src/sql-completion.ts` (create) — `computeSuggestions` (pure),
  `registerSqlCompletion`, `setActiveSchema`/`clearActiveSchema`, danh sách keyword.
- `src/renderer/src/monaco-setup.ts` (modify) — gọi `registerSqlCompletion(monaco)`.
- `src/renderer/src/components/QueryPanel.tsx` (modify) — props `database`/`schema`,
  effect fetch metadata + set/clear active schema.
- `src/renderer/src/App.tsx` (modify) — truyền `database`/`schema` xuống `QueryPanel`.

## 6. Giới hạn đã biết (v1)

<!-- ĐÃ SỬA Ở v2 — xem mục 7. Giới hạn thứ ba dưới đây là nguồn gốc của một lỗi thật. -->


- Không refresh schema thủ công; schema đổi (tạo/xóa bảng) cần chuyển tab hoặc mở lại
  query panel để nạp lại metadata.
- Alias resolve chỉ ở FROM/JOIN cấp một; subquery/CTE không được xử lý.
- Không qualify nhiều database; chỉ database/schema đang chọn.
- Không phân tích cú pháp SQL đầy đủ — heuristic regex quanh con trỏ; một số ngữ cảnh
  hiếm có thể gợi ý chưa tối ưu (chấp nhận cho v1).

---

# v2 (2026-08-11): chọn đích chạy query

Trạng thái: đã duyệt thiết kế, đang hiện thực trên branch `fix/query-target-selector`.

## 7. Lỗi v1 để lại

v1 đưa `database`/`schema` đang chọn xuống `QueryPanel` **chỉ để nạp metadata cho
autocomplete** (mục 3.4). Nút Chạy vẫn gọi `window.api.executeQuery(connectionId, query)`
bỏ trống tham số thứ ba, nên query rơi vào database mặc định của kết nối.

Hậu quả quan sát được: autocomplete gợi ý `coupons` của database đang xem, chạy thì báo

```
Error invoking remote method 'query:execute': Error: Table 'kvshipping_dev.coupons' doesn't exist
```

Hai nguồn sự thật lệch nhau — gợi ý theo một nơi, thực thi ở nơi khác. Sửa lỗi này chỉ
cần truyền thêm một tham số, nhưng v2 giải quyết luôn gốc: đích chạy query trở thành thứ
người dùng **nhìn thấy và chọn được**, và autocomplete bám theo đúng đích đó.

## 8. Phạm vi v2

Trong phạm vi:

- Hai select đặt trước nút Chạy trong `QueryPanel`: **server host** và **database/schema**.
- Giá trị mặc định lấy theo kết nối + database đang chọn ở sidebar.
- Chỉ **MariaDB/MySQL và Postgres**. Mongo/Redis giữ nguyên hành vi hiện tại.
- Autocomplete nạp theo đích đã chọn trong panel, không còn theo prop từ sidebar.

Ngoài phạm vi:

- Postgres cross-database (xem 9.2).
- Chọn đích cho Mongo/Redis.
- Nhớ đích đã chọn giữa các lần mở app.

## 9. Quyết định thiết kế

| Câu hỏi | Chọn | Lý do |
|---|---|---|
| Loại DB được hỗ trợ | MariaDB + Postgres | Đúng phạm vi `language === 'sql'` của v1 |
| Select thứ hai với Postgres | **schema**, không phải database | Xem 9.2 |
| Nguồn danh sách host | mọi kết nối SQL đã lưu, tự mở phiên khi chọn | Không bắt mở tab trước |
| Sidebar đổi database | **luôn ghi đè** select | Khớp yêu cầu "mặc định là db đang chọn" |

### 9.1 `QueryTarget` — đích đến tường minh

`executeRaw(query, database?)` hiện chỉ MariaDB hiểu; Postgres bỏ qua hoàn toàn
(`postgres.ts:452` không nhận tham số). Với Postgres thứ chọn được là *schema* chứ không
phải database, nên nhồi cả hai nghĩa vào một tham số tên `database` sẽ nói dối chỗ gọi.

```ts
export interface QueryTarget {
  /** MariaDB: USE <database>. Mongo: tên db. Redis: số hiệu db. */
  database?: string;
  /** Postgres: SET search_path TO <schema>. */
  schema?: string;
}

executeRaw(query: string, target?: QueryTarget): Promise<QueryResult>;
```

Hành vi từng adapter:

- **MariaDB** — `USE` như cũ, đọc từ `target.database`. Đã mượn connection riêng
  (`getConnection()`) nên `USE` không rò sang query khác.
- **Postgres** — thay đổi thực chất, không chỉ đổi tên tham số. Hiện `executeRaw` gọi
  `this.db().query(...)` thẳng trên pool, mỗi lần có thể rơi vào client khác nhau, nên
  bắn `SET search_path` rời sẽ không đảm bảo áp cho query kế tiếp. Phải mượn một client
  (`pool.connect()`), chạy `SET search_path TO <ident>` rồi chạy query trên **cùng**
  client, `release()` trong `finally` — đúng khuôn MariaDB.
- **Mongo / Redis** — đổi chữ ký cho khớp interface, đọc `target.database` thay cho tham
  số phẳng. Hành vi giữ nguyên: mongo chọn db theo tên, redis `SELECT <index>`.

IPC `query:execute` và preload đổi tham số thứ ba từ `database?: string` sang
`target?: QueryTarget`. Không thêm channel mới.

### 9.2 Vì sao Postgres chọn schema

`pg.Pool` gắn cứng vào database lúc connect. Cho chọn database thật đồng nghĩa phải mở
pool phụ cho mỗi database và quản vòng đời của chúng. Ngoài ra `getRootNodes` của
Postgres (`postgres.ts:76-77`) vốn chỉ liệt kê schema kèm comment "Postgres không
cross-database dễ dàng" — cây sidebar cũng không cho thấy database khác. Chọn schema giữ
panel nhất quán với những gì người dùng đang nhìn thấy, và không phát sinh vòng đời kết
nối mới.

### 9.3 Không cần IPC mới để liệt kê

`window.api.getRootNodes(connectionId)` sẵn có trả đúng thứ cần: MariaDB → node
`type: 'database'` kèm `meta.database`; Postgres → node `type: 'schema'` kèm `meta.schema`.
Dùng lại nguyên, không thêm channel.

## 10. UI và luồng trong QueryPanel

Thanh công cụ: `[Select host] [Select database/schema] [Chạy] [Xuất kết quả] [thời gian]`.

- **Select host** — options là các kết nối đã lưu có `kind` ∈ {mariadb, postgres}.
  `QueryPanel` nhận thêm prop `connections: StoredConnection[]` từ `App`.
- **Select database/schema** — nạp bằng `getRootNodes(selectedConnectionId)`, map
  `meta.database ?? meta.schema` thành options. Nhãn đổi theo loại DB: `Database` cho
  MariaDB, `Schema` cho Postgres.
- **Mở phiên khi cần** — chọn một host chưa mở phiên thì gọi `window.api.openSession(id)`
  trực tiếp. **Không** dùng `App.handleOpen`: hàm đó reset `session`/`target`/`dbSelection`
  và chuyển tab, sẽ unmount chính panel đang thao tác.
- **Sidebar ghi đè** — `useEffect` phụ thuộc `[connectionId, database, schema]` (các prop
  do `App` tính) đặt lại state của panel. Prop chỉ đổi khi người dùng bấm ở sidebar, nên
  lựa chọn tay được giữ cho tới lần bấm sidebar kế tiếp.
- **Autocomplete bám đích** — effect nạp `getSchemaObjects` chuyển sang phụ thuộc state
  đã chọn trong panel thay vì prop. Đây là điểm khép lại lỗi ở mục 7: gợi ý và thực thi
  dùng chung một nguồn sự thật.

## 11. Xử lý lỗi v2

- Mở phiên host thất bại → `message.error`, select host quay về giá trị trước đó, danh
  sách database giữ nguyên của host cũ.
- `getRootNodes` thất bại → `message.error`, select database rỗng và bị vô hiệu; nút Chạy
  vẫn dùng được với đích rỗng (chạy vào db mặc định của kết nối).
- Chạy query thất bại → giữ nguyên `message.error` sẵn có.
- Nạp `getSchemaObjects` thất bại → vẫn nuốt như v1, chỉ mất autocomplete.

## 12. Kiểm thử v2

Không có test framework; gate là `npm run typecheck` + `npm run build`.

Không phát sinh hàm thuần mới đáng kể — phần logic là mapping `TreeNode[]` → options,
đủ nhỏ để đọc thẳng. Kiểm tay trong `npm run dev`:

1. MariaDB: chọn database B ở select trong khi sidebar đang ở A → `SELECT * FROM <bảng của B>`
   phải chạy được, và autocomplete phải gợi ý bảng của B.
2. Đúng ca lỗi gốc: sidebar chọn database có bảng `coupons`, bấm Chạy → không còn báo
   `Table '<db mặc định>.coupons' doesn't exist`.
3. Đổi host sang một kết nối **chưa mở tab** → phiên tự mở, danh sách database nạp được.
4. Postgres: đổi schema → query không qualify schema phải trỏ đúng schema đã chọn.
5. Bấm database khác ở sidebar sau khi đã tự đổi select → select nhảy theo sidebar.
6. Host lỗi (tắt server) → báo lỗi, select quay về giá trị cũ.

## 13. Cấu trúc file v2

- `src/shared/types.ts` (modify) — `QueryTarget`; `DatabaseAdapter.executeRaw`;
  `RendererApi.executeQuery`.
- `src/preload/index.ts` (modify) — `executeQuery` nhận `target`.
- `src/main/ipc.ts` (modify) — handler `query:execute` chuyển `target`.
- `src/main/adapters/mariadb.ts` (modify) — đọc `target.database`.
- `src/main/adapters/postgres.ts` (modify) — mượn client + `SET search_path`.
- `src/main/adapters/mongo.ts`, `redis.ts` (modify) — đổi chữ ký, giữ hành vi.
- `src/renderer/src/components/QueryPanel.tsx` (modify) — hai select, state đích,
  autocomplete theo đích, truyền `target` khi chạy.
- `src/renderer/src/App.tsx` (modify) — truyền `connections` xuống `QueryPanel`.
