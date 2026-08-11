# Query history — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lưu lại mọi query đã chạy (thành công lẫn thất bại) và cho xem/nạp lại từ một tab dưới editor.

**Architecture:** Ghi ở main process trong handler `query:execute` — chỗ đó đã bọc quanh `executeRaw` nên bắt được cả ca lỗi và không mất bản ghi khi renderer reload. Lưu JSON ở `userData` theo đúng khuôn `SecureStore`, cap 500 bản ghi FIFO. Renderer đổi vùng dưới editor thành `Tabs`: Kết quả | Lịch sử.

**Tech Stack:** Electron + React 18 + TypeScript, antd 5. Không thêm dependency.

**PRD:** `docs/superpowers/specs/2026-08-11-query-workflow-prd.md`, mục "Tính năng 2".

## Global Constraints

- Branch `feat/query-workflow`. Làm **sau** plan query-cancel — cùng sửa `QueryPanel.tsx`.
- Không thêm dependency. Gate mọi task: `npm run typecheck` + `npm run build`.
- `RendererApi` là interface preload phải hiện thực đầy đủ — thêm method bắt buộc sửa preload cùng task.
- Cap **500** bản ghi, FIFO (đẩy bản ghi cũ nhất ra).
- Lưu `connectionId`, **không** lưu tên kết nối — tên đổi thì renderer tự tra từ `connections`.
- Chuỗi UI tiếng Việt: tab `Kết quả` / `Lịch sử`, checkbox `Chỉ kết nối này`, nút `Xóa lịch sử`, empty `Chưa có query nào`.
- Commit message kết thúc bằng `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

| File | Việc |
|---|---|
| `src/shared/types.ts` | `QueryHistoryEntry`; `IpcChannels.historyList/historyClear`; `RendererApi` |
| `src/main/query-history.ts` | **Mới** — `QueryHistoryStore` |
| `scripts/check-query-history.ts` | **Mới** — kiểm cap FIFO (hàm thuần) |
| `package.json` | script `check:query-history` |
| `src/main/ipc.ts` | ghi history quanh `query:execute`; handler list/clear |
| `src/preload/index.ts` | expose `listQueryHistory`, `clearQueryHistory` |
| `src/renderer/src/components/QueryPanel.tsx` | Tabs Kết quả \| Lịch sử |

---

### Task 1: Kiểu + store + kiểm chứng cap

**Files:** `src/shared/types.ts`, `src/main/query-history.ts`, `scripts/check-query-history.ts`, `package.json`

**Interfaces produced:**
- `QueryHistoryEntry` (xem Step 2)
- `export function pushCapped<T>(list: T[], entry: T, cap: number): T[]`
- `class QueryHistoryStore { list(): QueryHistoryEntry[]; add(e: Omit<QueryHistoryEntry,'id'>): void; clear(): void }`

- [ ] **Step 1: Script kiểm chứng (fail vì module chưa có)**

Tạo `scripts/check-query-history.ts`:

```ts
import assert from 'node:assert/strict';
import { pushCapped } from '../src/main/query-history';

// Dưới cap: thêm vào cuối, giữ nguyên thứ tự
{
  const out = pushCapped([1, 2], 3, 5);
  assert.deepEqual(out, [1, 2, 3]);
}

// Chạm cap: đẩy phần tử CŨ NHẤT ra
{
  const out = pushCapped([1, 2, 3], 4, 3);
  assert.deepEqual(out, [2, 3, 4]);
}

// Danh sách dài hơn cap (vd cap bị giảm giữa chừng) -> cắt về đúng cap
{
  const out = pushCapped([1, 2, 3, 4, 5], 6, 3);
  assert.deepEqual(out, [4, 5, 6]);
}

// cap = 1
{
  assert.deepEqual(pushCapped([1], 2, 1), [2]);
}

// Không sửa mảng đầu vào
{
  const input = [1, 2, 3];
  pushCapped(input, 4, 3);
  assert.deepEqual(input, [1, 2, 3]);
}

console.log('OK: query-history');
```

- [ ] **Step 2: Thêm kiểu vào `src/shared/types.ts`**

```ts
/** Một lần chạy query đã được ghi lại. */
export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  database?: string;
  schema?: string;
  sql: string;
  /** epoch ms lúc bắt đầu chạy. */
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  rowCount?: number;
  error?: string;
}
```

Thêm vào `IpcChannels` sau `queryCancel`:

```ts
  historyList: 'history:list',
  historyClear: 'history:clear',
