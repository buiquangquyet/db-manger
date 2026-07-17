# MongoDB Document View & Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép xem chi tiết, sửa cả document (JSON), thêm và xóa document MongoDB từ tab "Dữ liệu".

**Architecture:** Renderer mở một modal Monaco (JSON) để xem/sửa/thêm document; các thao tác đi qua preload → IPC → `MongoAdapter`, nơi dùng `EJSON` để parse/stringify giữ nguyên kiểu BSON. Nguồn dữ liệu khi sửa là fetch lại document theo `_id` (EJSON), không lấy từ ô grid đã mất kiểu.

**Tech Stack:** Electron + React + TypeScript + Ant Design + ag-grid + Monaco editor + driver `mongodb` (re-export `EJSON`, `ObjectId`).

## Global Constraints

- **Không có test framework** trong repo. Cổng kiểm tra tự động của mỗi task là `npm run typecheck` (phải sạch). Kiểm thử hành vi làm thủ công ở Task 6 bằng `npm run dev`.
- `strict: true` ở cả `tsconfig.node.json` và `tsconfig.web.json`.
- MongoDB giữ `inlineEdit: false`; luồng document dùng cờ mới `documentEdit: true`.
- Giữ nguyên kiểu BSON qua `EJSON` (import từ `'mongodb'`, không thêm dependency mới).
- Mọi chuỗi UI bằng tiếng Việt, theo phong cách file hiện có.
- Thêm field `documentEdit` vào interface `Capabilities` là **breaking** với cả 4 adapter — phải cập nhật cả 4 trong Task 1 để typecheck xanh.
- Import path alias: `@shared/types`.

---

### Task 1: Shared types — cờ `documentEdit`, method adapter, kênh IPC, RendererApi

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/adapters/mongo.ts:18-29` (capabilities)
- Modify: `src/main/adapters/postgres.ts:21-28` (capabilities)
- Modify: `src/main/adapters/mariadb.ts:21-28` (capabilities)
- Modify: `src/main/adapters/redis.ts:18-26` (capabilities)

**Interfaces:**
- Produces:
  - `Capabilities.documentEdit: boolean`
  - `DatabaseAdapter.getDocument?(target: DataTarget, rowKey: Record<string, unknown>): Promise<string>`
  - `DatabaseAdapter.updateDocument?(target: DataTarget, rowKey: Record<string, unknown>, ejson: string): Promise<void>`
  - `DatabaseAdapter.insertDocument?(target: DataTarget, ejson: string): Promise<void>`
  - `IpcChannels.dataGetDocument = 'data:getDocument'`, `dataUpdateDocument = 'data:updateDocument'`, `dataInsertDocument = 'data:insertDocument'`
  - `RendererApi.getDocument`, `RendererApi.updateDocument`, `RendererApi.insertDocument`

- [ ] **Step 1: Thêm cờ `documentEdit` vào interface `Capabilities`**

Trong `src/shared/types.ts`, thêm dòng ngay sau `inlineEdit` (dòng 66):

```ts
  /** Cho phép sửa dữ liệu inline trong grid hay không. */
  inlineEdit: boolean;
  /** Cho phép xem/sửa cả document dạng JSON (mô hình document như MongoDB). */
  documentEdit: boolean;
```

- [ ] **Step 2: Thêm 3 method optional vào interface `DatabaseAdapter`**

Trong `src/shared/types.ts`, ngay sau method `deleteRow(...)` (kết thúc quanh dòng 271), thêm:

```ts
  /** (Document DB) Lấy 1 document theo khóa định danh, trả chuỗi EJSON (pretty). */
  getDocument?(target: DataTarget, rowKey: Record<string, unknown>): Promise<string>;

  /** (Document DB) Thay thế 1 document (theo _id cũ) bằng nội dung EJSON mới. */
  updateDocument?(target: DataTarget, rowKey: Record<string, unknown>, ejson: string): Promise<void>;

  /** (Document DB) Thêm 1 document mới từ chuỗi EJSON. */
  insertDocument?(target: DataTarget, ejson: string): Promise<void>;
