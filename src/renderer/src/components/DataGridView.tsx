import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { CellValueChangedEvent, ColDef, GridApi, GridReadyEvent } from 'ag-grid-community';
import { Button, Input, Modal, Pagination, Space, Spin, message } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import type { DataTarget, RowSet } from '@shared/types';
import { AddRowModal } from './AddRowModal';

const PAGE_SIZE = 100;

interface Props {
  connectionId: string;
  target: DataTarget;
  /** Loại DB có cho sửa/thêm/xóa dữ liệu hay không (từ capabilities). */
  inlineEdit: boolean;
}

export function DataGridView({ connectionId, target, inlineEdit }: Props) {
  const [rowSet, setRowSet] = useState<RowSet | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [orderBy, setOrderBy] = useState<{ column: string; dir: 'asc' | 'desc' }[]>([]);
  const [search, setSearch] = useState('');
  const gridApiRef = useRef<GridApi | null>(null);

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const rs = await window.api.readRows(connectionId, target, {
          offset: (p - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
          orderBy: orderBy.length ? orderBy : undefined,
          search: search || undefined,
        });
        setRowSet(rs);
        setSelectedCount(0);
      } catch (err) {
        message.error(`Đọc dữ liệu thất bại: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    },
    [connectionId, target, orderBy, search],
  );

  // Ánh xạ trạng thái sort của ag-grid -> orderBy gửi xuống server (hỗ trợ multi-sort).
  const onSortChanged = useCallback(() => {
    const state = gridApiRef.current?.getColumnState() ?? [];
    const next = state
      .filter((s) => s.sort)
      .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
      .map((s) => ({ column: s.colId, dir: s.sort as 'asc' | 'desc' }));
    setOrderBy(next);
  }, []);

  // Reset về trang 1 mỗi khi đổi bảng/collection.
  useEffect(() => {
    setPage(1);
    void load(1);
  }, [load]);

  // Chỉ cho sửa/xóa khi DB hỗ trợ VÀ bảng có khóa chính (để xác định dòng an toàn).
  const hasPrimaryKey = useMemo(() => rowSet?.columns.some((c) => c.isPrimaryKey) ?? false, [rowSet?.columns]);
  const canEdit = inlineEdit && hasPrimaryKey;
  const canInsert = inlineEdit && (rowSet?.columns.length ?? 0) > 0;

  /** Dựng khóa định danh dòng từ các cột khóa chính. */
  const buildRowKey = useCallback(
    (row: Record<string, unknown>): Record<string, unknown> => {
      const rowKey: Record<string, unknown> = {};
      for (const c of rowSet?.columns ?? []) {
        if (c.isPrimaryKey) rowKey[c.name] = row[c.name];
      }
      return rowKey;
    },
    [rowSet?.columns],
  );

  const columnDefs = useMemo<ColDef[]>(() => {
    const cols: ColDef[] = (rowSet?.columns ?? []).map((c) => ({
      field: c.name,
      // Cột PK gắn nhãn 🔑 để dễ nhận biết.
      headerName: c.isPrimaryKey ? `🔑 ${c.name}` : c.name,
      sortable: true,
      resizable: true,
      // Không cho sửa cột khóa chính (dùng để định danh dòng).
      editable: canEdit && !c.isPrimaryKey,
      valueFormatter: (p) =>
        p.value === null || p.value === undefined ? '' : typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value),
    }));
    // Cột checkbox chọn dòng (chỉ khi có thể xóa).
    if (canEdit) {
      cols.unshift({
        checkboxSelection: true,
        headerCheckboxSelection: true,
        width: 44,
        pinned: 'left',
        headerName: '',
        sortable: false,
        filter: false,
        resizable: false,
      });
    }
    return cols;
  }, [rowSet?.columns, canEdit]);

  const onCellValueChanged = useCallback(
    async (e: CellValueChangedEvent) => {
      const column = e.colDef.field;
      if (!column) return;
      try {
        await window.api.updateCell(connectionId, target, buildRowKey(e.data), column, e.newValue);
        message.success('Đã cập nhật', 1);
      } catch (err) {
        message.error(`Cập nhật thất bại: ${(err as Error).message}`);
        // Hoàn tác giá trị trên grid nếu lưu lỗi.
        e.node.setDataValue(column, e.oldValue);
      }
    },
    [connectionId, target, buildRowKey],
  );

  const handleInsert = async (values: Record<string, unknown>) => {
    try {
      await window.api.insertRow(connectionId, target, values);
    } catch (err) {
      message.error(`Thêm dòng thất bại: ${(err as Error).message}`);
      throw err; // giữ modal mở để người dùng sửa lại
    }
    message.success('Đã thêm dòng');
    setAddOpen(false);
    await load(page);
  };

  const handleDelete = () => {
    const selected = gridApiRef.current?.getSelectedRows() ?? [];
    if (selected.length === 0) return;
    Modal.confirm({
      title: `Xóa ${selected.length} dòng?`,
      content: 'Hành động này không thể hoàn tác.',
      okText: 'Xóa',
      okType: 'danger',
      cancelText: 'Hủy',
      onOk: async () => {
        let ok = 0;
        for (const row of selected) {
          try {
            await window.api.deleteRow(connectionId, target, buildRowKey(row));
            ok++;
          } catch (err) {
            message.error(`Xóa lỗi: ${(err as Error).message}`);
          }
        }
        if (ok > 0) message.success(`Đã xóa ${ok} dòng`);
        await load(page);
      },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: 8,
          borderBottom: '1px solid #f0f0f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Space>
          <Button size="small" icon={<PlusOutlined />} disabled={!canInsert} onClick={() => setAddOpen(true)}>
            Thêm dòng
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={!canEdit || selectedCount === 0}
            onClick={handleDelete}
          >
            Xóa dòng{selectedCount > 0 ? ` (${selectedCount})` : ''}
          </Button>
        </Space>
        <Input.Search
          size="small"
          allowClear
          placeholder="Tìm trên toàn bảng…"
          style={{ width: 260 }}
          defaultValue={search}
          // onSearch bắn cả khi bấm Enter/nút tìm lẫn khi xóa (allowClear) -> value=''.
          onSearch={(v) => setSearch(v.trim())}
        />
      </div>
      <div className="grid-wrap ag-theme-quartz">
        <Spin spinning={loading} wrapperClassName="grid-spin" style={{ height: '100%' }}>
          <AgGridReact
            rowData={rowSet?.rows ?? []}
            columnDefs={columnDefs}
            // filter=false: lọc thực hiện phía server qua ô tìm kiếm (client chỉ có 1 trang).
            defaultColDef={{ minWidth: 120, filter: false }}
            animateRows={false}
            rowSelection="multiple"
            suppressRowClickSelection
            stopEditingWhenCellsLoseFocus
            // Sort do server đảm nhiệm; tắt sort client để không xáo lại trang hiện tại.
            suppressMultiSort={false}
            onCellValueChanged={onCellValueChanged}
            onSortChanged={onSortChanged}
            onGridReady={(e: GridReadyEvent) => (gridApiRef.current = e.api)}
            onSelectionChanged={() => setSelectedCount(gridApiRef.current?.getSelectedRows().length ?? 0)}
          />
        </Spin>
      </div>
      <div style={{ padding: 8, borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#999', fontSize: 12 }}>
          {canEdit
            ? 'Double-click ô để sửa · tick chọn dòng để xóa (cột 🔑 không sửa được)'
            : inlineEdit
              ? 'Không sửa/xóa được: bảng thiếu khóa chính'
              : 'Loại DB này chưa hỗ trợ sửa dữ liệu'}
        </span>
        <Pagination
          size="small"
          current={page}
          pageSize={PAGE_SIZE}
          total={rowSet?.total ?? (page * PAGE_SIZE + (rowSet?.rows.length === PAGE_SIZE ? PAGE_SIZE : 0))}
          showSizeChanger={false}
          showTotal={(t) => (rowSet?.total != null ? `Tổng ${t} dòng` : 'Không đếm chính xác')}
          onChange={(p) => {
            setPage(p);
            void load(p);
          }}
        />
      </div>

      <AddRowModal
        open={addOpen}
        columns={rowSet?.columns ?? []}
        onClose={() => setAddOpen(false)}
        onSubmit={handleInsert}
      />
    </div>
  );
}
