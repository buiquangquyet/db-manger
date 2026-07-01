import { useMemo, useState } from 'react';
import { Button, Dropdown, Empty, Modal, Tree, message } from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  DatabaseOutlined,
  PlusOutlined,
  ReloadOutlined,
  TableOutlined,
  FolderOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import type { DataTarget, DbKind, StoredConnection, TreeNode } from '@shared/types';
import { ConnectionModal } from './ConnectionModal';
import { CreateTableModal } from './CreateTableModal';
import { buildTableMenu, promptInput } from '../lib/tableActions';

/** DB nào cho phép tạo/xóa/đổi tên bảng & xóa database (khớp Capabilities.manageObjects). */
const canManage = (kind: DbKind): boolean => kind !== 'redis';

interface Props {
  connections: StoredConnection[];
  activeConnectionId: string | null;
  onConnectionsChanged: () => void;
  onOpen: (conn: StoredConnection) => Promise<void>;
  onSelectTarget: (target: DataTarget) => void;
  /** Chọn một database/schema -> hiển thị danh sách bảng ở panel bên phải. */
  onSelectDatabase: (sel: { connectionId: string; database?: string; schema?: string; label: string }) => void;
}

/** Node của antd Tree, gắn kèm dữ liệu gốc từ backend. */
interface UiNode {
  key: string;
  title: string;
  icon: React.ReactNode;
  isLeaf: boolean;
  connectionId: string;
  raw?: TreeNode;
  children?: UiNode[];
}

function iconFor(type: TreeNode['type']): React.ReactNode {
  switch (type) {
    case 'database':
    case 'schema':
      return <DatabaseOutlined />;
    case 'table':
    case 'view':
    case 'collection':
      return <TableOutlined />;
    case 'keyspace':
    case 'key':
      return <KeyOutlined />;
    default:
      return <FolderOutlined />;
  }
}

