import { useEffect } from 'react';
import { AutoComplete, Button, Checkbox, Form, Input, Modal, Space, message } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnSpec, DbKind } from '@shared/types';
import { TYPE_CATALOG, buildType } from '../db-types';

interface ColumnRow {
  name: string;
  baseType: string;
  length: string;
  nullable: boolean;
  default: string;
}

interface FormValues {
  tableName: string;
  columns: ColumnRow[];
}

interface Props {
  open: boolean;
  connectionId: string;
  kind: DbKind;
  /** Ngữ cảnh database/schema chứa bảng mới. */
  database?: string;
  schema?: string;
  /** Nhãn database/schema để hiển thị tiêu đề. */
  dbLabel: string;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateTableModal({ open, connectionId, kind, database, schema, dbLabel, onClose, onCreated }: Props) {
  const [form] = Form.useForm<FormValues>();
  // MongoDB schemaless: chỉ cần tên collection, không nhập cột.
  const isDocument = kind === 'mongodb';

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      tableName: '',
      columns: isDocument
        ? []
        : [
            { name: 'id', baseType: 'int', length: '', nullable: false, default: '' },
            { name: '', baseType: 'varchar', length: '255', nullable: true, default: '' },
          ],
    });
  }, [open, form, isDocument]);

  const handleOk = async () => {
    const v = await form.validateFields();
    const columns: ColumnSpec[] = isDocument
      ? []
      : v.columns.map((c) => ({
          name: c.name,
          dataType: buildType(c.baseType, c.length ?? ''),
          nullable: c.nullable ?? false,
          default: c.default ? String(c.default) : null,
        }));
    try {
      await window.api.createTable(connectionId, { database, schema, name: v.tableName }, columns);
    } catch (err) {
      message.error(`Tạo ${isDocument ? 'collection' : 'bảng'} thất bại: ${(err as Error).message}`);
      return;
    }
    message.success(`Đã tạo ${isDocument ? 'collection' : 'bảng'} "${v.tableName}"`);
    onCreated();
    onClose();
  };

  return (
    <Modal
      open={open}
      width={isDocument ? 480 : 720}
      title={`Tạo ${isDocument ? 'collection' : 'bảng'} trong ${dbLabel}`}
      onCancel={onClose}
      onOk={handleOk}
      okText="Tạo"
      cancelText="Hủy"
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="tableName"
          label={isDocument ? 'Tên collection' : 'Tên bảng'}
          rules={[{ required: true, message: 'Nhập tên' }]}
        >
          <Input placeholder="vd: users" />
        </Form.Item>

        {!isDocument && (
          <Form.List name="columns">
            {(fields, { add, remove }) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Cột</div>
                {fields.map((field) => (
                  <Space key={field.key} align="baseline" style={{ display: 'flex' }}>
                    <Form.Item
                      name={[field.name, 'name']}
                      rules={[{ required: true, message: 'Tên cột' }]}
                      style={{ marginBottom: 8, width: 160 }}
                    >
                      <Input placeholder="tên cột" />
                    </Form.Item>
                    <Form.Item name={[field.name, 'baseType']} style={{ marginBottom: 8, width: 160 }}>
                      <AutoComplete
                        options={TYPE_CATALOG[kind].map((t) => ({ value: t.value }))}
                        filterOption={(input, option) =>
                          (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                        }
                        placeholder="kiểu"
                      />
                    </Form.Item>
                    <Form.Item name={[field.name, 'length']} style={{ marginBottom: 8, width: 90 }}>
                      <Input placeholder="dài" />
                    </Form.Item>
                    <Form.Item name={[field.name, 'default']} style={{ marginBottom: 8, width: 120 }}>
                      <Input placeholder="default" />
                    </Form.Item>
                    <Form.Item name={[field.name, 'nullable']} valuePropName="checked" style={{ marginBottom: 8 }}>
                      <Checkbox>NULL</Checkbox>
                    </Form.Item>
                    <DeleteOutlined onClick={() => remove(field.name)} style={{ color: '#c00' }} />
                  </Space>
                ))}
                <Button
                  type="dashed"
                  onClick={() => add({ name: '', baseType: 'varchar', length: '255', nullable: true, default: '' })}
                  icon={<PlusOutlined />}
                  style={{ width: 160 }}
                >
                  Thêm cột
                </Button>
              </div>
            )}
          </Form.List>
        )}
      </Form>
    </Modal>
  );
}
