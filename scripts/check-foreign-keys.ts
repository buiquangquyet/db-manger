import assert from 'node:assert/strict';
import { groupForeignKeys } from '../src/main/adapters/sql-util';

// Thứ tự dòng vào = thứ tự cột trong khóa (adapter đã ORDER BY ordinal).
const rows = [
  { name: 'fk_order_customer', column: 'customer_id', refTable: 'customers', refColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { name: 'fk_item_pair', column: 'order_id', refTable: 'orders', refColumn: 'id' },
  { name: 'fk_item_pair', column: 'line_no', refTable: 'orders', refColumn: 'line_no' },
];

// Gom theo tên constraint, giữ nguyên thứ tự cột nguồn và cột đích
{
  const fks = groupForeignKeys(rows);
  assert.deepEqual(fks.map((f) => f.name), ['fk_order_customer', 'fk_item_pair']);
  assert.deepEqual(fks[1].columns, ['order_id', 'line_no']);
  assert.deepEqual(fks[1].refColumns, ['id', 'line_no']);
  assert.equal(fks[1].refTable, 'orders');
}

// Khóa đơn giữ được onDelete/onUpdate
{
  const fk = groupForeignKeys(rows)[0];
  assert.equal(fk.onDelete, 'CASCADE');
  assert.equal(fk.onUpdate, 'NO ACTION');
  assert.deepEqual(fk.columns, ['customer_id']);
}

// refSchema được giữ khi có (Postgres trỏ sang schema khác)
{
  const fks = groupForeignKeys([
    { name: 'fk_x', column: 'a', refSchema: 'other', refTable: 't', refColumn: 'id' },
  ]);
  assert.equal(fks[0].refSchema, 'other');
}

// Mảng rỗng -> mảng rỗng, không ném
{
  assert.deepEqual(groupForeignKeys([]), []);
}

// Không sửa mảng đầu vào
{
  const input = [{ name: 'fk_a', column: 'x', refTable: 't', refColumn: 'id' }];
  groupForeignKeys(input);
  assert.equal(input.length, 1);
  assert.equal(input[0].column, 'x');
}

console.log('OK: foreign-keys');
