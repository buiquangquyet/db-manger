import assert from 'node:assert/strict';
import { computeSuggestions } from '../src/renderer/src/sql-completion';
import type { Suggestion } from '../src/renderer/src/sql-completion';

const schema = [
  { table: 'orders', columns: ['id', 'customer_id', 'total'] },
  { table: 'customers', columns: ['id', 'name'] },
];

const labels = (s: Suggestion[]): string[] => s.map((x) => x.label);

// Không có schema vẫn phải gợi ý keyword: KEYWORDS là danh sách tĩnh, không phụ thuộc
// metadata. Đây là ca hồi quy cho lỗi "gõ gì cũng không hiện gì".
{
  const out = computeSuggestions('SEL', 'SEL', null);
  assert.ok(labels(out).includes('SELECT'), 'schema null mà mất luôn keyword');
  assert.ok(
    out.every((s) => s.kind === 'keyword'),
    'schema null thì không được bịa ra table/column',
  );
}

// Schema rỗng (database không có bảng nào) cũng phải còn keyword.
{
  const out = computeSuggestions('WHE', 'WHE', []);
  assert.ok(labels(out).includes('WHERE'));
}

// Sau FROM mà chưa có schema -> rỗng: không bịa tên bảng, cũng không đổ keyword vào
// chỗ mà keyword là gợi ý sai.
{
  assert.deepEqual(computeSuggestions('SELECT * FROM ', 'SELECT * FROM ', null), []);
}

// `alias.` mà chưa có schema -> rỗng.
{
  assert.deepEqual(computeSuggestions('o.', 'SELECT o. FROM orders o', null), []);
}

// Có schema: hành vi cũ giữ nguyên — sau FROM là danh sách bảng.
{
  const out = computeSuggestions('SELECT * FROM ', 'SELECT * FROM ', schema);
  assert.deepEqual(labels(out), ['orders', 'customers']);
  assert.ok(out.every((s) => s.kind === 'table'));
}

// Có schema: alias resolve về cột của bảng thật.
{
  const out = computeSuggestions('SELECT o.', 'SELECT o. FROM orders o', schema);
  assert.deepEqual(labels(out), ['id', 'customer_id', 'total']);
  assert.ok(out.every((s) => s.kind === 'column'));
}

// Có schema: ngữ cảnh chung có cả keyword lẫn tên bảng.
{
  const out = computeSuggestions('SEL', 'SEL', schema);
  assert.ok(labels(out).includes('SELECT'));
  assert.ok(labels(out).includes('orders'));
}

console.log('OK: sql-completion');