export function Sidebar({ connections, activeConnectionId, onConnectionsChanged, onOpen, onSelectTarget, onSelectDatabase }: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StoredConnection | null>(null);
  const [treeData, setTreeData] = useState<Record<string, UiNode[]>>({});
  // Ngữ cảnh tạo bảng (mở CreateTableModal) & node cha để refresh sau khi tạo.
  const [createCtx, setCreateCtx] = useState<{
    connectionId: string;
    kind: DbKind;
    database?: string;
    schema?: string;
    dbLabel: string;
    parentKey: string;
  } | null>(null);

  // Node gốc: mỗi kết nối là 1 node cấp cao.
  const rootNodes: UiNode[] = useMemo(
    () =>
      connections.map((c) => ({
        key: `conn:${c.id}`,
        title: `${c.name} (${c.kind})`,
        icon: <DatabaseOutlined />,
        isLeaf: false,
        connectionId: c.id,
        children: treeData[c.id],
      })),
    [connections, treeData],
  );

  const loadRoot = async (conn: StoredConnection) => {
    try {
      // Phải chờ mở phiên xong trước khi lấy cây, nếu không main process ném "Phiên chưa mở".
      await onOpen(conn);
      const nodes = await window.api.getRootNodes(conn.id);
      setTreeData((prev) => ({ ...prev, [conn.id]: nodes.map((n) => toUi(n, conn.id)) }));
    } catch (err) {
      message.error(`Tải cây thất bại: ${(err as Error).message}`);
    }
  };

  const toUi = (n: TreeNode, connectionId: string): UiNode => ({
    key: `${connectionId}:${n.id}`,
    title: n.label,
    icon: iconFor(n.type),
    isLeaf: !n.expandable,
    connectionId,
    raw: n,
  });

  const onLoadData = async (node: DataNode): Promise<void> => {
    const ui = node as unknown as UiNode;
    // Mở rộng node kết nối gốc: mở phiên rồi tải toàn bộ database/schema/keyspace bên trong.
    if (ui.key.startsWith('conn:')) {
      const conn = connections.find((c) => c.id === ui.connectionId);
      if (conn) await loadRoot(conn);
      return;
    }
    if (!ui.raw || !ui.connectionId) return;
    const children = await window.api.getChildNodes(ui.connectionId, ui.raw);
    const uiChildren = children.map((n) => toUi(n, ui.connectionId));
    // Chèn con vào đúng nhánh của kết nối.
    setTreeData((prev) => ({
      ...prev,
      [ui.connectionId]: insertChildren(prev[ui.connectionId] ?? [], ui.key, uiChildren),
    }));
  };

  // Tải lại con của node theo key (sau khi thao tác cấu trúc).
  const reloadChildren = async (connectionId: string, nodeKey: string) => {
    const node = findNode(treeData[connectionId] ?? [], nodeKey);
    if (!node?.raw) return;
    const children = await window.api.getChildNodes(connectionId, node.raw);
    setTreeData((prev) => ({
      ...prev,
      [connectionId]: insertChildren(prev[connectionId] ?? [], nodeKey, children.map((n) => toUi(n, connectionId))),
    }));
  };

  const refreshParentOf = async (connectionId: string, childKey: string) => {
    const parentKey = findParentKey(treeData[connectionId] ?? [], childKey);
    if (parentKey) await reloadChildren(connectionId, parentKey);
  };

  const targetOf = (raw: TreeNode): DataTarget => ({
    database: raw.meta?.database as string | undefined,
    schema: raw.meta?.schema as string | undefined,
    name: (raw.meta?.name as string) ?? raw.label,
  });

  const handleCreateDatabase = async (conn: StoredConnection) => {
    const name = await promptInput('Tạo database mới', 'Tên database');
    if (!name) return;
    try {
      await onOpen(conn); // đảm bảo phiên đã mở trước khi chạy lệnh
      await window.api.createDatabase(conn.id, name);
      message.success(`Đã tạo database "${name}"`);
      await loadRoot(conn); // tải lại danh sách database để hiện cái mới
    } catch (err) {
      message.error(`Tạo database thất bại: ${(err as Error).message}`);
    }
  };

  const handleDropDatabase = (connectionId: string, ui: UiNode) => {
    if (!ui.raw) return;
    const name = (ui.raw.meta?.database as string) ?? ui.raw.label;
    Modal.confirm({
      title: `Xóa database "${name}"?`,
      content: 'Xóa toàn bộ bảng và dữ liệu bên trong. Không thể hoàn tác.',
      okText: 'Xóa database',
      okType: 'danger',
      cancelText: 'Hủy',
      onOk: async () => {
        try {
          await window.api.dropDatabase(connectionId, name);
          message.success('Đã xóa database');
          const conn = connections.find((c) => c.id === connectionId);
          if (conn) await loadRoot(conn);
        } catch (err) {
          message.error(`Thất bại: ${(err as Error).message}`);
        }
      },
    });
  };

  const onSelect = (_keys: React.Key[], info: { node: DataNode }) => {
    const ui = info.node as unknown as UiNode;
    const raw = ui.raw;
    if (!raw) return;
    if (['table', 'view', 'collection', 'keyspace'].includes(raw.type)) {
      onSelectTarget({
        database: raw.meta?.database as string | undefined,
        schema: raw.meta?.schema as string | undefined,
        name: (raw.meta?.name as string) ?? String(raw.meta?.dbIndex ?? raw.label),
      });
    } else if (['database', 'schema'].includes(raw.type)) {
      onSelectDatabase({
        connectionId: ui.connectionId,
        database: raw.meta?.database as string | undefined,
        schema: raw.meta?.schema as string | undefined,
        label: raw.label,
      });
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
        >
          Kết nối mới
        </Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={onConnectionsChanged} />
      </div>
      <div className="sidebar-tree">
        {connections.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có kết nối" />
        ) : (
          <Tree
            showIcon
            blockNode
            expandAction="click"
            treeData={rootNodes as unknown as DataNode[]}
            loadData={onLoadData}
            onSelect={onSelect}
            onDoubleClick={(_e, node) => {
              const ui = node as unknown as UiNode;
              const conn = connections.find((c) => c.id === ui.connectionId);
              if (conn && ui.key.startsWith('conn:')) void loadRoot(conn);
            }}
            titleRender={(node) => {
              const ui = node as unknown as UiNode;
              if (ui.key.startsWith('conn:')) {
                const conn = connections.find((c) => c.id === ui.connectionId)!;
                return (
                  <Dropdown
                    trigger={['contextMenu']}
                    menu={{
                      items: [
                        { key: 'open', label: 'Mở kết nối' },
                        ...(canManage(conn.kind) ? [{ key: 'createDb', label: 'Tạo database mới' }] : []),
                        { key: 'edit', label: 'Sửa' },
                        { key: 'delete', label: 'Xóa', danger: true },
                      ],
                      onClick: async ({ key }) => {
                        if (key === 'open') void loadRoot(conn);
                        else if (key === 'createDb') void handleCreateDatabase(conn);
                        else if (key === 'edit') {
                          setEditing(conn);
                          setModalOpen(true);
                        } else if (key === 'delete') {
                          await window.api.deleteConnection(conn.id);
                          onConnectionsChanged();
                        }
                      },
                    }}
                  >
                    <span style={{ fontWeight: ui.connectionId === activeConnectionId ? 600 : 400 }}>
                      {ui.title}
                    </span>
                  </Dropdown>
                );
              }
              const raw = ui.raw;
              const conn = connections.find((c) => c.id === ui.connectionId);
              if (!raw || !conn || !canManage(conn.kind)) return <span>{ui.title}</span>;

              // Menu cho node database/schema.
              if (raw.type === 'database' || raw.type === 'schema') {
                const items = [
                  { key: 'create', label: 'Tạo bảng' },
                  { key: 'refresh', label: 'Làm mới' },
                  ...(raw.type === 'database'
                    ? [{ key: 'dropDb', label: 'Xóa database', danger: true }]
                    : []),
                ];
                return (
                  <Dropdown
                    trigger={['contextMenu']}
                    menu={{
                      items,
                      onClick: ({ key }) => {
                        if (key === 'create') {
                          setCreateCtx({
                            connectionId: conn.id,
                            kind: conn.kind,
                            database: raw.meta?.database as string | undefined,
                            schema: raw.meta?.schema as string | undefined,
                            dbLabel: raw.label,
                            parentKey: ui.key,
                          });
                        } else if (key === 'refresh') {
                          void reloadChildren(conn.id, ui.key);
                        } else if (key === 'dropDb') {
                          handleDropDatabase(conn.id, ui);
                        }
                      },
                    }}
                  >
                    <span>{ui.title}</span>
                  </Dropdown>
                );
              }

              // Menu cho node bảng/view/collection — dùng chung với list table.
              if (['table', 'view', 'collection'].includes(raw.type)) {
                const menu = buildTableMenu(
                  { connectionId: conn.id, target: targetOf(raw), label: raw.label },
                  conn.kind,
                  () => void refreshParentOf(conn.id, ui.key),
                );
                return (
                  <Dropdown trigger={['contextMenu']} menu={menu}>
                    <span>{ui.title}</span>
                  </Dropdown>
                );
              }

              return <span>{ui.title}</span>;
            }}
          />
        )}
      </div>

      <ConnectionModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSaved={onConnectionsChanged}
      />

      {createCtx && (
        <CreateTableModal
          open
          connectionId={createCtx.connectionId}
          kind={createCtx.kind}
          database={createCtx.database}
          schema={createCtx.schema}
          dbLabel={createCtx.dbLabel}
          onClose={() => setCreateCtx(null)}
          onCreated={() => void reloadChildren(createCtx.connectionId, createCtx.parentKey)}
        />
      )}
    </div>
  );
}

/** Tìm node theo key (đệ quy). */
function findNode(nodes: UiNode[], key: string): UiNode | undefined {
  for (const n of nodes) {
    if (n.key === key) return n;
    if (n.children) {
      const found = findNode(n.children, key);
      if (found) return found;
    }
  }
  return undefined;
}

/** Tìm key của node cha chứa childKey (đệ quy). */
function findParentKey(nodes: UiNode[], childKey: string, parentKey?: string): string | undefined {
  for (const n of nodes) {
    if (n.key === childKey) return parentKey;
    if (n.children) {
      const found = findParentKey(n.children, childKey, n.key);
      if (found) return found;
    }
  }
  return undefined;
}

/** Chèn danh sách con vào node có key cho trước (đệ quy). */
function insertChildren(nodes: UiNode[], key: string, children: UiNode[]): UiNode[] {
  return nodes.map((n) => {
    if (n.key === key) return { ...n, children };
    if (n.children) return { ...n, children: insertChildren(n.children, key, children) };
    return n;
  });
}
