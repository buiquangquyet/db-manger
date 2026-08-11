import assert from 'node:assert/strict';
import { pushCapped } from '../src/main/query-history';

// Dưới cap: thêm vào cuối, giữ nguyên thứ tự
{
  const out = pushCapped([1, 2], 3, 5);
  assert.deepEqual(out, [1, 2, 3]);
}

// Chạm cap: đẩy phần tử CŨ NHẤT ra
{
  const out = pushCapped([1, 2, 3], 4, 3);
  assert.deepEqual(out, [2, 3, 4]);
}

// Danh sách dài hơn cap (vd cap bị giảm giữa chừng) -> cắt về đúng cap
{
  const out = pushCapped([1, 2, 3, 4, 5], 6, 3);
  assert.deepEqual(out, [4, 5, 6]);
}

// cap = 1
{
  assert.deepEqual(pushCapped([1], 2, 1), [2]);
}

// Không sửa mảng đầu vào
{
  const input = [1, 2, 3];
  pushCapped(input, 4, 3);
  assert.deepEqual(input, [1, 2, 3]);
}

console.log('OK: query-history');
