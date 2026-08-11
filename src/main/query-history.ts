import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { QueryHistoryEntry } from '@shared/types';

const CAP = 500;

/**
 * Thêm một phần tử và giữ danh sách không vượt quá `cap`, đẩy phần tử cũ nhất ra.
 * Tách riêng để kiểm được headless (không đụng fs/electron).
 */
export function pushCapped<T>(list: T[], entry: T, cap: number): T[] {
  const next = [...list, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Lưu lịch sử query vào userData/query-history.json.
 *
 * LƯU Ý BẢO MẬT (có chủ ý, xem PRD): file lưu TOÀN VĂN mọi query, gồm cả dữ liệu nhạy
 * cảm trong mệnh đề WHERE, và KHÔNG mã hóa — khác với mật khẩu kết nối vốn đi qua
 * safeStorage trong secure-store.ts. Chấp nhận được cho công cụ dev chạy local.
 */
export class QueryHistoryStore {
  private file: string;
  private entries: QueryHistoryEntry[] = [];

  constructor() {
    // Lấy `electron` bằng require lazy (thay vì `import ... from 'electron'` ở đầu file):
    // import tĩnh sẽ khiến cả module này (kể cả pushCapped) không thể bundle/chạy headless
    // được nữa, vì gói npm `electron` có side effect ở top-level (esbuild không tree-shake
    // được) — phá luôn script kiểm chứng ở scripts/check-query-history.ts.
    const { app } = createRequire(import.meta.url)('electron') as typeof import('electron');
    this.file = join(app.getPath('userData'), 'query-history.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as { entries?: QueryHistoryEntry[] };
      this.entries = parsed.entries ?? [];
    } catch {
      // File hỏng thì bắt đầu lại từ rỗng — lịch sử không đáng để chặn app khởi động.
      this.entries = [];
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify({ entries: this.entries }, null, 2), 'utf-8');
    } catch {
      // Ghi lịch sử thất bại không được làm hỏng việc chạy query.
    }
  }

  /** Mới nhất trước. */
  list(): QueryHistoryEntry[] {
    return [...this.entries].reverse();
  }

  add(entry: Omit<QueryHistoryEntry, 'id'>): void {
    this.entries = pushCapped(this.entries, { ...entry, id: randomUUID() }, CAP);
    this.persist();
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }
}
