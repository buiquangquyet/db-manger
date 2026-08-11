# Hủy query + phím tắt Ctrl/Cmd+Enter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hủy được query đang chạy trên MariaDB/Postgres, và chạy query bằng Ctrl/Cmd+Enter.

**Architecture:** Hủy query không phải abort Promise — connection đang bận chờ server. Renderer sinh `queryId` mỗi lần chạy; adapter đăng ký `queryId → threadId/processID` của connection đang mượn; kênh `query:cancel` giết từ **một connection thứ hai** (`KILL QUERY` / `pg_cancel_backend`). Khuôn này lặp lại `transferId → transferFlags` sẵn có trong `ipc.ts`.

**Tech Stack:** Electron + React 18 + TypeScript, antd 5, Monaco, `mysql2` 3.x, `pg` 8.x.

**PRD:** `docs/superpowers/specs/2026-08-11-query-workflow-prd.md`, mục "Tính năng 1".

## Global Constraints

- Branch `feat/query-workflow`. Làm **sau** plan foreign-keys, **trước** plan query-history — cả hai plan sau đều sửa `QueryPanel.tsx`.
- Chỉ MariaDB + Postgres. Mongo/Redis: không hiện nút Hủy, `cancelQuery` không hiện thực (method optional).
- Không thêm dependency. Gate mọi task: `npm run typecheck` + `npm run build`.
- `RendererApi` là interface preload phải hiện thực đầy đủ — thêm method vào `RendererApi` bắt buộc sửa preload cùng task, nếu không `typecheck:node` fail.
- Chuỗi UI tiếng Việt: nút `Hủy`, thông báo `Đã hủy query`.
- Commit message kết thúc bằng `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

| File | Việc |
|---|---|
| `src/shared/types.ts` | `IpcChannels.queryCancel`; `executeRaw` nhận `queryId`; `DatabaseAdapter.cancelQuery?`; `RendererApi.cancelQuery` |
| `src/preload/index.ts` | expose `cancelQuery` |
| `src/main/ipc.ts` | handler `query:cancel`; chuyển `queryId` vào `executeRaw` |
| `src/main/adapters/mariadb.ts` | sổ đăng ký threadId + `cancelQuery` |
| `src/main/adapters/postgres.ts` | sổ đăng ký processID + `cancelQuery` |
| `src/renderer/src/components/QueryPanel.tsx` | nút Hủy, phím tắt, nhận diện lỗi hủy |

---

### Task 1: Contract + preload + IPC

**Files:** `src/shared/types.ts`, `src/preload/index.ts`, `src/main/ipc.ts`

**Interfaces produced:**
- `IpcChannels.queryCancel = 'query:cancel'`
- `DatabaseAdapter.executeRaw(query: string, target?: QueryTarget, queryId?: string): Promise<QueryResult>`
- `DatabaseAdapter.cancelQuery?(queryId: string): Promise<void>`
- `RendererApi.executeQuery(connectionId: string, query: string, target?: QueryTarget, queryId?: string): Promise<QueryResult>`
- `RendererApi.cancelQuery(connectionId: string, queryId: string): Promise<void>`

- [ ] **Step 1: `src/shared/types.ts`**

Thêm vào `IpcChannels` sau `queryExecute`:

```ts
  queryCancel: 'query:cancel',
```

Đổi chữ ký trong `DatabaseAdapter`:

```ts
  /** Chạy query/command tự do tại `target`. `queryId` để hủy giữa chừng (SQL). */
  executeRaw(query: string, target?: QueryTarget, queryId?: string): Promise<QueryResult>;

  /** (SQL) Hủy một query đang chạy đã đăng ký với `queryId`. Không hỗ trợ = không hiện thực. */
  cancelQuery?(queryId: string): Promise<void>;
```

Đổi trong `RendererApi`:

```ts
  executeQuery(connectionId: string, query: string, target?: QueryTarget, queryId?: string): Promise<QueryResult>;
  /** Hủy query đang chạy; no-op nếu queryId không còn trong sổ đăng ký. */
  cancelQuery(connectionId: string, queryId: string): Promise<void>;
