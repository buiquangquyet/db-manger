import type { ConnectionConfig, DatabaseAdapter, TestConnectionResult } from '@shared/types';
import { createAdapter } from './adapters';
import { TunnelManager } from './tunnel';

/** Giữ các adapter đang mở theo connectionId để tái sử dụng giữa các lần gọi IPC. */
export class SessionManager {
  private sessions = new Map<string, DatabaseAdapter>();
  private tunnels = new TunnelManager();

  /** Nếu config bật SSH, mở tunnel và trả về config với host/port trỏ vào local endpoint. */
  private async withTunnel(id: string, config: ConnectionConfig): Promise<ConnectionConfig> {
    const ssh = config.options?.ssh;
    if (!ssh?.host) return config;
    const local = await this.tunnels.open(id, ssh, { host: config.host, port: config.port });
    return { ...config, host: local.host, port: local.port };
  }

  async open(config: ConnectionConfig): Promise<DatabaseAdapter> {
    const existing = this.sessions.get(config.id);
    if (existing) return existing;
    const effective = await this.withTunnel(config.id, config);
    const adapter = createAdapter(effective);
    try {
      await adapter.connect();
    } catch (err) {
      await this.tunnels.close(config.id);
      throw err;
    }
    this.sessions.set(config.id, adapter);
    return adapter;
  }

  /** Kiểm tra kết nối (kèm SSH tunnel nếu có) rồi dọn dẹp — không giữ session. */
  async test(config: ConnectionConfig): Promise<TestConnectionResult> {
    const tunnelId = `test:${config.id}`;
    let effective = config;
    try {
      const ssh = config.options?.ssh;
      if (ssh?.host) {
        const local = await this.tunnels.open(tunnelId, ssh, { host: config.host, port: config.port });
        effective = { ...config, host: local.host, port: local.port };
      }
    } catch (err) {
      return { ok: false, error: `SSH tunnel lỗi: ${(err as Error).message}` };
    }
    const adapter = createAdapter(effective);
    try {
      return await adapter.testConnection();
    } finally {
      await adapter.disconnect();
      await this.tunnels.close(tunnelId);
    }
  }

  get(connectionId: string): DatabaseAdapter {
    const adapter = this.sessions.get(connectionId);
    if (!adapter) throw new Error(`Phiên chưa mở cho kết nối ${connectionId}`);
    return adapter;
  }

  async close(connectionId: string): Promise<void> {
    const adapter = this.sessions.get(connectionId);
    if (adapter) {
      await adapter.disconnect();
      this.sessions.delete(connectionId);
    }
    await this.tunnels.close(connectionId);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((a) => a.disconnect()));
    this.sessions.clear();
    await this.tunnels.closeAll();
  }
}
