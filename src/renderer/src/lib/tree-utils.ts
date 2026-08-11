/** Node tối thiểu mà các tiện ích dưới đây cần: có key, nhãn hiển thị và (tùy chọn) con. */
export interface TreeLike<T> {
  key: string;
  title: string;
  children?: T[];
}

export interface FilterResult<T> {
  /** Cây sau khi lọc. */
  nodes: T[];
  /** Key của các node tổ tiên chứa kết quả -> dùng để tự mở nhánh. */
  expandKeys: string[];
}

/** Tìm node theo key (đệ quy). */
export function findNode<T extends TreeLike<T>>(nodes: T[], key: string): T | undefined {
  for (const n of nodes) {
    if (n.key === key) return n;
    if (n.children) {
      const found = findNode(n.children, key);
      if (found) return found;
    }
  }
  return undefined;
}

/** Tìm key của node cha chứa childKey (đệ quy). */
export function findParentKey<T extends TreeLike<T>>(
  nodes: T[],
  childKey: string,
  parentKey?: string,
): string | undefined {
  for (const n of nodes) {
    if (n.key === childKey) return parentKey;
    if (n.children) {
      const found = findParentKey(n.children, childKey, n.key);
      if (found) return found;
    }
  }
  return undefined;
}

/** Chèn danh sách con vào node có key cho trước (đệ quy, trả cây mới). */
export function insertChildren<T extends TreeLike<T>>(nodes: T[], key: string, children: T[]): T[] {
  return nodes.map((n) => {
    if (n.key === key) return { ...n, children };
    if (n.children) return { ...n, children: insertChildren(n.children, key, children) };
    return n;
  });
}

/**
 * Lọc cây theo tên node.
 *
 * - Giữ node khi chính nó khớp, hoặc khi có con cháu khớp.
 * - Node tự khớp thì giữ nguyên toàn bộ con đã tải (không lọc tiếp xuống dưới),
 *   để gõ tên database vẫn xem được đầy đủ bảng bên trong.
 * - query rỗng trả về chính mảng đầu vào, không tạo bản sao.
 */
export function filterTree<T extends TreeLike<T>>(nodes: T[], query: string): FilterResult<T> {
  const q = query.trim().toLowerCase();
  if (!q) return { nodes, expandKeys: [] };

  const expandKeys: string[] = [];

  const walk = (list: T[]): T[] => {
    const kept: T[] = [];
    for (const n of list) {
      if (n.title.toLowerCase().includes(q)) {
        kept.push(n);
        continue;
      }
      const children = n.children ? walk(n.children) : [];
      if (children.length > 0) {
        expandKeys.push(n.key);
        kept.push({ ...n, children });
      }
    }
    return kept;
  };

  return { nodes: walk(nodes), expandKeys };
}
