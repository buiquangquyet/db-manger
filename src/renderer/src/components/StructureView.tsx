import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Modal, Space, Spin, Table, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type {
  AlterOperation,
  ColumnInfo,
  ColumnSpec,
  DataTarget,
  DbKind,
  ForeignKeyInfo,
  TableStructure,
} from '@shared/types';
import { ColumnFormModal } from './ColumnFormModal';
import { IndexFormModal } from './IndexFormModal';

interface Props {
  connectionId: string;
  target: DataTarget;
  /** Loại DB (để gợi ý kiểu dữ liệu khi sửa cột). */
  kind: DbKind;
  /** Cho phép sửa cấu trúc (ALTER TABLE) hay không. */
  canAlter: boolean;
}

export function StructureView({ connectionId, target, kind, canAlter }: Props) {
  const [struct, setStruct] = useState<TableStructure | null>(null);
  const [loading, setLoading] = useState(false);
  const [colModalOpen, setColModalOpen] = useState(false);
  const [editingCol, setEditingCol] = useState<ColumnInfo | null>(null);
  const [idxModalOpen, setIdxModalOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setStruct(await window.api.getStructure(connectionId, target));
    } catch (err) {
      message.error(`Đọc cấu trúc thất bại: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [connectionId, target]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Chạy 1 thao tác ALTER rồi tải lại cấu trúc. */
  const runAlter = async (op: AlterOperation) => {
    await window.api.alterTable(connectionId, target, op);
    message.success('Đã cập nhật cấu trúc');
    await reload();
  };

  const submitColumn = async (spec: ColumnSpec) => {
    try {
      if (editingCol) await runAlter({ kind: 'modifyColumn', oldName: editingCol.name, column: spec });
      else await runAlter({ kind: 'addColumn', column: spec });
      setColModalOpen(false);
    } catch (err) {
      message.error(`Thao tác thất bại: ${(err as Error).message}`);
      throw err; // giữ modal mở
    }
  };

  const submitIndex = async (index: { name: string; columns: string[]; unique: boolean }) => {
    try {
      await runAlter({ kind: 'addIndex', ...index });
      setIdxModalOpen(false);
    } catch (err) {
      message.error(`Thêm index thất bại: ${(err as Error).message}`);
      throw err;
    }
  };

  const confirmDropColumn = (name: string) => {
    Modal.confirm({
      title: `Xóa cột "${name}"?`,
      content: 'Dữ liệu trong cột sẽ mất và không thể hoàn tác.',
      okText: 'Xóa',
      okType: 'danger',
      cancelText: 'Hủy',
      onOk: () => runAlter({ kind: 'dropColumn', name }).catch((e) => message.error((e as Error).message)),
    });
  };

  const confirmDropIndex = (name: string) => {
    Modal.confirm({
      title: `Xóa index "${name}"?`,
      okText: 'Xóa',
      okType: 'danger',
      cancelText: 'Hủy',
      onOk: () => runAlter({ kind: 'dropIndex', name }).catch((e) => message.error((e as Error).message)),
    });
  };

  const columnCols = [
    { title: '', dataIndex: 'isPrimaryKey', width: 40, render: (pk: boolean) => (pk ? '🔑' : '') },
    { title: 'Cột', dataIndex: 'name', key: 'name' },
    { title: 'Kiểu dữ liệu', dataIndex: 'dataType', key: 'dataType' },
    {
      title: 'Null?',
      dataIndex: 'nullable',
      width: 90,
      render: (n: boolean) => (n ? <Tag>NULL</Tag> : <Tag color="red">NOT NULL</Tag>),
    },
    {
      title: 'Mặc định',
      dataIndex: 'default',
      render: (d: string | null) => d ?? <span style={{ color: '#bbb' }}>—</span>,
    },
    { title: 'Ghi chú', dataIndex: 'extra', render: (e?: string) => (e ? <Tag color="blue">{e}</Tag> : '') },
    ...(canAlter
      ? [
          {
            title: '',
            key: 'actions',
            width: 90,
            render: (_: unknown, row: ColumnInfo) => (
              <Space size="small">
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditingCol(row);
                    setColModalOpen(true);
                  }}
                />
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => confirmDropColumn(row.name)}
                />
              </Space>
            ),
          },
        ]
      : []),
  ];

  const indexCols = [
    { title: 'Index', dataIndex: 'name', key: 'name' },
    { title: 'Cột', dataIndex: 'columns', render: (c: string[]) => c.join(', ') },
    { title: 'Unique', dataIndex: 'unique', width: 90, render: (u: boolean) => (u ? <Tag color="green">UNIQUE</Tag> : '') },
    ...(canAlter
      ? [
          {
            title: '',
            key: 'actions',
            width: 60,
            render: (_: unknown, row: { name: string }) => (
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => confirmDropIndex(row.name)}
              />
            ),
          },
        ]
      : []),
  ];

  const fkCols: ColumnsType<ForeignKeyInfo> = [
    { title: 'Tên', dataIndex: 'name', key: 'name' },
    { title: 'Cột', key: 'columns', render: (_, r) => r.columns.join(', ') },
    {
      title: 'Tham chiếu',
      key: 'ref',
      render: (_, r) =>
        `${r.refSchema ? `${r.refSchema}.` : ''}${r.refTable} (${r.refColumns.join(', ')})`,
    },
    { title: 'ON DELETE', dataIndex: 'onDelete', key: 'onDelete', render: (v?: string) => v ?? '—' },
    { title: 'ON UPDATE', dataIndex: 'onUpdate', key: 'onUpdate', render: (v?: string) => v ?? '—' },
  ];

  return (
    <Spin spinning={loading} wrapperClassName="grid-spin">
      <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
        {struct?.note && <Alert type="info" showIcon message={struct.note} style={{ marginBottom: 16 }} />}

        <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Cột ({struct?.columns.length ?? 0})
          </Typography.Title>
          {canAlter && (
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditingCol(null);
                setColModalOpen(true);
              }}
            >
              Thêm cột
            </Button>
          )}
        </Space>
        <Table
          size="small"
          rowKey="name"
          pagination={false}
          columns={columnCols}
          dataSource={struct?.columns ?? []}
          bordered
        />

        <Space style={{ margin: '24px 0 8px', width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Index ({struct?.indexes.length ?? 0})
          </Typography.Title>
          {canAlter && (
            <Button size="small" icon={<PlusOutlined />} onClick={() => setIdxModalOpen(true)}>
              Thêm index
            </Button>
          )}
        </Space>
        <Table
          size="small"
          rowKey="name"
          pagination={false}
          columns={indexCols}
          dataSource={struct?.indexes ?? []}
          bordered
          locale={{ emptyText: 'Không có index' }}
        />

        <Space style={{ margin: '24px 0 8px', width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Khóa ngoại ({struct?.foreignKeys.length ?? 0})
          </Typography.Title>
        </Space>
        <Table
          size="small"
          rowKey="name"
          pagination={false}
          columns={fkCols}
          dataSource={struct?.foreignKeys ?? []}
          bordered
          locale={{ emptyText: 'Không có khóa ngoại' }}
        />
      </div>

      <ColumnFormModal
        open={colModalOpen}
        editing={editingCol}
        kind={kind}
        onClose={() => setColModalOpen(false)}
        onSubmit={submitColumn}
      />
      <IndexFormModal
        open={idxModalOpen}
        columnNames={(struct?.columns ?? []).map((c) => c.name)}
        onClose={() => setIdxModalOpen(false)}
        onSubmit={submitIndex}
      />
    </Spin>
  );
}
