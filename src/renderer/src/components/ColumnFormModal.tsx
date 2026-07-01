import { useEffect } from 'react';
import { AutoComplete, Checkbox, Form, Input, Modal } from 'antd';
import type { ColumnInfo, ColumnSpec, DbKind } from '@shared/types';
import { TYPE_CATALOG, buildType, parseType, typeAllowsLength } from '../db-types';

interface FormValues {
  name: string;
  baseType: string;
  length: string;
  nullable: boolean;
  default: string;
}

interface Props {
  open: boolean;
  /** null = thêm cột mới; có giá trị = sửa cột. */
  editing: ColumnInfo | null;
  /** Loại DB để gợi ý kiểu dữ liệu phù hợp. */
  kind: DbKind;
  onClose: () => void;
  onSubmit: (spec: ColumnSpec) => Promise<void>;
}

export function ColumnFormModal({ open, editing, kind, onClose, onSubmit }: Props) {
  const [form] = Form.useForm<FormValues>();
  const baseType = Form.useWatch('baseType', form) ?? '';
  const allowsLength = typeAllowsLength(kind, baseType);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      const { base, length } = parseType(editing.dataType);
      form.setFieldsValue({
        name: editing.name,
        baseType: base,
        length,
        nullable: editing.nullable,
        default: editing.default ?? '',
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ nullable: true, baseType: 'varchar', length: '255' });
    }
  }, [open, editing, form]);

  const handleOk = async () => {
    const v = await form.validateFields();
    // Nếu kiểu không cho phép độ dài thì bỏ qua phần độ dài.
    const dataType = buildType(v.baseType, allowsLength ? v.length : '');
    await onSubmit({
      name: v.name,
      dataType,
      nullable: v.nullable ?? false,
      default: v.default ? String(v.default) : null,
    });
  };

  return (
    <Modal
      open={open}
      title={editing ? `Sửa cột: ${editing.name}` : 'Thêm cột'}
      onCancel={onClose}
      onOk={handleOk}
      okText={editing ? 'Cập nhật' : 'Thêm'}
      cancelText="Hủy"
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Tên cột" rules={[{ required: true, message: 'Nhập tên cột' }]}>
          <Input placeholder="vd: created_at" />
        </Form.Item>
        <div style={{ display: 'flex', gap: 8 }}>
          <Form.Item
            name="baseType"
            label="Kiểu dữ liệu"
            rules={[{ required: true, message: 'Chọn kiểu' }]}
            style={{ flex: 2 }}
          >
            <AutoComplete
              options={TYPE_CATALOG[kind].map((t) => ({ value: t.value }))}
              filterOption={(input, option) =>
                (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
              placeholder="vd: varchar, int, decimal"
            />
          </Form.Item>
          <Form.Item
            name="length"
            label="Độ dài / tham số"
            style={{ flex: 1 }}
            help={allowsLength ? undefined : 'Kiểu này không nhận độ dài'}
          >
            <Input placeholder={allowsLength ? 'vd: 255 hoặc 10,2' : '—'} disabled={!allowsLength} />
          </Form.Item>
        </div>
        <Form.Item name="nullable" valuePropName="checked">
          <Checkbox>Cho phép NULL</Checkbox>
        </Form.Item>
        <Form.Item
          name="default"
          label="Giá trị mặc định"
          help="Nhập nguyên văn: chuỗi cần dấu nháy ('abc'), số/hàm thì không (0, CURRENT_TIMESTAMP). Bỏ trống = không đặt."
        >
          <Input placeholder="(bỏ trống nếu không cần)" allowClear />
        </Form.Item>
      </Form>
    </Modal>
  );
}
