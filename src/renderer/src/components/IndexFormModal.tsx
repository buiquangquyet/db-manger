import { useEffect } from 'react';
import { Checkbox, Form, Input, Modal, Select } from 'antd';

interface Props {
  open: boolean;
  /** Danh sách cột của bảng để chọn. */
  columnNames: string[];
  onClose: () => void;
  onSubmit: (index: { name: string; columns: string[]; unique: boolean }) => Promise<void>;
}

export function IndexFormModal({ open, columnNames, onClose, onSubmit }: Props) {
  const [form] = Form.useForm<{ name: string; columns: string[]; unique: boolean }>();

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ unique: false });
    }
  }, [open, form]);

  const handleOk = async () => {
    const v = await form.validateFields();
    await onSubmit({ name: v.name, columns: v.columns, unique: v.unique ?? false });
  };

  return (
    <Modal open={open} title="Thêm index" onCancel={onClose} onOk={handleOk} okText="Thêm" cancelText="Hủy">
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Tên index" rules={[{ required: true, message: 'Nhập tên index' }]}>
          <Input placeholder="vd: idx_created_at" />
        </Form.Item>
        <Form.Item name="columns" label="Cột" rules={[{ required: true, message: 'Chọn ít nhất 1 cột' }]}>
          <Select
            mode="multiple"
            placeholder="Chọn cột"
            options={columnNames.map((c) => ({ value: c, label: c }))}
          />
        </Form.Item>
        <Form.Item name="unique" valuePropName="checked">
          <Checkbox>UNIQUE</Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}
