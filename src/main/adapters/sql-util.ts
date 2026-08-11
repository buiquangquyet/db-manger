/** Escape identifier cho MySQL/MariaDB bằng backtick. */
export function quoteIdentMysql(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Escape identifier cho PostgreSQL bằng dấu nháy kép. */
export function quoteIdentPg(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

import type { ColumnFilter, ForeignKeyInfo, SchemaObject } from '@shared/types';

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

/** Gom các dòng {t: table, c: column} (đã ORDER BY table, ordinal) thành SchemaObject[]. */
export function groupColumnsByTable(rows: { t: string; c: string }[]): SchemaObject[] {
  const map = new Map<string, string[]>();
  for (const { t, c } of rows) {
    const cols = map.get(t);
    if (cols) cols.push(c);
    else map.set(t, [c]);
  }
  return [...map.entries()].map(([table, columns]) => ({ table, columns }));
}

/** Một dòng metadata FK, mỗi cột trong khóa là một dòng. */
export interface FkRow {
  name: string;
  column: string;
  refSchema?: string;
  refTable: string;
  refColumn: string;
  onDelete?: string;
  onUpdate?: string;
}

/**
 * Gom các dòng metadata thành danh sách khóa ngoại.
 * Người gọi PHẢI truyền rows đã sắp theo thứ tự cột trong khóa (ORDER BY ordinal):
 * `columns[i]` và `refColumns[i]` khớp nhau theo chỉ số, sai thứ tự sẽ tạo ra cặp cột sai.
 */
export function groupForeignKeys(rows: FkRow[]): ForeignKeyInfo[] {
  const map = new Map<string, ForeignKeyInfo>();
  for (const r of rows) {
    const found = map.get(r.name);
    if (found) {
      found.columns.push(r.column);
      found.refColumns.push(r.refColumn);
    } else {
      map.set(r.name, {
        name: r.name,
        columns: [r.column],
        refSchema: r.refSchema,
        refTable: r.refTable,
        refColumns: [r.refColumn],
        onDelete: r.onDelete,
        onUpdate: r.onUpdate,
      });
    }
  }
  return [...map.values()];
}
