import { useMemo, useState } from 'react';
import { Button, Dropdown, Empty, Input, Modal, Tree, message } from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  DatabaseOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  TableOutlined,
  FolderOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import type { DataTarget, DbKind, StoredConnection, TreeNode } from '@shared/types';
import { ConnectionModal } from './ConnectionModal';
import { CreateTableModal } from './CreateTableModal';
import { TransferModal } from './TransferModal';
import type { TransferSource } from './TransferModal';
import { buildTableMenu, promptInput } from '../lib/tableActions';
import { filterTree, findNode, findParentKey, insertChildren } from '../lib/tree-utils';

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

/**
 * Bọc phần khớp trong nhãn bằng <mark> để dễ nhìn khi đang lọc.
 * Giả định khớp với logic của filterTree: substring, không phân biệt hoa/thường.
 */
function highlight(title: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return title;
  const i = title.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return title;
  return (
    <>
      {title.slice(0, i)}
      <mark style={{ background: '#ffe58f', padding: 0 }}>{title.slice(i, i + q.length)}</mark>
      {title.slice(i + q.length)}
    </>
  );
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
  // Ngữ cảnh transfer (mở TransferModal) từ node database/schema được chọn.
  const [transferSrc, setTransferSrc] = useState<TransferSource | null>(null);
  // Chuỗi lọc cây (client-side, chỉ trên node đã tải).
  const [query, setQuery] = useState('');
  // Trạng thái mở do người dùng tự bấm KHI KHÔNG LỌC — nguồn sự thật để quay lại sau khi xóa ô
  // lọc. Bị "đóng băng" trong lúc lọc: không ghi gì vào đây khi query đang có giá trị, để thao
  // tác mở/thu trong lúc lọc (chỉ là xem tạm) không làm mất trạng thái gốc của người dùng.
  const [userExpandedKeys, setUserExpandedKeys] = useState<React.Key[]>([]);
  // Trạng thái mở riêng cho lúc đang lọc — người dùng có thể tự mở/thu thêm trong lúc lọc mà
  // không đụng userExpandedKeys; bị bỏ hẳn khi xóa ô lọc (không mang gì sang lượt lọc sau).
  const [filterExpandedKeys, setFilterExpandedKeys] = useState<React.Key[]>([]);
  // "Ảnh chụp" lượt render trước: có đang lọc không, và expandKeys lúc đó là gì — để phân biệt
  // "vừa bắt đầu lọc" (cần gieo filterExpandedKeys từ userExpandedKeys) với "vẫn đang lọc nhưng
  // query/dữ liệu đổi" (chỉ merge thêm phần expandKeys MỚI xuất hiện, giữ nguyên các nhánh
  // người dùng đã tự thu trong lúc lọc).
  const [prevFilter, setPrevFilter] = useState<{ filtering: boolean; expandKeys: string[] }>({
    filtering: false,
    expandKeys: [],
  });

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

  const { nodes: visibleNodes, expandKeys } = useMemo(() => filterTree(rootNodes, query), [rootNodes, query]);
  const isFiltering = query.trim().length > 0;

  // Đồng bộ filterExpandedKeys ngay trong lúc render (không dùng useEffect, để tránh nhấp nháy
  // một khung hình khi bắt đầu lọc). Chỉ xử lý khi đang lọc hoặc vừa thoát lọc; bỏ qua hẳn ở
  // trạng thái "không lọc" ổn định vì filterTree luôn trả về một mảng expandKeys [] MỚI mỗi lần
  // render khi query rỗng — so sánh theo tham chiếu sẽ sai nếu không có điều kiện chặn này.
  if (isFiltering || prevFilter.filtering) {
    if (isFiltering !== prevFilter.filtering || expandKeys !== prevFilter.expandKeys) {
      if (isFiltering && !prevFilter.filtering) {
        // Vừa bắt đầu một lượt lọc mới: gieo từ trạng thái người dùng + nhánh tự mở do lọc.
        setFilterExpandedKeys(Array.from(new Set([...userExpandedKeys, ...expandKeys])));
      } else if (isFiltering) {
        // Vẫn đang lọc (gõ thêm/xóa ký tự, hoặc cây tải thêm dữ liệu): chỉ mở thêm nhánh MỚI
        // xuất hiện trong expandKeys — không đụng tới nhánh người dùng đã tự thu trong lúc lọc.
        const newlyAdded = expandKeys.filter((k) => !prevFilter.expandKeys.includes(k));
        if (newlyAdded.length > 0) {
          setFilterExpandedKeys((prev) => Array.from(new Set([...prev, ...newlyAdded])));
        }
      }
      setPrevFilter({ filtering: isFiltering, expandKeys });
    }
  }

  // Khi lọc: dùng trạng thái mở riêng của lượt lọc. Xóa ô lọc -> quay lại đúng userExpandedKeys,
  // không bị ảnh hưởng bởi bất kỳ thao tác mở/thu nào đã làm trong lúc lọc.
  const expandedKeys = isFiltering ? filterExpandedKeys : userExpandedKeys;

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

  // Trong lúc lọc: ghi thẳng vào filterExpandedKeys, KHÔNG đụng userExpandedKeys — nhờ vậy khi
  // xóa ô lọc, cây quay lại đúng các nhánh người dùng đã mở TRƯỚC khi lọc, kể cả nếu trong lúc
  // lọc họ có thu một nhánh vốn đang mở từ trước (coi đó là xem tạm, không phải quyết định mới).
  const handleExpand = (keys: React.Key[]) => {
    if (isFiltering) setFilterExpandedKeys(keys);
    else setUserExpandedKeys(keys);
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
      <div className="sidebar-filter">
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder="Lọc trong cây đang mở…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="sidebar-tree">
        {connections.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có kết nối" />
        ) : visibleNodes.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có node nào khớp" />
        ) : (
          <Tree
            showIcon
            blockNode
            expandAction="click"
            treeData={visibleNodes as unknown as DataNode[]}
            expandedKeys={expandedKeys}
            autoExpandParent={false}
            onExpand={handleExpand}
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
                      {highlight(ui.title, query)}
                    </span>
                  </Dropdown>
                );
              }
              const raw = ui.raw;
              const conn = connections.find((c) => c.id === ui.connectionId);
              if (!raw || !conn || !canManage(conn.kind)) return <span>{highlight(ui.title, query)}</span>;

              // Menu cho node database/schema.
              if (raw.type === 'database' || raw.type === 'schema') {
                const items = [
                  { key: 'create', label: 'Tạo bảng' },
                  { key: 'transfer', label: 'Transfer sang…' },
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
                        } else if (key === 'transfer') {
                          setTransferSrc({
                            connectionId: conn.id,
                            kind: conn.kind,
                            database: raw.meta?.database as string | undefined,
                            schema: raw.meta?.schema as string | undefined,
                            label: raw.label,
                          });
                        } else if (key === 'refresh') {
                          void reloadChildren(conn.id, ui.key);
                        } else if (key === 'dropDb') {
                          handleDropDatabase(conn.id, ui);
                        }
                      },
                    }}
                  >
                    <span>{highlight(ui.title, query)}</span>
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
                    <span>{highlight(ui.title, query)}</span>
                  </Dropdown>
                );
              }

              return <span>{highlight(ui.title, query)}</span>;
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

      {transferSrc && (
        <TransferModal
          open
          source={transferSrc}
          connections={connections}
          onClose={() => setTransferSrc(null)}
        />
      )}
    </div>
  );
}