```

Thêm vào `RendererApi`:

```ts
  /** Lịch sử query, mới nhất trước. */
  listQueryHistory(): Promise<QueryHistoryEntry[]>;
  clearQueryHistory(): Promise<void>;
```

- [ ] **Step 3: Thêm npm script**

```json
    "check:query-history": "esbuild scripts/check-query-history.ts --bundle --format=esm --platform=node --outfile=node_modules/.cache/check-query-history.mjs && node node_modules/.cache/check-query-history.mjs",
```

- [ ] **Step 4: Chạy để xác nhận fail**

Run: `npm run check:query-history`
Expected: FAIL — không resolve được `../src/main/query-history`.

- [ ] **Step 5: Tạo `src/main/query-history.ts`**

```ts
import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { QueryHistoryEntry } from '@shared/types';

const CAP = 500;

/**
 * Thêm một phần tử và giữ danh sách không vượt quá `cap`, đẩy phần tử cũ nhất ra.
 * Tách riêng để kiểm được headless (không đụng fs/electron).
 */
export function pushCapped<T>(list: T[], entry: T, cap: number): T[] {
  const next = [...list, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Lưu lịch sử query vào userData/query-history.json.
 *
 * LƯU Ý BẢO MẬT (có chủ ý, xem PRD): file lưu TOÀN VĂN mọi query, gồm cả dữ liệu nhạy
 * cảm trong mệnh đề WHERE, và KHÔNG mã hóa — khác với mật khẩu kết nối vốn đi qua
 * safeStorage trong secure-store.ts. Chấp nhận được cho công cụ dev chạy local.
 */
export class QueryHistoryStore {
  private file: string;
  private entries: QueryHistoryEntry[] = [];

  constructor() {
    this.file = join(app.getPath('userData'), 'query-history.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as { entries?: QueryHistoryEntry[] };
      this.entries = parsed.entries ?? [];
    } catch {
      // File hỏng thì bắt đầu lại từ rỗng — lịch sử không đáng để chặn app khởi động.
      this.entries = [];
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify({ entries: this.entries }, null, 2), 'utf-8');
    } catch {
      // Ghi lịch sử thất bại không được làm hỏng việc chạy query.
    }
  }

  /** Mới nhất trước. */
  list(): QueryHistoryEntry[] {
    return [...this.entries].reverse();
  }

  add(entry: Omit<QueryHistoryEntry, 'id'>): void {
    this.entries = pushCapped(this.entries, { ...entry, id: randomUUID() }, CAP);
    this.persist();
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }
}
```

- [ ] **Step 6: Chạy lại kiểm chứng + typecheck**

Run: `npm run check:query-history && npm run typecheck`
Expected: script PASS (`OK: query-history`); typecheck **FAIL** vì preload chưa hiện thực hai method mới của `RendererApi`. Task 2 làm xanh lại.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/main/query-history.ts scripts/check-query-history.ts package.json
git commit -m "$(cat <<'EOF'
feat(history): kiểu QueryHistoryEntry + QueryHistoryStore (cap 500 FIFO)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Ghi ở IPC + preload

**Files:** `src/main/ipc.ts`, `src/preload/index.ts`

**Interfaces consumed:** `QueryHistoryStore` từ Task 1.

- [ ] **Step 1: Khởi tạo store trong `registerIpc`**

Cạnh `const store = new SecureStore();`:

```ts
  const history = new QueryHistoryStore();
```

Thêm `import { QueryHistoryStore } from './query-history';`.

- [ ] **Step 2: Bọc handler `query:execute` để ghi cả hai nhánh**

Thay handler hiện tại:

```ts
  ipcMain.handle(
    IpcChannels.queryExecute,
    async (_e, connectionId: string, query: string, target?: QueryTarget, queryId?: string) => {
      const startedAt = Date.now();
      try {
        const res = await sessions.get(connectionId).executeRaw(query, target, queryId);
        history.add({
          connectionId,
          database: target?.database,
          schema: target?.schema,
          sql: query,
          startedAt,
          durationMs: res.durationMs,
          status: 'ok',
          rowCount: res.rowSet?.rows.length ?? res.affectedRows,
        });
        return res;
      } catch (err) {
        history.add({
          connectionId,
          database: target?.database,
          schema: target?.schema,
          sql: query,
          startedAt,
          // executeRaw ném trước khi đo được, nên tự tính từ startedAt.
          durationMs: Date.now() - startedAt,
          status: 'error',
          error: (err as Error).message,
        });
        throw err; // renderer vẫn phải thấy lỗi như cũ
      }
    },
  );
```

Ghi cả nhánh lỗi là chủ đích: query hỏng chính là thứ người ta hay muốn xem lại.

- [ ] **Step 3: Handler list/clear**

```ts
  ipcMain.handle(IpcChannels.historyList, () => history.list());
  ipcMain.handle(IpcChannels.historyClear, () => history.clear());
```

- [ ] **Step 4: Preload**

```ts
  listQueryHistory: () => ipcRenderer.invoke(IpcChannels.historyList),
  clearQueryHistory: () => ipcRenderer.invoke(IpcChannels.historyClear),
```

- [ ] **Step 5: Gate**

Run: `npm run typecheck && npm run check:query-history`
Expected: cả hai PASS. Typecheck xanh trở lại vì preload đã hiện thực đủ `RendererApi`.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "$(cat <<'EOF'
feat(history): ghi mọi lần chạy query ở IPC (cả ca lỗi) + kênh list/clear

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Tab Lịch sử trong QueryPanel

**Files:** `src/renderer/src/components/QueryPanel.tsx`

- [ ] **Step 1: State + nạp lịch sử**

```tsx
  const [history, setHistory] = useState<QueryHistoryEntry[]>([]);
  const [onlyThisConn, setOnlyThisConn] = useState(true);
  const [bottomTab, setBottomTab] = useState<'result' | 'history'>('result');

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await window.api.listQueryHistory());
    } catch (err) {
      message.error(`Không đọc được lịch sử: ${(err as Error).message}`);
    }
  }, []);
