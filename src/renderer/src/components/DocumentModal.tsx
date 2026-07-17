import { useEffect, useRef, useState } from 'react';
import { Button, Modal, Space, Spin, message } from 'antd';
import { monaco } from '../monaco-setup';
import type { DataTarget } from '@shared/types';

export type DocumentModalMode = 'view' | 'edit' | 'create';

interface Props {
  open: boolean;
  mode: DocumentModalMode;
  connectionId: string;
  target: DataTarget;
  /** Bắt buộc cho mode 'view'/'edit' để định danh document theo _id. */
  rowKey?: Record<string, unknown>;
  onClose: () => void;
  /** Gọi sau khi lưu/thêm thành công để grid reload. */
  onSaved: () => void;
}

const TITLES: Record<DocumentModalMode, string> = {
  view: 'Chi tiết document',
  edit: 'Sửa document',
  create: 'Thêm document',
};

export function DocumentModal({ open, mode, connectionId, target, rowKey, onClose, onSaved }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Tạo editor khi mở modal; dispose khi đóng.
  useEffect(() => {
    if (!open || !host.current) return;
    const editor = monaco.editor.create(host.current, {
      value: '',
      language: 'json',
      readOnly: mode === 'view',
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, [open, mode]);

  // Nạp nội dung: create -> khung rỗng; view/edit -> fetch theo _id.
  useEffect(() => {
    if (!open) return;
    if (mode === 'create') {
      editorRef.current?.setValue('{\n  \n}');
      return;
    }
    if (!rowKey) return;
    setLoading(true);
    window.api
      .getDocument(connectionId, target, rowKey)
      .then((ejson) => editorRef.current?.setValue(ejson))
      .catch((err) => message.error(`Tải document thất bại: ${(err as Error).message}`))
      .finally(() => setLoading(false));
  }, [open, mode, rowKey, connectionId, target]);

  const handleFormat = () => {
    void editorRef.current?.getAction('editor.action.formatDocument')?.run();
  };

  const handleSave = async () => {
    const text = editorRef.current?.getValue() ?? '';
    try {
      JSON.parse(text); // bắt lỗi cú pháp phía client trước khi gửi
    } catch (err) {
      message.error(`JSON không hợp lệ: ${(err as Error).message}`);
      return;
    }
    setSaving(true);
    try {
      if (mode === 'create') {
        await window.api.insertDocument(connectionId, target, text);
        message.success('Đã thêm document');
      } else if (rowKey) {
        await window.api.updateDocument(connectionId, target, rowKey, text);
        message.success('Đã cập nhật document');
      }
      onSaved();
      onClose();
    } catch (err) {
      message.error(`Lưu thất bại: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={TITLES[mode]}
      width={720}
      onCancel={onClose}
      destroyOnClose
      footer={
        mode === 'view' ? (
          <Button onClick={onClose}>Đóng</Button>
        ) : (
          <Space>
            <Button onClick={handleFormat}>Định dạng</Button>
            <Button onClick={onClose}>Hủy</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>
              Lưu
            </Button>
          </Space>
        )
      }
    >
      <Spin spinning={loading}>
        <div ref={host} style={{ height: 420, border: '1px solid #f0f0f0' }} />
      </Spin>
    </Modal>
  );
}
