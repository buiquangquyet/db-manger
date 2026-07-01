import { useMemo, useState } from 'react';
import { Button, Dropdown, Empty, Tree, message } from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  DatabaseOutlined,
  PlusOutlined,
  ReloadOutlined,
  TableOutlined,
  FolderOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import type { DataTarget, StoredConnection, TreeNode } from '@shared/types';
import { ConnectionModal } from './ConnectionModal';

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
                        { key: 'edit', label: 'Sửa' },
                        { key: 'delete', label: 'Xóa', danger: true },
                      ],
                      onClick: async ({ key }) => {
                        if (key === 'open') void loadRoot(conn);
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
    </div>
  );
}

/** Chèn danh sách con vào node có key cho trước (đệ quy). */
function insertChildren(nodes: UiNode[], key: string, children: UiNode[]): UiNode[] {
  return nodes.map((n) => {
    if (n.key === key) return { ...n, children };
    if (n.children) return { ...n, children: insertChildren(n.children, key, children) };
    return n;
  });
}
