import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionConfig, SshTunnelConfig, StoredConnection } from '@shared/types';

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

  /** Lưu/cập nhật kết nối; tách password (và bí mật SSH) ra mã hóa riêng. */
  save(config: ConnectionConfig): StoredConnection {
    const { password, ...rest } = config;
    let stored: StoredConnection = rest;

    // Tách bí mật SSH (password/privateKey/passphrase) khỏi options lưu plaintext.
    const ssh = rest.options?.ssh;
    if (ssh) {
      const { password: sshPw, privateKey, passphrase, ...sshPublic } = ssh;
      stored = { ...rest, options: { ...rest.options, ssh: sshPublic } };
      if (sshPw || privateKey || passphrase) {
        this.data.secrets[`${config.id}:ssh`] = this.encrypt(
          JSON.stringify({ password: sshPw, privateKey, passphrase }),
        );
      }
    }

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
    delete this.data.secrets[`${id}:ssh`];
    this.persist();
  }

  /** Ghép password & bí mật SSH đã giải mã vào config để mở kết nối. */
  hydrate(id: string): ConnectionConfig | null {
    const stored = this.data.connections.find((c) => c.id === id);
    if (!stored) return null;
    const enc = this.data.secrets[id];
    const config: ConnectionConfig = { ...stored, password: enc ? this.decrypt(enc) : undefined };

    const sshEnc = this.data.secrets[`${id}:ssh`];
    if (sshEnc && config.options?.ssh) {
      try {
        const sec = JSON.parse(this.decrypt(sshEnc)) as Partial<SshTunnelConfig>;
        config.options = {
          ...config.options,
          ssh: {
            ...config.options.ssh,
            ...(sec.password ? { password: sec.password } : {}),
            ...(sec.privateKey ? { privateKey: sec.privateKey } : {}),
            ...(sec.passphrase ? { passphrase: sec.passphrase } : {}),
          },
        };
      } catch {
        // bí mật hỏng -> bỏ qua, để driver báo lỗi xác thực.
      }
    }
    return config;
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