```

- [ ] **Step 2: `src/preload/index.ts`**

```ts
  executeQuery: (connectionId: string, query: string, target?: QueryTarget, queryId?: string) =>
    ipcRenderer.invoke(IpcChannels.queryExecute, connectionId, query, target, queryId),
  cancelQuery: (connectionId: string, queryId: string) =>
    ipcRenderer.invoke(IpcChannels.queryCancel, connectionId, queryId),
```

- [ ] **Step 3: `src/main/ipc.ts`**

Sửa handler `queryExecute` và thêm handler mới ngay dưới:

```ts
  ipcMain.handle(
    IpcChannels.queryExecute,
    (_e, connectionId: string, query: string, target?: QueryTarget, queryId?: string) =>
      sessions.get(connectionId).executeRaw(query, target, queryId),
  );

  ipcMain.handle(IpcChannels.queryCancel, async (_e, connectionId: string, queryId: string) => {
    const adapter = sessions.get(connectionId);
    if (!adapter.cancelQuery) throw new Error('Loại DB này không hỗ trợ hủy query.');
    await adapter.cancelQuery(queryId);
  });
```

- [ ] **Step 4: Gate**

Run: `npm run typecheck`
Expected: PASS. `queryId` và `cancelQuery` đều optional trên adapter nên chưa adapter nào phải sửa.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/preload/index.ts src/main/ipc.ts
git commit -m "$(cat <<'EOF'
feat(query): contract hủy query — queryId + kênh query:cancel

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: MariaDB — KILL QUERY

**Files:** `src/main/adapters/mariadb.ts`

**Interfaces consumed:** `executeRaw(query, target?, queryId?)`, `cancelQuery?(queryId)` từ Task 1.

- [ ] **Step 1: Sổ đăng ký**

Thêm field trong class, cạnh các field sẵn có:

```ts
  /** queryId -> threadId của connection đang chạy, để KILL QUERY từ connection khác. */
  private running = new Map<string, number>();
```

- [ ] **Step 2: Đăng ký trong `executeRaw`**

Sửa `executeRaw` (hiện ở ~dòng 400):

```ts
  async executeRaw(query: string, target?: QueryTarget, queryId?: string): Promise<QueryResult> {
    const started = process.hrtime.bigint();
    const conn = await this.db().getConnection();
    if (queryId) this.running.set(queryId, conn.threadId);
    try {
      // USE chạy trên đúng connection đang mượn nên không rò sang query khác của pool.
      if (target?.database) await conn.query(`USE ${quoteIdentMysql(target.database)}`);
      const [result, fields] = await conn.query(query);
      // ... phần dựng QueryResult giữ nguyên
    } finally {
      if (queryId) this.running.delete(queryId);
      conn.release();
    }
  }
```

Thứ tự trong `finally` quan trọng: gỡ sổ đăng ký **trước** khi `release()`, để không có cửa sổ mà connection đã về pool cho query khác dùng nhưng sổ vẫn trỏ tới threadId đó — hủy lúc đó sẽ giết nhầm query của người khác.

- [ ] **Step 3: `cancelQuery`**

Thêm method mới trong class:

```ts
  /**
   * KILL QUERY phải chạy từ MỘT connection khác: connection đang chạy query bị chặn
   * chờ server, không nhận thêm lệnh nào.
   */
  async cancelQuery(queryId: string): Promise<void> {
    const threadId = this.running.get(queryId);
    if (threadId === undefined) return; // query đã xong trước khi lệnh hủy tới nơi
    const killer = await this.db().getConnection();
    try {
      await killer.query(`KILL QUERY ${Number(threadId)}`);
    } finally {
      killer.release();
    }
  }
```

`Number(threadId)` là chốt chặn injection dù giá trị vốn đã từ driver ra.

- [ ] **Step 4: Gate**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/mariadb.ts
git commit -m "$(cat <<'EOF'
feat(query): MariaDB hủy query bằng KILL QUERY từ connection thứ hai

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Postgres — pg_cancel_backend

**Files:** `src/main/adapters/postgres.ts`

- [ ] **Step 1: Sổ đăng ký + đăng ký trong `executeRaw`**

```ts
  /** queryId -> processID (PID backend) của client đang chạy. */
  private running = new Map<string, number>();
