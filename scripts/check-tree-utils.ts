import assert from 'node:assert/strict';
import { filterTree, findNode, findParentKey, insertChildren } from '../src/renderer/src/lib/tree-utils';

interface N {
  key: string;
  title: string;
  children?: N[];
}

const tree: N[] = [
  {
    key: 'conn:1',
    title: 'Local (mariadb)',
    children: [
      {
        key: 'conn:1:db:shop',
        title: 'shop',
        children: [
          { key: 'conn:1:tbl:orders', title: 'orders' },
          { key: 'conn:1:tbl:order_items', title: 'order_items' },
          { key: 'conn:1:tbl:users', title: 'users' },
        ],
      },
      {
        key: 'conn:1:db:blog',
        title: 'blog',
        children: [{ key: 'conn:1:tbl:posts', title: 'posts' }],
      },
    ],
  },
];

const names = (ns: N[]): string[] => ns.map((n) => n.title);

// query rỗng (kể cả toàn khoảng trắng) -> trả nguyên cây, không expand gì
{
  const r = filterTree(tree, '   ');
  assert.equal(r.nodes, tree);
  assert.deepEqual(r.expandKeys, []);
}

// khớp node lá -> chỉ giữ nhánh dẫn tới kết quả, expandKeys là tổ tiên
{
  const r = filterTree(tree, 'order');
  assert.deepEqual(names(r.nodes), ['Local (mariadb)']);
  assert.deepEqual(names(r.nodes[0].children!), ['shop']);
  assert.deepEqual(names(r.nodes[0].children![0].children!), ['orders', 'order_items']);
  assert.deepEqual([...r.expandKeys].sort(), ['conn:1', 'conn:1:db:shop']);
}

// khớp node cha -> giữ đủ toàn bộ con đã tải, bản thân nó không nằm trong expandKeys
{
  const r = filterTree(tree, 'shop');
  assert.deepEqual(names(r.nodes[0].children!), ['shop']);
  assert.deepEqual(names(r.nodes[0].children![0].children!), ['orders', 'order_items', 'users']);
  assert.deepEqual(r.expandKeys, ['conn:1']);
}

// không khớp gì -> cây rỗng
{
  assert.deepEqual(filterTree(tree, 'zzz').nodes, []);
}

// không phân biệt hoa/thường
{
  const r = filterTree(tree, 'POSTS');
  assert.deepEqual(names(r.nodes[0].children!), ['blog']);
}

// không sửa cây gốc
{
  filterTree(tree, 'order');
  assert.equal(tree[0].children!.length, 2);
  assert.equal(tree[0].children![0].children!.length, 3);
}

// 3 tiện ích chuyển từ Sidebar giữ nguyên hành vi
{
  assert.equal(findNode(tree, 'conn:1:tbl:users')?.title, 'users');
  assert.equal(findNode(tree, 'khong-co'), undefined);
  assert.equal(findParentKey(tree, 'conn:1:db:blog'), 'conn:1');
  assert.equal(findParentKey(tree, 'conn:1'), undefined);

  const next = insertChildren(tree, 'conn:1:db:blog', [{ key: 'conn:1:tbl:tags', title: 'tags' }]);
  assert.deepEqual(names(next[0].children![1].children!), ['tags']);
  assert.deepEqual(names(tree[0].children![1].children!), ['posts']); // gốc không đổi
}

console.log('OK: tree-utils');
