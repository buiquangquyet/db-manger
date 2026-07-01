import type { ConnectionConfig, DatabaseAdapter } from '@shared/types';
import { MariaDbAdapter } from './mariadb';
import { PostgresAdapter } from './postgres';
import { MongoAdapter } from './mongo';
import { RedisAdapter } from './redis';

/** Tạo adapter phù hợp theo loại DB. */
export function createAdapter(config: ConnectionConfig): DatabaseAdapter {
  switch (config.kind) {
    case 'mariadb':
      return new MariaDbAdapter(config);
    case 'postgres':
      return new PostgresAdapter(config);
    case 'mongodb':
      return new MongoAdapter(config);
    case 'redis':
      return new RedisAdapter(config);
    default:
      throw new Error(`Loại DB chưa hỗ trợ: ${(config as ConnectionConfig).kind}`);
  }
}