```

Trong `executeRaw` (hiện ở ~dòng 453), sau `const client = await this.db().connect();`:

```ts
    // processID có thật lúc chạy (pg/lib/client.js gán khi nhận BackendKeyData) nhưng
    // KHÔNG được khai báo trong @types/pg — phải cast. Đừng bỏ dòng này vì tưởng thừa.
    const pid = (client as unknown as { processID?: number }).processID;
    if (queryId && pid) this.running.set(queryId, pid);
```

Và trong `finally`, trước `client.release()`:

```ts
      if (queryId) this.running.delete(queryId);
```

Chữ ký đổi thành `executeRaw(query: string, target?: QueryTarget, queryId?: string)`.

- [ ] **Step 2: `cancelQuery`**

```ts
  /**
   * pg_cancel_backend gửi tín hiệu hủy tới backend đang chạy; phải phát từ một client
   * KHÁC vì client đang chạy query bị chặn chờ kết quả.
   */
  async cancelQuery(queryId: string): Promise<void> {
    const pid = this.running.get(queryId);
    if (pid === undefined) return;
    await this.db().query('SELECT pg_cancel_backend($1)', [pid]);
  }
```

Dùng thẳng `pool.query` được: đây là lệnh một phát, không cần dính client cố định như `SET search_path`.

- [ ] **Step 3: Gate**

Run: `npm run typecheck && npm run build`
Expected: cả hai PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/adapters/postgres.ts
git commit -m "$(cat <<'EOF'
feat(query): Postgres hủy query bằng pg_cancel_backend

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: QueryPanel — nút Hủy, phím tắt, nhận diện lỗi hủy

**Files:** `src/renderer/src/components/QueryPanel.tsx`

- [ ] **Step 1: State + helper nhận diện lỗi hủy**

Thêm ở cấp module, cạnh `TARGETABLE`:

```ts
/**
 * Query bị giết sẽ NÉM LỖI chứ không resolve. Nhận diện để báo "đã hủy" thay vì
 * dựng lên một thông báo lỗi đỏ ngay sau khi người dùng chủ động bấm Hủy.
 * MariaDB: ER_QUERY_INTERRUPTED (1317). Postgres: SQLSTATE 57014 query_canceled.
 */
function isCancellation(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string };
  return (
    e?.code === '57014' ||
    e?.code === 'ER_QUERY_INTERRUPTED' ||
    e?.errno === 1317 ||
    /query.*cancel|interrupted/i.test(e?.message ?? '')
  );
}
```

Thêm state trong component, cạnh `running`:

```ts
  // queryId của lần chạy hiện tại; null khi không có gì đang chạy.
  const [runningId, setRunningId] = useState<string | null>(null);
```

- [ ] **Step 2: `run` sinh queryId và chạy phần bôi đen nếu có**

Thay hàm `run` (hiện ở ~dòng 157):

```tsx
  const run = async () => {
    const editor = editorRef.current;
    if (!editor) return;
    // Có bôi đen thì chỉ chạy phần bôi đen — thói quen chuẩn của công cụ SQL.
    const selection = editor.getSelection();
    const selected = selection && !selection.isEmpty() ? editor.getModel()?.getValueInRange(selection) : '';
    const query = (selected || editor.getValue()).trim();
    if (!query) return;

    const queryId = crypto.randomUUID();
    setRunning(true);
    setRunningId(queryId);
    try {
      const res = await window.api.executeQuery(targetConnId, query, queryTarget, queryId);
      setResult(res);
    } catch (err) {
      if (isCancellation(err)) message.info('Đã hủy query');
      else {
        message.error((err as Error).message);
        setResult(null);
      }
    } finally {
      setRunning(false);
      setRunningId(null);
    }
  };
```

Ca hủy **giữ nguyên** `result` cũ thay vì xóa: người dùng hủy một query mới không có nghĩa muốn mất kết quả đang xem.

- [ ] **Step 3: Hàm hủy**

```tsx
  const cancel = async () => {
    if (!runningId) return;
    try {
      await window.api.cancelQuery(targetConnId, runningId);
    } catch (err) {
      message.error(`Hủy thất bại: ${(err as Error).message}`);
    }
  };
