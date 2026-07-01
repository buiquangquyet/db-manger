import type { ConnectionConfig, DatabaseAdapter } from '@shared/types';
import { createAdapter } from './adapters';

/** Giữ các adapter đang mở theo connectionId để tái sử dụng giữa các lần gọi IPC. */
export class SessionManager {
  private sessions = new Map<string, DatabaseAdapter>();

  async open(config: ConnectionConfig): Promise<DatabaseAdapter> {
    const existing = this.sessions.get(config.id);
    if (existing) return existing;
    const adapter = createAdapter(config);
    await adapter.connect();
    this.sessions.set(config.id, adapter);
    return adapter;
  }

  get(connectionId: string): DatabaseAdapter {
    const adapter = this.sessions.get(connectionId);
    if (!adapter) throw new Error(`Phiên chưa mở cho kết nối ${connectionId}`);
    return adapter;
  }

  async close(connectionId: string): Promise<void> {
    const adapter = this.sessions.get(connectionId);
    if (!adapter) return;
    await adapter.disconnect();
    this.sessions.delete(connectionId);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((a) => a.disconnect()));
    this.sessions.clear();
  }
}
