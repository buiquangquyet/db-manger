import net from 'node:net';
import { Client } from 'ssh2';
import type { SshTunnelConfig } from '@shared/types';

interface Tunnel {
  server: net.Server;
  client: Client;
}

/**
 * Quản lý SSH tunnel theo connectionId.
 * Mở một SSH client tới bastion, dựng local TCP server chuyển tiếp mọi kết nối
 * tới DB host:port qua kênh forwardOut. Driver DB kết nối vào local endpoint.
 */
export class TunnelManager {
  private tunnels = new Map<string, Tunnel>();

  /** Mở tunnel; trả về endpoint local (127.0.0.1:port ngẫu nhiên) để driver kết nối. */
  async open(
    id: string,
    ssh: SshTunnelConfig,
    dest: { host: string; port: number },
  ): Promise<{ host: string; port: number }> {
    // Đã có tunnel cho id này -> đóng cái cũ trước.
    await this.close(id);

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      client
        .on('ready', () => resolve())
        .on('error', (err) => reject(err))
        .connect({
          host: ssh.host,
          port: ssh.port || 22,
          username: ssh.user,
          password: ssh.password || undefined,
          privateKey: ssh.privateKey || undefined,
          passphrase: ssh.passphrase || undefined,
          readyTimeout: 15000,
        });
    });

    const server = net.createServer((socket) => {
      client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        dest.host,
        dest.port,
        (err, stream) => {
          if (err) {
            socket.destroy(err);
            return;
          }
          socket.pipe(stream).pipe(socket);
        },
      );
    });

    // Lắng nghe cổng tự do trên loopback.
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('Không lấy được cổng tunnel local'));
      });
    });

    // SSH client sập -> đóng luôn local server để không nhận kết nối treo.
    client.on('close', () => {
      server.close();
      this.tunnels.delete(id);
    });

    this.tunnels.set(id, { server, client });
    return { host: '127.0.0.1', port };
  }

  async close(id: string): Promise<void> {
    const t = this.tunnels.get(id);
    if (!t) return;
    this.tunnels.delete(id);
    await new Promise<void>((resolve) => t.server.close(() => resolve()));
    t.client.end();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.tunnels.keys()].map((id) => this.close(id)));
  }
}
