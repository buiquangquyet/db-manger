/** Escape identifier cho MySQL/MariaDB bằng backtick. */
export function quoteIdentMysql(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Escape identifier cho PostgreSQL bằng dấu nháy kép. */
export function quoteIdentPg(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