```

Không đụng `running`/`runningId` ở đây — `run` sẽ tự dọn trong `finally` khi query thực sự dừng. Tự đặt lại ở đây sẽ khiến nút trở về trạng thái sẵn sàng trong khi query vẫn còn chạy.

- [ ] **Step 4: Phím tắt — tránh bẫy stale closure**

`addCommand` đăng ký một lần trong effect mount (`QueryPanel.tsx:79-92`), nên callback sẽ đóng băng state của render đầu tiên và **chạy sai đích**. Dùng ref:

Khai báo cạnh `editorRef`:

```tsx
  // Giữ bản `run` mới nhất: lệnh Monaco đăng ký một lần nên không được đóng băng closure.
  const runRef = useRef<() => void>(() => {});
  runRef.current = () => void run();
```

Trong effect tạo editor, ngay sau `editorRef.current = editor;`:

```tsx
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
```

- [ ] **Step 5: Nút Hủy trong toolbar**

Ngay sau nút `Chạy` (hiện ở ~dòng 229):

```tsx
          {showTargets && running && (
            <Button danger icon={<StopOutlined />} onClick={cancel}>
              Hủy
            </Button>
          )}
```

Thêm `StopOutlined` vào import từ `@ant-design/icons`. Điều kiện `showTargets` giữ nút khỏi hiện với Mongo/Redis, nơi `cancelQuery` không tồn tại.

- [ ] **Step 6: Gate**

Run: `npm run typecheck && npm run build`
Expected: cả hai PASS.

- [ ] **Step 7: Kiểm tay**

Run: `npm run dev`. Theo tiêu chí PRD mục "Hủy query":
1. MariaDB `SELECT SLEEP(30)` → bấm Hủy → dừng, hiện `Đã hủy query`, **không** có thông báo lỗi đỏ.
2. Postgres `SELECT pg_sleep(30)` → tương tự.
3. **Ca bắt lỗi stale closure:** mở panel, đổi select đích sang database khác, rồi chạy bằng **Ctrl/Cmd+Enter** (không bấm chuột) → phải chạy đúng đích mới. Nếu chạy vào đích cũ tức là `runRef` bị bỏ hoặc làm sai.
4. Bôi đen một câu trong nhiều câu → chỉ câu đó chạy.
5. Kết nối Mongo/Redis → không thấy nút Hủy.
6. Bấm Hủy sau khi query đã xong → không có gì xảy ra, không lỗi (sổ đăng ký đã gỡ, `cancelQuery` return sớm).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/QueryPanel.tsx
git commit -m "$(cat <<'EOF'
feat(query): nút Hủy + Ctrl/Cmd+Enter, chạy phần bôi đen nếu có

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage (PRD mục "Tính năng 1"):** chỉ MariaDB+Postgres ✓; `queryId` + sổ đăng ký kiểu `transferFlags` ✓; KILL QUERY / pg_cancel_backend từ connection thứ hai ✓; cast `processID` kèm comment ✓; nhận diện `ER_QUERY_INTERRUPTED`/`57014` → `Đã hủy query` ✓; `runRef` chống stale closure ✓; chạy phần bôi đen ✓; Mongo/Redis không hiện nút ✓.

**Placeholder scan:** không TBD; mọi step có mã đầy đủ.

**Type consistency:** `executeRaw(query, target?, queryId?)` khai báo ở Task 1 và hiện thực đúng vậy ở Task 2/3; `cancelQuery(queryId)` một chữ ký; `RendererApi.cancelQuery(connectionId, queryId)` khớp preload và handler.

**Rủi ro còn lại, không tự động hóa được:** không có cách kiểm tự động cho việc hủy — cần DB thật và một query đủ chậm. Bước 7 là cổng duy nhất, và ca 3 là ca dễ trượt nhất vì lỗi stale closure không làm build đỏ, chỉ lặng lẽ chạy sai đích.