```

Nạp khi mount và mỗi lần chạy xong — thêm `void loadHistory();` vào cuối khối `finally` của `run`, và một `useEffect(() => { void loadHistory(); }, [loadHistory])`.

- [ ] **Step 2: Danh sách đã lọc**

```tsx
  const visibleHistory = useMemo(
    () => (onlyThisConn ? history.filter((h) => h.connectionId === targetConnId) : history),
    [history, onlyThisConn, targetConnId],
  );
```

- [ ] **Step 3: Cột bảng lịch sử**

```tsx
  const historyCols: ColumnsType<QueryHistoryEntry> = [
    {
      title: 'Lúc',
      dataIndex: 'startedAt',
      width: 150,
      render: (t: number) => new Date(t).toLocaleString('vi-VN'),
    },
    {
      title: 'Trạng thái',
      dataIndex: 'status',
      width: 100,
      render: (s: QueryHistoryEntry['status']) => (
        <Tag color={s === 'ok' ? 'green' : 'red'}>{s === 'ok' ? 'OK' : 'Lỗi'}</Tag>
      ),
    },
    { title: 'ms', dataIndex: 'durationMs', width: 80, align: 'right', render: (v: number) => v.toFixed(0) },
    { title: 'Dòng', dataIndex: 'rowCount', width: 80, align: 'right', render: (v?: number) => v ?? '—' },
    ...(onlyThisConn
      ? []
      : [
          {
            title: 'Kết nối',
            dataIndex: 'connectionId',
            width: 160,
            render: (id: string) => connections.find((c) => c.id === id)?.name ?? id,
          } as ColumnsType<QueryHistoryEntry>[number],
        ]),
    { title: 'SQL', dataIndex: 'sql', ellipsis: true },
  ];
