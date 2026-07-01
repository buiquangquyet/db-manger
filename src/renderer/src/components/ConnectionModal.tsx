import { useEffect, useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, Select, Space, message } from 'antd';
import type { ConnectionConfig, DbKind, StoredConnection } from '@shared/types';

const DEFAULT_PORTS: Record<DbKind, number> = {
  mariadb: 3306,
  postgres: 5432,
  mongodb: 27017,
  redis: 6379,
};

const KIND_OPTIONS: { value: DbKind; label: string }[] = [
  { value: 'mariadb', label: 'MariaDB / MySQL' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mongodb', label: 'MongoDB' },
  { value: 'redis', label: 'Redis' },
];

interface Props {
  open: boolean;
  /** Kết nối đang sửa; null = tạo mới. */
  editing: StoredConnection | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ConnectionModal({ open, editing, onClose, onSaved }: Props) {
  const [form] = Form.useForm<ConnectionConfig>();
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      // editing.options là Record<string, unknown>; nới kiểu cho setFieldsValue của antd.
      form.setFieldsValue(editing as unknown as Parameters<typeof form.setFieldsValue>[0]);
    } else {
      form.resetFields();
      form.setFieldsValue({ kind: 'mariadb', host: '127.0.0.1', port: DEFAULT_PORTS.mariadb });
    }
  }, [open, editing, form]);

  const buildConfig = async (): Promise<ConnectionConfig> => {
    const values = await form.validateFields();
    return {
      ...values,
      id: editing?.id ?? cryptoId(),
    };
  };

  const handleTest = async () => {
    // Validate trước; nếu form sai, antd đã tô đỏ field nên chỉ cần dừng.
    let cfg: ConnectionConfig;
    try {
      cfg = await buildConfig();
    } catch {
      return;
    }
    setTesting(true);
    try {
      const res = await window.api.testConnection(cfg);
      if (res.ok) message.success(`Kết nối OK — ${res.serverInfo ?? ''}`);
      else message.error(`Thất bại: ${res.error}`);
    } catch (err) {
      // Lỗi thật (IPC/preload) — phải hiển thị, không nuốt im lặng.
      message.error(`Lỗi khi kiểm tra kết nối: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    let cfg: ConnectionConfig;
    try {
      cfg = await buildConfig();
    } catch {
      return;
    }
    try {
      await window.api.saveConnection(cfg);
      message.success('Đã lưu kết nối');
      onSaved();
      onClose();
    } catch (err) {
      message.error(`Lưu kết nối thất bại: ${(err as Error).message}`);
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? 'Sửa kết nối' : 'Kết nối mới'}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={handleTest} loading={testing}>
            Kiểm tra kết nối
          </Button>
          <Button onClick={onClose}>Hủy</Button>
          <Button type="primary" onClick={handleSave}>
            Lưu
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label="Tên" rules={[{ required: true, message: 'Nhập tên kết nối' }]}>
          <Input placeholder="Vd: Local Postgres" />
        </Form.Item>
        <Form.Item name="kind" label="Loại DB" rules={[{ required: true }]}>
          <Select
            options={KIND_OPTIONS}
            onChange={(kind: DbKind) => form.setFieldValue('port', DEFAULT_PORTS[kind])}
          />
        </Form.Item>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="host" label="Host" rules={[{ required: true }]} style={{ flex: 3 }}>
            <Input placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item name="port" label="Port" rules={[{ required: true }]} style={{ flex: 1, marginLeft: 8 }}>
            <InputNumber style={{ width: '100%' }} min={1} max={65535} />
          </Form.Item>
        </Space.Compact>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="user" label="Username" style={{ flex: 1 }}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="password" label="Password" style={{ flex: 1, marginLeft: 8 }}>
            <Input.Password autoComplete="new-password" placeholder={editing ? '(giữ nguyên nếu để trống)' : ''} />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="database" label="Database mặc định (tùy chọn)">
          <Input placeholder="vd: mydb" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Sinh id ngẫu nhiên dùng crypto của trình duyệt. */
function cryptoId(): string {
  return crypto.randomUUID();
}
