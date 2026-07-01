import type { DbKind } from '@shared/types';

/** Một kiểu dữ liệu và việc nó có nhận tham số độ dài/precision hay không. */
export interface TypeOption {
  value: string;
  /** Có cho phép độ dài/tham số trong ngoặc, vd varchar(255), decimal(10,2). */
  hasLength: boolean;
}

/** Danh mục kiểu phổ biến theo từng loại DB (dùng gợi ý; vẫn cho nhập tự do). */
export const TYPE_CATALOG: Record<DbKind, TypeOption[]> = {
  mariadb: [
    { value: 'int', hasLength: false },
    { value: 'bigint', hasLength: false },
    { value: 'tinyint', hasLength: false },
    { value: 'smallint', hasLength: false },
    { value: 'varchar', hasLength: true },
    { value: 'char', hasLength: true },
    { value: 'text', hasLength: false },
    { value: 'longtext', hasLength: false },
    { value: 'decimal', hasLength: true },
    { value: 'float', hasLength: false },
    { value: 'double', hasLength: false },
    { value: 'date', hasLength: false },
    { value: 'datetime', hasLength: false },
    { value: 'timestamp', hasLength: false },
    { value: 'time', hasLength: false },
    { value: 'boolean', hasLength: false },
    { value: 'json', hasLength: false },
    { value: 'blob', hasLength: false },
    { value: 'enum', hasLength: true },
  ],
  postgres: [
    { value: 'integer', hasLength: false },
    { value: 'bigint', hasLength: false },
    { value: 'smallint', hasLength: false },
    { value: 'serial', hasLength: false },
    { value: 'bigserial', hasLength: false },
    { value: 'varchar', hasLength: true },
    { value: 'character varying', hasLength: true },
    { value: 'char', hasLength: true },
    { value: 'text', hasLength: false },
    { value: 'numeric', hasLength: true },
    { value: 'real', hasLength: false },
    { value: 'double precision', hasLength: false },
    { value: 'date', hasLength: false },
    { value: 'timestamp', hasLength: false },
    { value: 'timestamptz', hasLength: false },
    { value: 'boolean', hasLength: false },
    { value: 'json', hasLength: false },
    { value: 'jsonb', hasLength: false },
    { value: 'uuid', hasLength: false },
  ],
  mongodb: [],
  redis: [],
};

/** Tách chuỗi kiểu thành phần kiểu và phần độ dài. Vd "varchar(255)" -> {base:"varchar", length:"255"}. */
export function parseType(dataType: string): { base: string; length: string } {
  const m = /^([^(]+)\(([^)]*)\)(.*)$/.exec(dataType.trim());
  if (m) return { base: (m[1] + m[3]).trim(), length: m[2].trim() };
  return { base: dataType.trim(), length: '' };
}

/** Ghép lại kiểu + độ dài. Vd ("varchar","255") -> "varchar(255)". */
export function buildType(base: string, length: string): string {
  const b = base.trim();
  const l = length.trim();
  return l ? `${b}(${l})` : b;
}

/** Kiểu này có cho phép nhập độ dài không? Không có trong danh mục -> cho phép (an toàn). */
export function typeAllowsLength(kind: DbKind, base: string): boolean {
  const entry = TYPE_CATALOG[kind].find((t) => t.value === base.trim().toLowerCase());
  return entry ? entry.hasLength : true;
}
