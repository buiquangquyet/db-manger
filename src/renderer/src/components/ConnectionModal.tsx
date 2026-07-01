import { useEffect, useState } from 'react';
import { Button, Divider, Form, Input, InputNumber, Modal, Select, Space, Switch, Typography, message } from 'antd';
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
  const sslOn = Form.useWatch(['options', 'ssl'], form) ?? false;
  const [sshOn, setSshOn] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue(editing as unknown as Parameters<typeof form.setFieldsValue>[0]);
      setSshOn(Boolean(editing.options?.ssh?.host));
    } else {
      form.resetFields();
      form.setFieldsValue({ kind: 'mariadb', host: '127.0.0.1', port: DEFAULT_PORTS.mariadb });
      setSshOn(false);
    }
  }, [open, editing, form]);

  const buildConfig = async (): Promise<ConnectionConfig> => {
    const values = await form.validateFields();
    const options = { ...(values.options ?? {}) };
    // Bỏ ssh nếu không bật; bỏ cờ verify khi không dùng SSL.
    if (!sshOn) delete options.ssh;
    if (!options.ssl) delete options.sslRejectUnauthorized;
    return {
      ...values,
      options: Object.keys(options).length ? options : undefined,
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

        <Divider style={{ margin: '8px 0' }} />
        <Space size="large">
          <Form.Item name={['options', 'ssl']} label="SSL/TLS" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Switch />
          </Form.Item>
          {sslOn && (
            <Form.Item
              name={['options', 'sslRejectUnauthorized']}
              label="Xác minh chứng chỉ"
              valuePropName="checked"
              initialValue={true}
              tooltip="Tắt nếu server dùng chứng chỉ tự ký / không khớp tên."
              style={{ marginBottom: 8 }}
            >
              <Switch />
            </Form.Item>
          )}
        </Space>

        <Divider style={{ margin: '8px 0' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: sshOn ? 12 : 0 }}>
          <Switch checked={sshOn} onChange={setSshOn} />
          <Typography.Text>Kết nối qua SSH tunnel (bastion)</Typography.Text>
        </div>
        {sshOn && (
          <>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name={['options', 'ssh', 'host']}
                label="SSH Host"
                rules={[{ required: true, message: 'Nhập SSH host' }]}
                style={{ flex: 3 }}
              >
                <Input placeholder="bastion.example.com" />
              </Form.Item>
              <Form.Item
                name={['options', 'ssh', 'port']}
                label="SSH Port"
                initialValue={22}
                style={{ flex: 1, marginLeft: 8 }}
              >
                <InputNumber style={{ width: '100%' }} min={1} max={65535} />
              </Form.Item>
            </Space.Compact>
            <Form.Item
              name={['options', 'ssh', 'user']}
              label="SSH Username"
              rules={[{ required: true, message: 'Nhập SSH user' }]}
            >
              <Input autoComplete="off" placeholder="vd: ubuntu" />
            </Form.Item>
            <Form.Item name={['options', 'ssh', 'password']} label="SSH Password (nếu dùng)">
              <Input.Password
                autoComplete="new-password"
                placeholder={editing ? '(giữ nguyên nếu để trống)' : ''}
              />
            </Form.Item>
            <Form.Item
              name={['options', 'ssh', 'privateKey']}
              label="SSH Private Key (PEM, nếu dùng)"
            >
              <Input.TextArea rows={3} placeholder={editing ? '(giữ nguyên nếu để trống)' : '-----BEGIN OPENSSH PRIVATE KEY-----'} />
            </Form.Item>
            <Form.Item name={['options', 'ssh', 'passphrase']} label="Passphrase của key (nếu có)">
              <Input.Password autoComplete="new-password" placeholder={editing ? '(giữ nguyên nếu để trống)' : ''} />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}

/** Sinh id ngẫu nhiên dùng crypto của trình duyệt. */
function cryptoId(): string {
  return crypto.randomUUID();
}
