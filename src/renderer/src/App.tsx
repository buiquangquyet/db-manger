import { useCallback, useEffect, useState } from 'react';
import { Empty, Tabs } from 'antd';
import { DatabaseOutlined, CodeOutlined, TableOutlined } from '@ant-design/icons';
import type { Capabilities, DataTarget, StoredConnection } from '@shared/types';
import { Sidebar } from './components/Sidebar';
import { DataGridView } from './components/DataGridView';
import { QueryPanel } from './components/QueryPanel';
import { StructureView } from './components/StructureView';
import { DatabaseOverview } from './components/DatabaseOverview';

/** Database/schema đang chọn để xem danh sách bảng. */
interface DbSelection {
  connectionId: string;
  database?: string;
  schema?: string;
  label: string;
}

/** Phiên đang mở: kết nối + capabilities lấy từ adapter. */
interface ActiveSession {
  connection: StoredConnection;
  capabilities: Capabilities;
}

type TabKey = 'structure' | 'data' | 'query';

export default function App() {
  const [connections, setConnections] = useState<StoredConnection[]>([]);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [target, setTarget] = useState<DataTarget | null>(null);
  const [dbSelection, setDbSelection] = useState<DbSelection | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('query');

  const refresh = useCallback(async () => {
    setConnections(await window.api.listConnections());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpen = useCallback(async (conn: StoredConnection) => {
    // Ném lỗi ra ngoài để caller (loadRoot, handleCreateDatabase...) dừng lại
    // trước khi gọi IPC cần session; nếu nuốt lỗi, main process sẽ ném "Phiên chưa mở".
    const capabilities = await window.api.openSession(conn.id);
    setSession({ connection: conn, capabilities });
    setTarget(null);
    setDbSelection(null);
    setActiveTab('query');
  }, []);

  // Chọn bảng/collection -> nhảy sang tab Dữ liệu.
  const handleSelectTarget = useCallback((t: DataTarget) => {
    setDbSelection(null);
    setTarget(t);
    setActiveTab('data');
  }, []);

  // Chọn database/schema -> hiển thị danh sách bảng ở panel bên phải.
  const handleSelectDatabase = useCallback((sel: DbSelection) => {
    setTarget(null);
    setDbSelection(sel);
  }, []);

  const needTarget = (
    <Empty style={{ marginTop: 80 }} description="Chọn một bảng/collection ở sidebar" />
  );

  const items = session
    ? [
        {
          key: 'structure',
          label: (
            <span>
              <TableOutlined /> Cấu hình
            </span>
          ),
          children: target ? (
            <StructureView
              connectionId={session.connection.id}
              target={target}
              kind={session.connection.kind}
              canAlter={session.capabilities.alterStructure}
            />
          ) : (
            needTarget
          ),
        },
        {
          key: 'data',
          label: (
            <span>
              <DatabaseOutlined /> Dữ liệu{target ? `: ${target.name}` : ''}
            </span>
          ),
          children: target ? (
            <DataGridView
              key={`${session.connection.id}:${target.database ?? ''}:${target.schema ?? ''}:${target.name}`}
              connectionId={session.connection.id}
              target={target}
              inlineEdit={session.capabilities.inlineEdit}
              documentEdit={session.capabilities.documentEdit}
              columnFilter={session.capabilities.columnFilter}
            />
          ) : (
            needTarget
          ),
        },
        {
          key: 'query',
          label: (
            <span>
              <CodeOutlined /> {session.capabilities.queryLabel}
            </span>
          ),
          children: (
            <QueryPanel
              connectionId={session.connection.id}
              language={session.capabilities.sql ? 'sql' : 'plaintext'}
              placeholder={queryPlaceholder(session.capabilities)}
            />
          ),
        },
      ]
    : [];

  return (
    <div className="app-layout">
      <Sidebar
        connections={connections}
        activeConnectionId={session?.connection.id ?? null}
        onConnectionsChanged={refresh}
        onOpen={handleOpen}
        onSelectTarget={handleSelectTarget}
        onSelectDatabase={handleSelectDatabase}
      />
      <div className="main-panel">
        {!session ? (
          <Empty style={{ marginTop: 120 }} description="Chọn hoặc tạo một kết nối để bắt đầu" />
        ) : dbSelection && !target ? (
          <DatabaseOverview
            connectionId={dbSelection.connectionId}
            kind={session.connection.kind}
            database={dbSelection.database}
            schema={dbSelection.schema}
            label={dbSelection.label}
            onOpenTable={handleSelectTarget}
          />
        ) : (
          <Tabs
            style={{ height: '100%' }}
            className="full-height-tabs"
            activeKey={activeTab}
            onChange={(k) => setActiveTab(k as TabKey)}
            items={items}
          />
        )}
      </div>
    </div>
  );
}

function queryPlaceholder(cap: Capabilities): string {
  switch (cap.dataModel) {
    case 'relational':
      return 'SELECT * FROM ...';
    case 'document':
      return 'db.users.find({}).limit(10)';
    case 'keyvalue':
      return 'GET my-key';
  }
}
