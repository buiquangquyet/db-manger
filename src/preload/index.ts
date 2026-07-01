import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '@shared/types';
import type {
  AlterOperation,
  ConnectionConfig,
  DataTarget,
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
};

contextBridge.exposeInMainWorld('api', api);