```

Cột `Kết nối` chỉ hiện khi đang xem tất cả — xem một kết nối thì cột đó chỉ tốn chỗ.

- [ ] **Step 4: Vùng dưới editor thành Tabs**

Thay khối `<div className="grid-wrap ag-theme-quartz">…</div>` (hiện ở cuối `QueryPanel.tsx`) bằng:

```tsx
      <div className="grid-wrap">
        <Tabs
          style={{ height: '100%' }}
          className="full-height-tabs"
          activeKey={bottomTab}
          onChange={(k) => setBottomTab(k as 'result' | 'history')}
          items={[
            {
              key: 'result',
              label: 'Kết quả',
              children: (
                <div className="ag-theme-quartz" style={{ height: '100%' }}>
                  {result?.rowSet ? (
                    <AgGridReact
                      rowData={result.rowSet.rows}
                      columnDefs={columnDefs}
                      defaultColDef={{ minWidth: 120, filter: true }}
                    />
                  ) : (
                    <pre className="result-message">{result?.message ?? '(chưa có kết quả)'}</pre>
                  )}
                </div>
              ),
            },
            {
              key: 'history',
              label: 'Lịch sử',
              children: (
                <div style={{ height: '100%', overflow: 'auto', padding: 8 }}>
                  <Space style={{ marginBottom: 8 }}>
                    <Checkbox checked={onlyThisConn} onChange={(e) => setOnlyThisConn(e.target.checked)}>
                      Chỉ kết nối này
                    </Checkbox>
                    <Button
                      size="small"
                      danger
                      onClick={() =>
                        Modal.confirm({
                          title: 'Xóa toàn bộ lịch sử query?',
                          content: 'Không thể hoàn tác.',
                          okText: 'Xóa',
                          okType: 'danger',
                          cancelText: 'Hủy',
                          onOk: async () => {
                            await window.api.clearQueryHistory();
                            await loadHistory();
                          },
                        })
                      }
                    >
                      Xóa lịch sử
                    </Button>
                  </Space>
                  <Table<QueryHistoryEntry>
                    size="small"
                    rowKey="id"
                    pagination={false}
                    columns={historyCols}
                    dataSource={visibleHistory}
                    locale={{ emptyText: 'Chưa có query nào' }}
                    onRow={(r) => ({
                      style: { cursor: 'pointer' },
                      onClick: () => {
                        editorRef.current?.setValue(r.sql);
                        setBottomTab('result');
                      },
                    })}
                  />
                </div>
              ),
            },
          ]}
        />
      </div>
```

Lưu ý: class `ag-theme-quartz` chuyển từ div ngoài vào trong tab Kết quả, vì tab Lịch sử không dùng ag-grid. `full-height-tabs` đã có sẵn trong `styles.css` (App.tsx đang dùng).

- [ ] **Step 5: Import**

Thêm `Checkbox`, `Modal`, `Table`, `Tabs`, `Tag` vào import từ `antd`; `ColumnsType` từ `antd/es/table`; `QueryHistoryEntry` vào import type từ `@shared/types`; `useCallback` vào import từ `react`.

- [ ] **Step 6: Gate**

Run: `npm run typecheck && npm run build`
Expected: cả hai PASS.

- [ ] **Step 7: Kiểm tay**

Run: `npm run dev`. Theo tiêu chí PRD mục "History":
1. Chạy vài query thành công và một query lỗi → cả hai đều có trong tab Lịch sử, đúng trạng thái.
2. Click một dòng → SQL nạp lại vào editor, tab chuyển về Kết quả.
3. Thoát app rồi mở lại → lịch sử vẫn còn.
4. Bỏ tick `Chỉ kết nối này` → thấy query của kết nối khác, cột Kết nối xuất hiện.
5. `Xóa lịch sử` → xác nhận rồi bảng rỗng, mở lại app vẫn rỗng.
6. Kiểm file `~/Library/Application Support/db_manager/query-history.json` tồn tại và đúng dạng.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/QueryPanel.tsx
git commit -m "$(cat <<'EOF'
feat(history): tab Lịch sử dưới editor, click để nạp lại query

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage (PRD mục "Tính năng 2"):** ghi ở main trong handler `query:execute` ✓; ghi cả ca lỗi ✓; JSON ở userData theo khuôn SecureStore ✓; cap 500 FIFO ✓; lưu `connectionId` không lưu tên ✓; kênh `history:list`/`history:clear` ✓; Tabs Kết quả|Lịch sử ✓; click nạp lại SQL ✓; checkbox `Chỉ kết nối này` bật sẵn ✓; nút xóa có xác nhận ✓; ghi chú bảo mật nằm trong docstring của store ✓.

**Placeholder scan:** không TBD; mọi step có mã đầy đủ; script kiểm có assertion cụ thể.

**Type consistency:** `QueryHistoryEntry` dùng nhất quán ở cả ba task; `pushCapped<T>(list, entry, cap)` một chữ ký; `Omit<QueryHistoryEntry,'id'>` ở `add` khớp với object mà IPC dựng (không truyền `id`).

**Điểm cố ý:** Task 1 kết thúc với typecheck ĐỎ vì `RendererApi` có method mà preload chưa hiện thực — Step 6 nói rõ. Gộp preload vào Task 1 sẽ khiến task đó vừa định nghĩa kiểu vừa nối IPC, khó review hơn.

**Rủi ro còn lại:** `rowCount` lấy `res.rowSet?.rows.length` là số dòng của **trang kết quả trả về**, không phải tổng số dòng câu lệnh chạm tới. Với `executeRaw` thì hai thứ này trùng nhau vì không phân trang, nhưng nếu sau này thêm phân trang cho ô query thì con số này sẽ sai nghĩa.
