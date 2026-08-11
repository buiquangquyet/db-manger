import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { CellValueChangedEvent, ColDef, GridApi, GridReadyEvent } from 'ag-grid-community';
import { Button, Dropdown, Input, Modal, Pagination, Space, Spin, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import type { ColumnFilter, DataTarget, IoFormat, RowSet } from '@shared/types';
import { AddRowModal } from './AddRowModal';
import { ColumnFilterHeader, type FilterHeaderContext } from './ColumnFilterHeader';
import { DocumentModal, type DocumentModalMode } from './DocumentModal';

const PAGE_SIZE = 100;

interface Props {
  connectionId: string;
  target: DataTarget;
  /** Loại DB có cho sửa/thêm/xóa dữ liệu inline hay không (từ capabilities). */
  inlineEdit: boolean;
  /** Loại DB dùng luồng document JSON (MongoDB) hay không. */
  documentEdit: boolean;
  /** Loại DB hỗ trợ lọc theo cột ở header hay không. */
  columnFilter: boolean;
}

export function DataGridView({ connectionId, target, inlineEdit, documentEdit, columnFilter }: Props) {
  const [rowSet, setRowSet] = useState<RowSet | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [docModal, setDocModal] = useState<{ mode: DocumentModalMode; rowKey?: Record<string, unknown> } | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  const [orderBy, setOrderBy] = useState<{ column: string; dir: 'asc' | 'desc' }[]>([]);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const filtersRef = useRef<ColumnFilter[]>([]);
  filtersRef.current = filters;
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
          filters: filtersRef.current.length ? filtersRef.current : undefined,
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

  const getFilter = useCallback((c: string) => filtersRef.current.find((f) => f.column === c), []);
  const setFilter = useCallback(
    (c: string, cond: ColumnFilter | null) => {
      const next = filtersRef.current.filter((f) => f.column !== c);
      if (cond) next.push(cond);
      filtersRef.current = next;
      setFilters(next);
      setPage(1);
      void load(1);
      gridApiRef.current?.refreshHeader();
    },
    [load],
  );
  const filterContext = useMemo<FilterHeaderContext>(() => ({ getFilter, setFilter }), [getFilter, setFilter]);

  // Ánh xạ trạng thái sort của ag-grid -> orderBy gửi xuống server (hỗ trợ multi-sort).
  const onSortChanged = useCallback(() => {
    const state = gridApiRef.current?.getColumnState() ?? [];
    const next = state
      .filter((s) => s.sort)
      .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
      .map((s) => ({ column: s.colId, dir: s.sort as 'asc' | 'desc' }));
    setOrderBy(next);
  }, []);

  // Xóa filter khi chuyển bảng/collection (tránh áp filter của bảng cũ).
  useEffect(() => {
    filtersRef.current = [];
    setFilters([]);
  }, [target]);

  // Reset về trang 1 mỗi khi đổi bảng/collection.
  useEffect(() => {
    setPage(1);
    void load(1);
  }, [load]);

  // Chỉ cho sửa/xóa khi DB hỗ trợ VÀ bảng có khóa chính (để xác định dòng an toàn).
  const hasPrimaryKey = useMemo(() => rowSet?.columns.some((c) => c.isPrimaryKey) ?? false, [rowSet?.columns]);
  // Sửa ô inline: chỉ luồng SQL.
  const canInlineEdit = inlineEdit && hasPrimaryKey;
  // Xóa dòng: cả SQL (inline) lẫn document (Mongo) đều dùng được nếu có khóa.
  const canDelete = (inlineEdit || documentEdit) && hasPrimaryKey;
  // Thêm dòng/document.
  const canInsert = documentEdit || (inlineEdit && (rowSet?.columns.length ?? 0) > 0);

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
      // Không cho sửa cột khóa chính; chỉ sửa inline ở luồng SQL.
      editable: canInlineEdit && !c.isPrimaryKey,
      ...(columnFilter ? { headerComponent: ColumnFilterHeader } : {}),
      valueFormatter: (p) =>
        p.value === null || p.value === undefined ? '' : typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value),
    }));
    // Cột checkbox chọn dòng (khi có thể xóa).
    if (canDelete) {
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
  }, [rowSet?.columns, canInlineEdit, canDelete, columnFilter]);

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

  const onRowDoubleClicked = useCallback(
    (e: { data: Record<string, unknown> }) => {
      if (!documentEdit) return;
      setDocModal({ mode: 'edit', rowKey: buildRowKey(e.data) });
    },
    [documentEdit, buildRowKey],
  );

  const handleAddClick = () => {
    if (documentEdit) setDocModal({ mode: 'create' });
    else setAddOpen(true);
  };

  const handleExport = async (format: IoFormat) => {
    try {
      const res = await window.api.exportTable(connectionId, target, format);
      if (res.cancelled) return;
      message.success(`Đã xuất ${res.count} dòng → ${res.path}`);
    } catch (err) {
      message.error(`Xuất thất bại: ${(err as Error).message}`);
    }
  };

  const handleImport = async (format: IoFormat) => {
    try {
      const res = await window.api.importTable(connectionId, target, format);
      if (res.cancelled) return;
      message.success(format === 'sql' ? 'Đã chạy file SQL' : `Đã nhập ${res.count} dòng`);
      await load(page);
    } catch (err) {
      message.error(`Nhập thất bại: ${(err as Error).message}`);
    }
  };

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
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load(page)}>
            Tải lại
          </Button>
          <Button size="small" icon={<PlusOutlined />} disabled={!canInsert} onClick={handleAddClick}>
            Thêm dòng
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={!canDelete || selectedCount === 0}
            onClick={handleDelete}
          >
            Xóa dòng{selectedCount > 0 ? ` (${selectedCount})` : ''}
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: 'csv', label: 'CSV' },
                { key: 'json', label: 'JSON' },
                { key: 'sql', label: 'SQL (INSERT)' },
              ],
              onClick: ({ key }) => void handleExport(key as IoFormat),
            }}
          >
            <Button size="small" icon={<DownloadOutlined />}>
              Xuất
            </Button>
          </Dropdown>
          <Dropdown
            menu={{
              items: [
                { key: 'csv', label: 'CSV' },
                { key: 'json', label: 'JSON' },
                { key: 'sql', label: 'SQL (chạy file)' },
              ],
              onClick: ({ key }) => void handleImport(key as IoFormat),
            }}
          >
            <Button size="small" icon={<UploadOutlined />}>
              Nhập
            </Button>
          </Dropdown>
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
            context={filterContext}
            // filter=false: lọc thực hiện phía server qua ô tìm kiếm (client chỉ có 1 trang).
            defaultColDef={{ minWidth: 120, filter: false }}
            animateRows={false}
            rowSelection="multiple"
            suppressRowClickSelection
            stopEditingWhenCellsLoseFocus
            // Sort do server đảm nhiệm; tắt sort client để không xáo lại trang hiện tại.
            suppressMultiSort={false}
            onCellValueChanged={onCellValueChanged}
            onRowDoubleClicked={onRowDoubleClicked}
            onSortChanged={onSortChanged}
            onGridReady={(e: GridReadyEvent) => (gridApiRef.current = e.api)}
            onSelectionChanged={() => setSelectedCount(gridApiRef.current?.getSelectedRows().length ?? 0)}
          />
        </Spin>
      </div>
      <div style={{ padding: 8, borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#999', fontSize: 12 }}>
          {documentEdit
            ? canDelete
              ? 'Double-click để xem/sửa document · tick chọn dòng để xóa'
              : 'Double-click để xem/sửa document'
            : canInlineEdit
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

      {docModal && (
        <DocumentModal
          open
          mode={docModal.mode}
          connectionId={connectionId}
          target={target}
          rowKey={docModal.rowKey}
          onClose={() => setDocModal(null)}
          onSaved={() => void load(page)}
        />
      )}
    </div>
  );
}
