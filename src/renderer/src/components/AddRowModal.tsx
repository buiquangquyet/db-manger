import { useEffect } from 'react';
import { Form, Input, Modal } from 'antd';
import type { ColumnDef } from '@shared/types';

interface Props {
  open: boolean;
  columns: ColumnDef[];
  onClose: () => void;
  /** Trả về map cột->giá trị, chỉ gồm các cột người dùng đã nhập. */
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}

export function AddRowModal({ open, columns, onClose, onSubmit }: Props) {
  const [form] = Form.useForm();

  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  const handleOk = async () => {
    const raw = (await form.validateFields()) as Record<string, string>;
    // Chỉ gửi cột có nhập giá trị -> cột bỏ trống dùng default/auto-increment của DB.
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined && v !== '') values[k] = v;
    }
    await onSubmit(values);
  };

  return (
    <Modal open={open} title="Thêm dòng mới" onCancel={onClose} onOk={handleOk} okText="Thêm" cancelText="Hủy">
      <Form form={form} layout="vertical">
        {columns.map((c) => (
          <Form.Item
            key={c.name}
            name={c.name}
            label={c.isPrimaryKey ? `🔑 ${c.name}` : c.name}
            help={c.isPrimaryKey ? 'Bỏ trống nếu dùng auto-increment' : undefined}
          >
            <Input placeholder="(bỏ trống = mặc định / NULL)" allowClear />
          </Form.Item>
        ))}
      </Form>
    </Modal>
  );
}
