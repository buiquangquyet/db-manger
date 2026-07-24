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

- Không refresh schema thủ công; schema đổi (tạo/xóa bảng) cần chuyển tab hoặc mở lại
  query panel để nạp lại metadata.
- Alias resolve chỉ ở FROM/JOIN cấp một; subquery/CTE không được xử lý.
- Không qualify nhiều database; chỉ database/schema đang chọn.
- Không phân tích cú pháp SQL đầy đủ — heuristic regex quanh con trỏ; một số ngữ cảnh
  hiếm có thể gợi ý chưa tối ưu (chấp nhận cho v1).