```

- [ ] **Step 3: Thêm 3 kênh IPC**

Trong `src/shared/types.ts`, trong object `IpcChannels`, ngay sau `dataDelete: 'data:delete',`:

```ts
  dataDelete: 'data:delete',
  dataGetDocument: 'data:getDocument',
  dataUpdateDocument: 'data:updateDocument',
  dataInsertDocument: 'data:insertDocument',
```

- [ ] **Step 4: Thêm 3 method vào interface `RendererApi`**

Trong `src/shared/types.ts`, ngay sau `deleteRow(...)` trong `RendererApi` (quanh dòng 340):

```ts
  deleteRow(connectionId: string, target: DataTarget, rowKey: Record<string, unknown>): Promise<void>;
  getDocument(connectionId: string, target: DataTarget, rowKey: Record<string, unknown>): Promise<string>;
  updateDocument(
    connectionId: string,
    target: DataTarget,
    rowKey: Record<string, unknown>,
    ejson: string,
  ): Promise<void>;
  insertDocument(connectionId: string, target: DataTarget, ejson: string): Promise<void>;
```

- [ ] **Step 5: Đặt `documentEdit` cho cả 4 adapter**

`src/main/adapters/mongo.ts` — trong `capabilities`, thêm sau `inlineEdit: false,`:

```ts
    inlineEdit: false,
    documentEdit: true,
```

`src/main/adapters/postgres.ts` — sau `inlineEdit: true,`:

```ts
    inlineEdit: true,
    documentEdit: false,
```

`src/main/adapters/mariadb.ts` — sau `inlineEdit: true,`:

```ts
    inlineEdit: true,
    documentEdit: false,
```

`src/main/adapters/redis.ts` — sau `inlineEdit: true,`:

```ts
    inlineEdit: true,
    documentEdit: false,
```

- [ ] **Step 6: Chạy typecheck (kỳ vọng lỗi ở preload)**

Run: `npm run typecheck`
Expected: `typecheck:node` báo lỗi vì `src/preload/index.ts` chưa hiện thực 3 method mới của `RendererApi`. Đây là dự kiến — Task 3 sẽ sửa. (Nếu muốn commit xanh trước, làm Task 3 trước khi commit; theo thứ tự này ta commit cùng Task 3.)

Ghi chú: KHÔNG commit ở task này vì preload chưa khớp interface. Chuyển sang Task 2 & 3 rồi commit chung ở cuối Task 3.

---

### Task 2: MongoAdapter — getDocument / updateDocument / insertDocument / deleteRow

**Files:**
- Modify: `src/main/adapters/mongo.ts`

**Interfaces:**
- Consumes: `EJSON`, `ObjectId` từ `'mongodb'`; `DataTarget` từ `@shared/types`.
- Produces: hiện thực `getDocument`, `updateDocument`, `insertDocument`, `deleteRow` trên `MongoAdapter`; đánh dấu `_id` là `isPrimaryKey` trong `readRows`.

- [ ] **Step 1: Import EJSON và ObjectId**

Sửa dòng 1 của `src/main/adapters/mongo.ts`:

```ts
import { MongoClient, ObjectId, EJSON } from 'mongodb';
```

- [ ] **Step 2: Đánh dấu `_id` là primary key trong `readRows`**

Trong `readRows`, thay dòng dựng `columns` (dòng 161):

```ts
    const columns = [...colSet].map((name) => ({ name, isPrimaryKey: name === '_id' }));
```

- [ ] **Step 3: Thêm helper `toId` (private) trong class**

Thêm method private (đặt ngay trên `updateCell`, quanh dòng 285):

```ts
  /** Chuyển _id từ rowKey về ObjectId nếu là chuỗi hex 24 ký tự; ngược lại giữ nguyên. */
  private toId(rowKey: Record<string, unknown>): unknown {
    const id = rowKey._id;
    if (typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id)) return new ObjectId(id);
    return id;
  }
