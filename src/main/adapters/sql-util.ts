/** Escape identifier cho MySQL/MariaDB bằng backtick. */
export function quoteIdentMysql(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Escape identifier cho PostgreSQL bằng dấu nháy kép. */
export function quoteIdentPg(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

import type { ColumnFilter } from '@shared/types';

interface SqlFilterDialect {
  /** escape identifier (quoteIdentPg / quoteIdentMysql). */
  quote: (name: string) => string;
  /** ép biểu thức về text để LIKE (PG: AS TEXT, MySQL: AS CHAR). */
  textCast: (expr: string) => string;
  /** toán tử LIKE không phân biệt hoa/thường (PG: ILIKE, MySQL: LIKE). */
  likeOp: string;
}

const SQL_CMP: Record<'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte', string> = {
  eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
};

/**
 * Dựng các mệnh đề WHERE tham số hóa cho filter từng cột. `addParam(value)` đẩy giá trị vào mảng
 * params của caller và trả về placeholder (`$n` cho PG, `?` cho MySQL). Trả về mảng mệnh đề để
 * caller nối bằng AND. isNull/isNotNull không tạo param. Giá trị luôn tham số hóa (không nội suy).
 */
export function buildColumnFilterClauses(
  filters: ColumnFilter[],
  d: SqlFilterDialect,
  addParam: (value: unknown) => string,
): string[] {
  const clauses: string[] = [];
  for (const f of filters) {
    const col = d.quote(f.column);
    if (f.op === 'isNull') { clauses.push(`${col} IS NULL`); continue; }
    if (f.op === 'isNotNull') { clauses.push(`${col} IS NOT NULL`); continue; }
    if (f.op === 'like') {
      clauses.push(`${d.textCast(col)} ${d.likeOp} ${addParam(`%${f.value ?? ''}%`)}`);
      continue;
    }
    clauses.push(`${col} ${SQL_CMP[f.op]} ${addParam(f.value)}`);
  }
  return clauses;
}
