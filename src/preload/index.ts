import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '@shared/types';
import type {
  AlterOperation,
  ColumnSpec,
  ConnectionConfig,
  DataTarget,
  IoFormat,
  PageRequest,
  RendererApi,
  TreeNode,
} from '@shared/types';

const api: RendererApi = {
  ping: () => ipcRenderer.invoke(IpcChannels.ping),
  listConnections: () => ipcRenderer.invoke(IpcChannels.connectionsList),
  saveConnection: (config: ConnectionConfig) => ipcRenderer.invoke(IpcChannels.connectionsSave, config),
  deleteConnection: (id: string) => ipcRenderer.invoke(IpcChannels.connectionsDelete, id),
  testConnection: (config: ConnectionConfig) => ipcRenderer.invoke(IpcChannels.connectionsTest, config),
  openSession: (connectionId: string) => ipcRenderer.invoke(IpcChannels.sessionOpen, connectionId),
  closeSession: (connectionId: string) => ipcRenderer.invoke(IpcChannels.sessionClose, connectionId),
  getRootNodes: (connectionId: string) => ipcRenderer.invoke(IpcChannels.treeRoot, connectionId),
  getChildNodes: (connectionId: string, node: TreeNode) =>
    ipcRenderer.invoke(IpcChannels.treeChildren, connectionId, node),
  getTableList: (connectionId: string, database?: string, schema?: string) =>
    ipcRenderer.invoke(IpcChannels.treeTableList, connectionId, database, schema),
  readRows: (connectionId: string, target: DataTarget, page: PageRequest) =>
    ipcRenderer.invoke(IpcChannels.dataRead, connectionId, target, page),
  getStructure: (connectionId: string, target: DataTarget) =>
    ipcRenderer.invoke(IpcChannels.dataStructure, connectionId, target),
  alterTable: (connectionId: string, target: DataTarget, op: AlterOperation) =>
    ipcRenderer.invoke(IpcChannels.dataAlter, connectionId, target, op),
  createTable: (connectionId: string, target: DataTarget, columns: ColumnSpec[]) =>
    ipcRenderer.invoke(IpcChannels.objectCreate, connectionId, target, columns),
  dropTable: (connectionId: string, target: DataTarget) =>
    ipcRenderer.invoke(IpcChannels.objectDrop, connectionId, target),
  truncateTable: (connectionId: string, target: DataTarget) =>
    ipcRenderer.invoke(IpcChannels.objectTruncate, connectionId, target),
  renameTable: (connectionId: string, target: DataTarget, newName: string) =>
    ipcRenderer.invoke(IpcChannels.objectRename, connectionId, target, newName),
  dropDatabase: (connectionId: string, name: string) =>
    ipcRenderer.invoke(IpcChannels.databaseDrop, connectionId, name),
  updateCell: (
    connectionId: string,
    target: DataTarget,
    rowKey: Record<string, unknown>,
    column: string,
    value: unknown,
  ) => ipcRenderer.invoke(IpcChannels.dataUpdate, connectionId, target, rowKey, column, value),
  insertRow: (connectionId: string, target: DataTarget, values: Record<string, unknown>) =>
    ipcRenderer.invoke(IpcChannels.dataInsert, connectionId, target, values),
  deleteRow: (connectionId: string, target: DataTarget, rowKey: Record<string, unknown>) =>
    ipcRenderer.invoke(IpcChannels.dataDelete, connectionId, target, rowKey),
  executeQuery: (connectionId: string, query: string, database?: string) =>
    ipcRenderer.invoke(IpcChannels.queryExecute, connectionId, query, database),
  exportTable: (connectionId: string, target: DataTarget, format: IoFormat) =>
    ipcRenderer.invoke(IpcChannels.ioExport, connectionId, target, format),
  importTable: (connectionId: string, target: DataTarget, format: IoFormat) =>
    ipcRenderer.invoke(IpcChannels.ioImport, connectionId, target, format),
  saveTextFile: (defaultName: string, content: string) =>
    ipcRenderer.invoke(IpcChannels.ioSaveText, defaultName, content),
  copyTableSql: (connectionId: string, target: DataTarget, withData: boolean) =>
    ipcRenderer.invoke(IpcChannels.ioCopyTableSql, connectionId, target, withData),
};

contextBridge.exposeInMainWorld('api', api);