```

- [ ] **Step 4: Hiện thực `getDocument`, `updateDocument`, `insertDocument`**

Thêm 3 method vào class (đặt cạnh `toId`):

```ts
  async getDocument(target: DataTarget, rowKey: Record<string, unknown>): Promise<string> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const col = this.c().db(database).collection(target.name);
    const doc = await col.findOne({ _id: this.toId(rowKey) as never });
    if (!doc) throw new Error('Không tìm thấy document.');
    return EJSON.stringify(doc, undefined, 2);
  }

  async updateDocument(
    target: DataTarget,
    rowKey: Record<string, unknown>,
    ejson: string,
  ): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const col = this.c().db(database).collection(target.name);
    const id = this.toId(rowKey);
    const doc = EJSON.parse(ejson) as Record<string, unknown>;
    // Không cho đổi _id.
    if ('_id' in doc && EJSON.stringify(doc._id) !== EJSON.stringify(id)) {
      throw new Error('Không thể thay đổi _id của document.');
    }
    // Loại _id khỏi phần thay thế để tránh lỗi immutable field.
    delete doc._id;
    const res = await col.replaceOne({ _id: id as never }, doc);
    if (res.matchedCount === 0) throw new Error('Không tìm thấy document để cập nhật.');
  }

  async insertDocument(target: DataTarget, ejson: string): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const col = this.c().db(database).collection(target.name);
    const doc = EJSON.parse(ejson) as Record<string, unknown>;
    await col.insertOne(doc as never);
  }
```

- [ ] **Step 5: Hiện thực `deleteRow` (thay `throw` hiện tại)**

Thay method `deleteRow` (dòng 293-295) bằng:

```ts
  async deleteRow(target: DataTarget, rowKey: Record<string, unknown>): Promise<void> {
    const database = target.database ?? this.config.database;
    if (!database) throw new Error('Thiếu tên database cho MongoDB');
    const res = await this.c()
      .db(database)
      .collection(target.name)
      .deleteOne({ _id: this.toId(rowKey) as never });
    if (res.deletedCount === 0) throw new Error('Không tìm thấy document để xóa.');
  }
```

Giữ nguyên `updateCell` và `insertRow` (vẫn `throw` — không dùng cho luồng document).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: vẫn còn lỗi ở `src/preload/index.ts` (chưa làm Task 3). Không lỗi mới trong `mongo.ts`.

---

### Task 3: IPC handlers + preload wiring

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `IpcChannels.dataGetDocument/dataUpdateDocument/dataInsertDocument`; adapter methods `getDocument/updateDocument/insertDocument`.
- Produces: `window.api.getDocument/updateDocument/insertDocument`.

- [ ] **Step 1: Đăng ký 3 handler trong `ipc.ts`**

Trong `src/main/ipc.ts`, ngay sau block `IpcChannels.dataDelete` (kết thúc quanh dòng 99), thêm:

```ts
  ipcMain.handle(
    IpcChannels.dataGetDocument,
    (_e, connectionId: string, target: DataTarget, rowKey: Record<string, unknown>) => {
      const adapter = sessions.get(connectionId);
      if (!adapter.getDocument) throw new Error('Loại DB này không hỗ trợ xem document.');
      return adapter.getDocument(target, rowKey);
    },
  );

  ipcMain.handle(
    IpcChannels.dataUpdateDocument,
    (_e, connectionId: string, target: DataTarget, rowKey: Record<string, unknown>, ejson: string) => {
      const adapter = sessions.get(connectionId);
      if (!adapter.updateDocument) throw new Error('Loại DB này không hỗ trợ sửa document.');
      return adapter.updateDocument(target, rowKey, ejson);
    },
  );

  ipcMain.handle(
    IpcChannels.dataInsertDocument,
    (_e, connectionId: string, target: DataTarget, ejson: string) => {
      const adapter = sessions.get(connectionId);
      if (!adapter.insertDocument) throw new Error('Loại DB này không hỗ trợ thêm document.');
      return adapter.insertDocument(target, ejson);
    },
  );
