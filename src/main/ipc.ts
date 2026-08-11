import { ipcMain } from 'electron';
import type {
  AlterOperation,
  ColumnSpec,
  ConnectionConfig,
  DataTarget,
  PageRequest,
  QueryTarget,
  TreeNode,
} from '@shared/types';
import { IpcChannels } from '@shared/types';
import type { IoFormat } from '@shared/types';
import { SecureStore } from './secure-store';
import { SessionManager } from './session-manager';
import { copyTableSql, exportTable, importTable, saveTextFile } from './io';
import { runTransfer } from './transfer';
import type { TransferRequest } from '@shared/types';

export function registerIpc(): void {
  const store = new SecureStore();
  const sessions = new SessionManager();

  // Cờ hủy theo transferId — set bởi transfer:cancel, đọc bởi runTransfer.
  const transferFlags = new Map<string, { cancelled: boolean }>();

  ipcMain.handle(IpcChannels.ping, () => 'pong');

  ipcMain.handle(IpcChannels.connectionsList, () => store.list());

  ipcMain.handle(IpcChannels.connectionsSave, (_e, config: ConnectionConfig) => store.save(config));

  ipcMain.handle(IpcChannels.connectionsDelete, async (_e, id: string) => {
    await sessions.close(id);
    store.delete(id);
  });

  ipcMain.handle(IpcChannels.connectionsTest, (_e, config: ConnectionConfig) => sessions.test(config));

  ipcMain.handle(IpcChannels.sessionOpen, async (_e, connectionId: string) => {
    const config = store.hydrate(connectionId);
    if (!config) throw new Error(`Không tìm thấy kết nối ${connectionId}`);
    const adapter = await sessions.open(config);
    return adapter.capabilities;
  });

  ipcMain.handle(IpcChannels.sessionClose, (_e, connectionId: string) => sessions.close(connectionId));

  ipcMain.handle(IpcChannels.treeRoot, (_e, connectionId: string) =>
    sessions.get(connectionId).getRootNodes(),
  );

  ipcMain.handle(IpcChannels.treeChildren, (_e, connectionId: string, node: TreeNode) =>
    sessions.get(connectionId).getChildNodes(node),
  );

  ipcMain.handle(IpcChannels.treeTableList, (_e, connectionId: string, database?: string, schema?: string) =>
    sessions.get(connectionId).getTableList(database, schema),
  );

  ipcMain.handle(
    IpcChannels.schemaObjects,
    (_e, connectionId: string, database?: string, schema?: string) => {
      const adapter = sessions.get(connectionId);
      return adapter.getSchemaObjects ? adapter.getSchemaObjects(database, schema) : [];
    },
  );

  ipcMain.handle(IpcChannels.dataRead, (_e, connectionId: string, target: DataTarget, page: PageRequest) =>
    sessions.get(connectionId).readRows(target, page),
  );

  ipcMain.handle(IpcChannels.dataStructure, (_e, connectionId: string, target: DataTarget) =>
    sessions.get(connectionId).getStructure(target),
  );

  ipcMain.handle(IpcChannels.dataAlter, (_e, connectionId: string, target: DataTarget, op: AlterOperation) =>
    sessions.get(connectionId).alterTable(target, op),
  );

  ipcMain.handle(IpcChannels.objectCreate, (_e, connectionId: string, target: DataTarget, columns: ColumnSpec[]) =>
    sessions.get(connectionId).createTable(target, columns),
  );

  ipcMain.handle(IpcChannels.objectDrop, (_e, connectionId: string, target: DataTarget) =>
    sessions.get(connectionId).dropTable(target),
  );

  ipcMain.handle(IpcChannels.objectTruncate, (_e, connectionId: string, target: DataTarget) =>
    sessions.get(connectionId).truncateTable(target),
  );

  ipcMain.handle(IpcChannels.objectRename, (_e, connectionId: string, target: DataTarget, newName: string) =>
    sessions.get(connectionId).renameTable(target, newName),
  );

  ipcMain.handle(IpcChannels.databaseCreate, (_e, connectionId: string, name: string) =>
    sessions.get(connectionId).createDatabase(name),
  );

  ipcMain.handle(IpcChannels.databaseDrop, (_e, connectionId: string, name: string) =>
    sessions.get(connectionId).dropDatabase(name),
  );

  ipcMain.handle(
    IpcChannels.dataUpdate,
    (_e, connectionId: string, target: DataTarget, rowKey: Record<string, unknown>, column: string, value: unknown) =>
      sessions.get(connectionId).updateCell(target, rowKey, column, value),
  );

  ipcMain.handle(
    IpcChannels.dataInsert,
    (_e, connectionId: string, target: DataTarget, values: Record<string, unknown>) =>
      sessions.get(connectionId).insertRow(target, values),
  );

  ipcMain.handle(
    IpcChannels.dataDelete,
    (_e, connectionId: string, target: DataTarget, rowKey: Record<string, unknown>) =>
      sessions.get(connectionId).deleteRow(target, rowKey),
  );

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

  ipcMain.handle(
    IpcChannels.queryExecute,
    (_e, connectionId: string, query: string, target?: QueryTarget) =>
      sessions.get(connectionId).executeRaw(query, target),
  );

  ipcMain.handle(IpcChannels.ioExport, (_e, connectionId: string, target: DataTarget, format: IoFormat) =>
    exportTable(sessions, connectionId, target, format),
  );

  ipcMain.handle(IpcChannels.ioImport, (_e, connectionId: string, target: DataTarget, format: IoFormat) =>
    importTable(sessions, connectionId, target, format),
  );

  ipcMain.handle(IpcChannels.ioSaveText, (_e, defaultName: string, content: string) =>
    saveTextFile(defaultName, content),
  );

  ipcMain.handle(IpcChannels.ioCopyTableSql, (_e, connectionId: string, target: DataTarget, withData: boolean) =>
    copyTableSql(sessions, connectionId, target, withData),
  );

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

  return;
}
