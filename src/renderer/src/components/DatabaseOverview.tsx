import { useEffect, useState } from 'react';
import { Button, Empty, Menu, Spin, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DatabaseOutlined, ReloadOutlined } from '@ant-design/icons';
import type { DataTarget, DbKind, TableSummary } from '@shared/types';
import { buildTableMenu } from '../lib/tableActions';

interface Props {
  connectionId: string;
  kind: DbKind;
  database?: string;
  schema?: string;
  /** Nhãn hiển thị (tên database/schema). */
  label: string;
  /** Mở một bảng/collection khi người dùng click vào dòng. */
  onOpenTable: (target: DataTarget) => void;
}

/** Định dạng số byte sang đơn vị dễ đọc (KB/MB/GB). */
function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatRows(rows: number | null): string {
  return rows == null ? '—' : rows.toLocaleString('vi-VN');
}

export function DatabaseOverview({ connectionId, kind, database, schema, label, onOpenTable }: Props) {
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Vị trí + dòng của menu chuột phải.
  const [ctx, setCtx] = useState<{ row: TableSummary; x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTables(null);
    window.api
      .getTableList(connectionId, database, schema)
      .then((list) => {
        if (!cancelled) setTables(list);
      })
      .catch((err: Error) => {
        if (!cancelled) message.error(`Tải danh sách bảng thất bại: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, database, schema]);

  const reload = () => {
    setLoading(true);
    window.api
      .getTableList(connectionId, database, schema)
      .then(setTables)
      .catch((err: Error) => message.error(`Tải lại thất bại: ${err.message}`))
      .finally(() => setLoading(false));
  };

  const columns: ColumnsType<TableSummary> = [
    {
      title: 'Tên',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    {
      title: 'Loại',
      dataIndex: 'type',
      key: 'type',
      width: 110,
      filters: [
        { text: 'table', value: 'table' },
        { text: 'view', value: 'view' },
        { text: 'collection', value: 'collection' },
      ],
      onFilter: (v, r) => r.type === v,
      render: (t: TableSummary['type']) => (
        <Tag color={t === 'view' ? 'purple' : t === 'collection' ? 'geekblue' : 'green'}>{t}</Tag>
      ),
    },
    {
      title: 'Số dòng',
      dataIndex: 'rows',
      key: 'rows',
      width: 130,
      align: 'right',
      sorter: (a, b) => (a.rows ?? -1) - (b.rows ?? -1),
      render: formatRows,
    },
    {
      title: 'Dung lượng',
      dataIndex: 'sizeBytes',
      key: 'sizeBytes',
      width: 130,
      align: 'right',
      sorter: (a, b) => (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1),
      render: formatBytes,
    },
    {
      title: 'Engine',
      dataIndex: 'engine',
      key: 'engine',
      width: 110,
      render: (e?: string) => e ?? '—',
    },
    {
      title: 'Ghi chú',
      dataIndex: 'comment',
      key: 'comment',
      ellipsis: true,
      render: (c?: string) => c ?? '',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid #f0f0f0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          <DatabaseOutlined /> {label}
          {tables ? <Typography.Text type="secondary"> · {tables.length} bảng</Typography.Text> : null}
        </Typography.Title>
        <Button size="small" icon={<ReloadOutlined />} onClick={reload} loading={loading}>
          Tải lại
        </Button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <Spin spinning={loading}>
          {tables && tables.length === 0 ? (
            <Empty description="Database rỗng — chưa có bảng nào" />
          ) : (
            <Table<TableSummary>
              rowKey="name"
              size="small"
              columns={columns}
              dataSource={tables ?? []}
              pagination={false}
              onRow={(record) => ({
                style: { cursor: 'pointer' },
                onClick: () => onOpenTable({ database, schema, name: record.name }),
                onContextMenu: (e) => {
                  e.preventDefault();
                  setCtx({ row: record, x: e.clientX, y: e.clientY });
                },
              })}
            />
          )}
        </Spin>
      </div>

      {/* Menu chuột phải: render Menu thủ công tại vị trí con trỏ + lớp phủ bắt click ngoài. */}
      {ctx &&
        (() => {
          const menu = buildTableMenu(
            { connectionId, target: { database, schema, name: ctx.row.name }, label: ctx.row.name },
            kind,
            reload,
          );
          return (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
                onClick={() => setCtx(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtx(null);
                }}
              />
              <Menu
                items={menu.items}
                onClick={(info) => {
                  menu.onClick?.(info);
                  setCtx(null);
                }}
                style={{
                  position: 'fixed',
                  left: ctx.x,
                  top: ctx.y,
                  zIndex: 1001,
                  minWidth: 200,
                  borderRadius: 6,
                  boxShadow: '0 3px 10px rgba(0,0,0,0.18)',
                }}
              />
            </>
          );
        })()}
    </div>
  );
}