```

- [ ] **Step 2: Thêm 3 hàm vào preload**

Trong `src/preload/index.ts`, ngay sau `deleteRow: ...` (dòng 54-55), thêm:

```ts
  deleteRow: (connectionId: string, target: DataTarget, rowKey: Record<string, unknown>) =>
    ipcRenderer.invoke(IpcChannels.dataDelete, connectionId, target, rowKey),
  getDocument: (connectionId: string, target: DataTarget, rowKey: Record<string, unknown>) =>
    ipcRenderer.invoke(IpcChannels.dataGetDocument, connectionId, target, rowKey),
  updateDocument: (
    connectionId: string,
    target: DataTarget,
    rowKey: Record<string, unknown>,
    ejson: string,
  ) => ipcRenderer.invoke(IpcChannels.dataUpdateDocument, connectionId, target, rowKey, ejson),
  insertDocument: (connectionId: string, target: DataTarget, ejson: string) =>
    ipcRenderer.invoke(IpcChannels.dataInsertDocument, connectionId, target, ejson),
```

- [ ] **Step 3: Typecheck (kỳ vọng sạch)**

Run: `npm run typecheck`
Expected: PASS (không lỗi). Task 1–3 đã khớp interface đầy đủ.

- [ ] **Step 4: Commit (Task 1–3)**

```bash
git add src/shared/types.ts src/main/adapters/mongo.ts src/main/adapters/postgres.ts src/main/adapters/mariadb.ts src/main/adapters/redis.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat(mongo): backend cho xem/sửa/thêm/xóa document (EJSON)"
```

---

### Task 4: Monaco JSON + component `DocumentModal`

**Files:**
- Modify: `src/renderer/src/monaco-setup.ts`
- Create: `src/renderer/src/components/DocumentModal.tsx`

**Interfaces:**
- Consumes: `window.api.getDocument/updateDocument/insertDocument`; `monaco` từ `../monaco-setup`; `DataTarget`.
- Produces: `DocumentModal` với props `{ open, mode, connectionId, target, rowKey?, onClose, onSaved }` và type `DocumentModalMode = 'view' | 'edit' | 'create'`.

- [ ] **Step 1: Bật ngôn ngữ JSON cho Monaco**

Thay toàn bộ `src/renderer/src/monaco-setup.ts` bằng:

```ts
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
// Chỉ nạp highlighting cho các ngôn ngữ cần — giảm kích thước bundle.
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';

// Monaco cần web worker cho các dịch vụ nền. JSON dùng json worker (validate/format),
// còn lại dùng editor worker cơ bản.
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    label === 'json' ? new jsonWorker() : new editorWorker(),
};

export { monaco };
```

- [ ] **Step 2: Tạo `DocumentModal.tsx`**

Tạo file `src/renderer/src/components/DocumentModal.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Button, Modal, Space, Spin, message } from 'antd';
import { monaco } from '../monaco-setup';
import type { DataTarget } from '@shared/types';

export type DocumentModalMode = 'view' | 'edit' | 'create';

interface Props {
  open: boolean;
  mode: DocumentModalMode;
  connectionId: string;
  target: DataTarget;
  /** Bắt buộc cho mode 'view'/'edit' để định danh document theo _id. */
  rowKey?: Record<string, unknown>;
  onClose: () => void;
  /** Gọi sau khi lưu/thêm thành công để grid reload. */
  onSaved: () => void;
}

const TITLES: Record<DocumentModalMode, string> = {
  view: 'Chi tiết document',
  edit: 'Sửa document',
  create: 'Thêm document',
};

