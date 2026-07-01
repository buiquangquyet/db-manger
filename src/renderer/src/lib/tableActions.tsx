import { Input, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import type { DataTarget, DbKind } from '@shared/types';

/** Ngữ cảnh một bảng/collection để thực hiện thao tác. */
export interface TableActionCtx {
  connectionId: string;
  target: DataTarget;
  label: string;
}

/** Hộp thoại nhập một chuỗi. Trả về giá trị đã trim, hoặc null nếu hủy/để trống. */
export function promptInput(title: string, placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let value = '';
    Modal.confirm({
      title,
      icon: null,
      content: <Input placeholder={placeholder} autoFocus onChange={(e) => (value = e.target.value)} />,
      okText: 'OK',
      cancelText: 'Hủy',
      onOk: () => resolve(value.trim() || null),
      onCancel: () => resolve(null),
    });
  });
}

/** Truncate có xác nhận. Trả về true nếu đã thực hiện (để caller refresh). */
export function confirmTruncate({ connectionId, target, label }: TableActionCtx): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: `Xóa toàn bộ dữ liệu trong "${label}"?`,
      content: 'Giữ nguyên cấu trúc, xóa hết dòng/dữ liệu. Không thể hoàn tác.',
      okText: 'Xóa dữ liệu',
      okType: 'danger',
      cancelText: 'Hủy',
      onOk: async () => {
        try {
          await window.api.truncateTable(connectionId, target);
          message.success('Đã xóa dữ liệu');
          resolve(true);
        } catch (err) {
          message.error(`Thất bại: ${(err as Error).message}`);
          resolve(false);
        }
      },
      onCancel: () => resolve(false),
    });
  });
}

/** Drop có xác nhận. */
export function confirmDrop({ connectionId, target, label }: TableActionCtx): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: `Xóa "${label}"?`,
      content: 'Xóa cả cấu trúc lẫn dữ liệu. Không thể hoàn tác.',
      okText: 'Xóa',
      okType: 'danger',
      cancelText: 'Hủy',
      onOk: async () => {
        try {
          await window.api.dropTable(connectionId, target);
          message.success('Đã xóa');
          resolve(true);
        } catch (err) {
          message.error(`Thất bại: ${(err as Error).message}`);
          resolve(false);
        }
      },
      onCancel: () => resolve(false),
    });
  });
}

/** Đổi tên qua modal có ô nhập. */
export function promptRename({ connectionId, target, label }: TableActionCtx): Promise<boolean> {
  return new Promise((resolve) => {
    let value = label;
    Modal.confirm({
      title: `Đổi tên "${label}"`,
      icon: null,
      content: (
        <Input defaultValue={label} autoFocus onChange={(e) => (value = e.target.value)} />
      ),
      okText: 'Đổi tên',
      cancelText: 'Hủy',
      onOk: async () => {
        const next = value.trim();
        if (!next || next === label) {
          resolve(false);
          return;
        }
        try {
          await window.api.renameTable(connectionId, target, next);
          message.success('Đã đổi tên');
          resolve(true);
        } catch (err) {
          message.error(`Đổi tên thất bại: ${(err as Error).message}`);
          resolve(false);
        }
      },
      onCancel: () => resolve(false),
    });
  });
}

/** Copy SQL của bảng vào clipboard (withData=true kèm INSERT). */
export async function copyTableSql(connectionId: string, target: DataTarget, withData: boolean): Promise<void> {
  try {
    const res = await window.api.copyTableSql(connectionId, target, withData);
    message.success(`Đã copy ${withData ? 'table (SQL + data)' : 'cấu trúc (DDL)'} — ${res.chars} ký tự`);
  } catch (err) {
    message.error(`Copy thất bại: ${(err as Error).message}`);
  }
}

/**
 * Dựng menu thao tác bảng dùng chung cho sidebar & list table.
 * @param onChanged gọi sau truncate/rename/drop để refresh danh sách.
 */
export function buildTableMenu(
  ctx: TableActionCtx,
  kind: DbKind,
  onChanged: () => void,
): MenuProps {
  const isSql = kind === 'mariadb' || kind === 'postgres';
  const items: MenuProps['items'] = [
    { key: 'truncate', label: 'Xóa dữ liệu (truncate)' },
    { key: 'rename', label: 'Đổi tên' },
    { key: 'drop', label: 'Xóa', danger: true },
    { type: 'divider' },
    { key: 'copyTable', label: 'Copy table (SQL + data)', disabled: !isSql },
    { key: 'copyStruct', label: 'Copy cấu trúc (DDL)', disabled: !isSql },
  ];
  const onClick: MenuProps['onClick'] = async ({ key }) => {
    if (key === 'truncate') {
      if (await confirmTruncate(ctx)) onChanged();
    } else if (key === 'drop') {
      if (await confirmDrop(ctx)) onChanged();
    } else if (key === 'rename') {
      if (await promptRename(ctx)) onChanged();
    } else if (key === 'copyTable') {
      await copyTableSql(ctx.connectionId, ctx.target, true);
    } else if (key === 'copyStruct') {
      await copyTableSql(ctx.connectionId, ctx.target, false);
    }
  };
  return { items, onClick };
}
