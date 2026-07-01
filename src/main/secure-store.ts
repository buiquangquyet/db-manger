import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionConfig, StoredConnection } from '@shared/types';

/**
 * Lưu danh sách kết nối vào userData/connections.json.
 * Mật khẩu KHÔNG lưu plaintext: mã hóa bằng safeStorage (keychain OS) và cất riêng.
 */
interface PersistShape {
  connections: StoredConnection[];
  /** id -> mật khẩu đã mã hóa (base64). */
  secrets: Record<string, string>;
}

export class SecureStore {
  private file: string;
  private data: PersistShape = { connections: [], secrets: {} };

  constructor() {
    this.file = join(app.getPath('userData'), 'connections.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf-8')) as PersistShape;
      this.data.connections ??= [];
      this.data.secrets ??= {};
    } catch {
      this.data = { connections: [], secrets: {} };
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  list(): StoredConnection[] {
    return this.data.connections;
  }

  /** Lưu/cập nhật kết nối; tách password ra mã hóa riêng. */
  save(config: ConnectionConfig): StoredConnection {
    const { password, ...rest } = config;
    const stored: StoredConnection = rest;

    const idx = this.data.connections.findIndex((c) => c.id === config.id);
    if (idx >= 0) this.data.connections[idx] = stored;
    else this.data.connections.push(stored);

    if (password !== undefined && password !== '') {
      this.data.secrets[config.id] = this.encrypt(password);
    }
    this.persist();
    return stored;
  }

  delete(id: string): void {
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    delete this.data.secrets[id];
    this.persist();
  }

  /** Ghép password đã giải mã vào config để mở kết nối. */
  hydrate(id: string): ConnectionConfig | null {
    const stored = this.data.connections.find((c) => c.id === id);
    if (!stored) return null;
    const enc = this.data.secrets[id];
    return { ...stored, password: enc ? this.decrypt(enc) : undefined };
  }

  private encrypt(plain: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: không có keychain (vd Linux thiếu libsecret) -> đánh dấu plaintext base64.
      return 'plain:' + Buffer.from(plain, 'utf-8').toString('base64');
    }
    return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  }

  private decrypt(stored: string): string {
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf-8');
    }
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    return '';
  }
}