export function DocumentModal({ open, mode, connectionId, target, rowKey, onClose, onSaved }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Tạo editor khi mở modal; dispose khi đóng.
  useEffect(() => {
    if (!open || !host.current) return;
    const editor = monaco.editor.create(host.current, {
      value: '',
      language: 'json',
      readOnly: mode === 'view',
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, [open, mode]);

  // Nạp nội dung: create -> khung rỗng; view/edit -> fetch theo _id.
  useEffect(() => {
    if (!open) return;
    if (mode === 'create') {
      editorRef.current?.setValue('{\n  \n}');
      return;
    }
    if (!rowKey) return;
    setLoading(true);
    window.api
      .getDocument(connectionId, target, rowKey)
      .then((ejson) => editorRef.current?.setValue(ejson))
      .catch((err) => message.error(`Tải document thất bại: ${(err as Error).message}`))
      .finally(() => setLoading(false));
  }, [open, mode, rowKey, connectionId, target]);

  const handleFormat = () => {
    void editorRef.current?.getAction('editor.action.formatDocument')?.run();
  };

  const handleSave = async () => {
    const text = editorRef.current?.getValue() ?? '';
    try {
      JSON.parse(text); // bắt lỗi cú pháp phía client trước khi gửi
    } catch (err) {
      message.error(`JSON không hợp lệ: ${(err as Error).message}`);
      return;
    }
    setSaving(true);
    try {
      if (mode === 'create') {
        await window.api.insertDocument(connectionId, target, text);
        message.success('Đã thêm document');
      } else if (rowKey) {
        await window.api.updateDocument(connectionId, target, rowKey, text);
        message.success('Đã cập nhật document');
      }
      onSaved();
      onClose();
    } catch (err) {
      message.error(`Lưu thất bại: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={TITLES[mode]}
      width={720}
      onCancel={onClose}
      destroyOnClose
      footer={
        mode === 'view' ? (
          <Button onClick={onClose}>Đóng</Button>
        ) : (
          <Space>
            <Button onClick={handleFormat}>Định dạng</Button>
            <Button onClick={onClose}>Hủy</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>
              Lưu
            </Button>
          </Space>
        )
      }
    >
      <Spin spinning={loading}>
        <div ref={host} style={{ height: 420, border: '1px solid #f0f0f0' }} />
      </Spin>
    </Modal>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/monaco-setup.ts src/renderer/src/components/DocumentModal.tsx
git commit -m "feat(ui): DocumentModal (Monaco JSON) cho xem/sửa/thêm document"
```

---

### Task 5: Tích hợp vào DataGridView + App.tsx

**Files:**
- Modify: `src/renderer/src/components/DataGridView.tsx`
- Modify: `src/renderer/src/App.tsx:96-102`

**Interfaces:**
- Consumes: `DocumentModal`, `DocumentModalMode`; prop `documentEdit: boolean`; `session.capabilities.documentEdit`.
- Produces: DataGridView hỗ trợ document mode (double-click xem/sửa, thêm/xóa document).

- [ ] **Step 1: Import DocumentModal và thêm prop `documentEdit`**

Trong `src/renderer/src/components/DataGridView.tsx`, thêm import sau dòng 9:

```ts
import { AddRowModal } from './AddRowModal';
import { DocumentModal, type DocumentModalMode } from './DocumentModal';
```

Cập nhật interface `Props` (dòng 13-18):

```ts
interface Props {
  connectionId: string;
  target: DataTarget;
  /** Loại DB có cho sửa/thêm/xóa dữ liệu inline hay không (từ capabilities). */
  inlineEdit: boolean;
  /** Loại DB dùng luồng document JSON (MongoDB) hay không. */
  documentEdit: boolean;
}

export function DataGridView({ connectionId, target, inlineEdit, documentEdit }: Props) {
```

- [ ] **Step 2: Thêm state cho DocumentModal**

Ngay sau `const [addOpen, setAddOpen] = useState(false);` (dòng 24), thêm:

```ts
  const [docModal, setDocModal] = useState<{ mode: DocumentModalMode; rowKey?: Record<string, unknown> } | null>(null);
```

- [ ] **Step 3: Tách điều kiện quyền cho hai luồng (inline vs document)**

Thay khối `hasPrimaryKey/canEdit/canInsert` (dòng 68-70) bằng:

```ts
  // Chỉ cho sửa/xóa khi DB hỗ trợ VÀ bảng có khóa chính (để xác định dòng an toàn).
  const hasPrimaryKey = useMemo(() => rowSet?.columns.some((c) => c.isPrimaryKey) ?? false, [rowSet?.columns]);
  // Sửa ô inline: chỉ luồng SQL.
  const canInlineEdit = inlineEdit && hasPrimaryKey;
  // Xóa dòng: cả SQL (inline) lẫn document (Mongo) đều dùng được nếu có khóa.
  const canDelete = (inlineEdit || documentEdit) && hasPrimaryKey;
  // Thêm dòng/document.
  const canInsert = documentEdit || (inlineEdit && (rowSet?.columns.length ?? 0) > 0);
```

- [ ] **Step 4: Cập nhật `columnDefs` (editable theo inline, checkbox theo canDelete)**

Trong `columnDefs` (dòng 84-110), sửa hai chỗ:

`editable` của cột dữ liệu (dòng 92):

```ts
      // Không cho sửa cột khóa chính; chỉ sửa inline ở luồng SQL.
      editable: canInlineEdit && !c.isPrimaryKey,
```

Điều kiện thêm cột checkbox (dòng 97) — đổi `canEdit` thành `canDelete`:

```ts
    // Cột checkbox chọn dòng (khi có thể xóa).
    if (canDelete) {
```

Và cập nhật dependency của `useMemo` (dòng 110):

```ts
  }, [rowSet?.columns, canInlineEdit, canDelete]);
```

- [ ] **Step 5: Mở DocumentModal khi double-click (document mode) và đổi nút "Thêm dòng"**

Thêm handler double-click ngay trên `handleExport` (quanh dòng 128):

```ts
  const onRowDoubleClicked = useCallback(
    (e: { data: Record<string, unknown> }) => {
      if (!documentEdit) return;
      setDocModal({ mode: 'edit', rowKey: buildRowKey(e.data) });
    },
    [documentEdit, buildRowKey],
  );

  const handleAddClick = () => {
    if (documentEdit) setDocModal({ mode: 'create' });
    else setAddOpen(true);
  };
```

Sửa nút "Thêm dòng" (dòng 199-201) để gọi `handleAddClick`:

```tsx
          <Button size="small" icon={<PlusOutlined />} disabled={!canInsert} onClick={handleAddClick}>
            Thêm dòng
          </Button>
```

- [ ] **Step 6: Cập nhật điều kiện disable nút "Xóa dòng" và chú thích chân grid**

Nút Xóa dòng (dòng 202-209) — đổi `!canEdit` thành `!canDelete`:

```tsx
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={!canDelete || selectedCount === 0}
            onClick={handleDelete}
          >
            Xóa dòng{selectedCount > 0 ? ` (${selectedCount})` : ''}
          </Button>
```

Chú thích chân grid (dòng 271-277) — thay khối `{canEdit ? ... }` bằng:

```tsx
          {documentEdit
            ? canDelete
              ? 'Double-click để xem/sửa document · tick chọn dòng để xóa'
              : 'Double-click để xem/sửa document'
            : canInlineEdit
              ? 'Double-click ô để sửa · tick chọn dòng để xóa (cột 🔑 không sửa được)'
              : inlineEdit
                ? 'Không sửa/xóa được: bảng thiếu khóa chính'
                : 'Loại DB này chưa hỗ trợ sửa dữ liệu'}
```

- [ ] **Step 7: Gắn `onRowDoubleClicked` vào grid và render DocumentModal**

Thêm prop vào `<AgGridReact>` (cạnh `onCellValueChanged`, dòng 263):

```tsx
            onCellValueChanged={onCellValueChanged}
            onRowDoubleClicked={onRowDoubleClicked}
```

Ngay sau `<AddRowModal ... />` (dòng 292-297), thêm:

```tsx
      {docModal && (
        <DocumentModal
          open
          mode={docModal.mode}
          connectionId={connectionId}
          target={target}
          rowKey={docModal.rowKey}
          onClose={() => setDocModal(null)}
          onSaved={() => void load(page)}
        />
      )}
```

- [ ] **Step 8: Truyền prop `documentEdit` từ App.tsx**

Trong `src/renderer/src/App.tsx`, thêm dòng vào `<DataGridView>` (sau dòng 101):

```tsx
              inlineEdit={session.capabilities.inlineEdit}
              documentEdit={session.capabilities.documentEdit}
```

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/components/DataGridView.tsx src/renderer/src/App.tsx
git commit -m "feat(ui): tích hợp luồng document MongoDB vào DataGridView"
```

---

### Task 6: Nghiệm thu end-to-end (thủ công)

**Files:** không sửa code (chỉ chạy app). Nếu phát hiện lỗi, quay lại task tương ứng.

- [ ] **Step 1: Chạy app**

Run: `npm run dev`
(Nếu gặp lỗi TLS self-signed do mạng công ty: `NODE_OPTIONS=--use-system-ca npm run dev`.)

- [ ] **Step 2: Kịch bản kiểm thử với 1 kết nối MongoDB**

Mở một connection MongoDB → chọn database → chọn collection → tab "Dữ liệu". Kiểm tra lần lượt:

1. **Xem/sửa:** Double-click một dòng → modal hiện JSON đầy đủ (field lồng nhau, `_id` dạng `{"$oid":"..."}`, Date dạng `{"$date":...}`). Sửa một field text → "Lưu" → grid reload, giá trị đã đổi.
2. **Thêm:** Bấm "Thêm dòng" → modal rỗng → nhập `{"name":"test","n":1}` → "Lưu" → xuất hiện dòng mới trong grid.
3. **Xóa:** Tick chọn dòng vừa thêm → "Xóa dòng" → xác nhận → dòng biến mất.
4. **JSON sai:** Trong modal sửa, xóa một dấu `}` → "Lưu" → báo "JSON không hợp lệ", không đóng modal, không mất nội dung.
5. **Đổi _id:** Sửa giá trị trong `{"$oid":"..."}` thành hex khác hợp lệ → "Lưu" → báo "Không thể thay đổi _id của document".
6. **Định dạng:** Bấm "Định dạng" → JSON được format lại gọn.

- [ ] **Step 3: Không hồi quy với SQL**

Mở một connection MariaDB/Postgres → tab "Dữ liệu" → xác nhận vẫn sửa được inline từng ô như trước, double-click ô để sửa (KHÔNG mở modal document), nút Thêm dòng mở form cột như cũ.

- [ ] **Step 4: Ghi nhận kết quả**

Nếu tất cả bước đạt: đánh dấu plan hoàn tất. Nếu có lỗi: mô tả bước lỗi + thông báo, quay lại task liên quan để sửa.

---

## Self-Review

**Spec coverage:**
- Xem chi tiết document → Task 4 (view/edit modal) + Task 5 (double-click).
- Sửa cả document (JSON, EJSON) → Task 2 (`updateDocument`) + Task 4/5.
- Thêm document → Task 2 (`insertDocument`) + Task 5 (nút Thêm → create mode).
- Xóa document → Task 2 (`deleteRow`) + Task 5 (checkbox + Xóa dòng).
- Cờ `documentEdit`, `_id` là PK → Task 1 + Task 2.
- IPC/preload/RendererApi → Task 1 (khai báo) + Task 3 (hiện thực).
- Monaco JSON → Task 4.
- Cập nhật 4 adapter capabilities → Task 1 Step 5.
- App.tsx truyền prop → Task 5 Step 8.
- Xử lý lỗi (JSON sai, đổi _id, không tồn tại) → Task 2 + Task 4 + Task 6 kịch bản 4/5.
- Không hồi quy SQL → Task 6 Step 3.

**Placeholder scan:** Không có TBD/TODO; mọi step có code hoặc lệnh cụ thể.

**Type consistency:** `documentEdit`, `getDocument/updateDocument/insertDocument`, `DocumentModalMode`, `canInlineEdit/canDelete/canInsert` dùng nhất quán giữa các task. `toId` là private helper trong `MongoAdapter`. `EJSON`/`ObjectId` import từ `'mongodb'`.
