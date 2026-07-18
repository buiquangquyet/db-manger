import { useEffect, useState } from 'react';
import type { IHeaderParams } from 'ag-grid-community';
import { Button, Input, Popover, Select, Space } from 'antd';
import { CaretDownOutlined, CaretUpOutlined, FilterFilled, FilterOutlined } from '@ant-design/icons';
import type { ColumnFilter, FilterOp } from '@shared/types';

/** Callback cầu nối giữa header (ag-grid) và state filter của DataGridView. */
export interface FilterHeaderContext {
  getFilter: (col: string) => ColumnFilter | undefined;
  setFilter: (col: string, cond: ColumnFilter | null) => void;
}

const OPS: { value: FilterOp; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '!=' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'like', label: 'LIKE' },
  { value: 'isNull', label: 'IS NULL' },
  { value: 'isNotNull', label: 'IS NOT NULL' },
];
const NO_VALUE: FilterOp[] = ['isNull', 'isNotNull'];

export function ColumnFilterHeader(props: IHeaderParams) {
  const ctx = props.context as FilterHeaderContext;
  const col = props.column.getColId();
  const existing = ctx.getFilter(col);
  const active = !!existing;

  // Mũi tên sort đồng bộ theo trạng thái cột.
  const [sort, setSort] = useState<string | null | undefined>(props.column.getSort());
  useEffect(() => {
    const onSort = () => setSort(props.column.getSort());
    props.column.addEventListener('sortChanged', onSort);
    return () => props.column.removeEventListener('sortChanged', onSort);
  }, [props.column]);

  const [open, setOpen] = useState(false);
  const [op, setOp] = useState<FilterOp>(existing?.op ?? 'eq');
  const [value, setValue] = useState<string>(existing?.value ?? '');

  // Nạp lại form theo filter hiện có mỗi lần mở popup.
  useEffect(() => {
    if (!open) return;
    const cur = ctx.getFilter(col);
    setOp(cur?.op ?? 'eq');
    setValue(cur?.value ?? '');
  }, [open, col, ctx]);

  const apply = () => {
    const cond: ColumnFilter = NO_VALUE.includes(op)
      ? { column: col, op }
      : { column: col, op, value };
    ctx.setFilter(col, cond);
    setOpen(false);
  };
  const clear = () => {
    ctx.setFilter(col, null);
    setOpen(false);
  };

  const form = (
    <Space direction="vertical" style={{ width: 230 }} onClick={(e) => e.stopPropagation()}>
      <Space.Compact style={{ width: '100%' }}>
        <Select size="small" value={op} options={OPS} style={{ width: 110 }} onChange={(v) => setOp(v)} />
        <Input
          size="small"
          placeholder="giá trị"
          value={value}
          disabled={NO_VALUE.includes(op)}
          onChange={(e) => setValue(e.target.value)}
          onPressEnter={apply}
          allowClear
        />
      </Space.Compact>
      <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
        <Button size="small" onClick={clear} disabled={!active}>Xóa</Button>
        <Button size="small" type="primary" onClick={apply}>Áp dụng</Button>
      </Space>
    </Space>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 4 }}>
      <span
        style={{ flex: 1, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={props.displayName}
        onClick={(e) => props.progressSort(e.shiftKey)}
      >
        {props.displayName}
      </span>
      {sort === 'asc' && <CaretUpOutlined style={{ fontSize: 10 }} />}
      {sort === 'desc' && <CaretDownOutlined style={{ fontSize: 10 }} />}
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomRight"
        destroyTooltipOnHide
        content={form}
      >
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', cursor: 'pointer' }}>
          {active ? <FilterFilled style={{ color: '#1677ff' }} /> : <FilterOutlined style={{ color: '#999' }} />}
        </span>
      </Popover>
    </div>
  );
}
