import { clipboard, dialog } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import type { DataTarget, ExportResult, ImportResult, IoFormat, RowSet } from '@shared/types';
import type { SessionManager } from './session-manager';

/** Giới hạn an toàn số dòng đọc khi export (tránh treo với bảng khổng lồ). */
const EXPORT_CAP = 100_000;
const PAGE = 1000;

/** Đọc toàn bộ dòng của một bảng bằng cách phân trang qua readRows (không thêm API adapter). */
async function readAll(sessions: SessionManager, connectionId: string, target: DataTarget): Promise<RowSet> {
  const adapter = sessions.get(connectionId);
  const rows: Record<string, unknown>[] = [];
  let columns: RowSet['columns'] = [];
  let offset = 0;
  for (;;) {
    const rs = await adapter.readRows(target, { offset, limit: PAGE });
    columns = rs.columns;
    rows.push(...rs.rows);
    if (rs.rows.length < PAGE || rows.length >= EXPORT_CAP) break;
    offset += PAGE;
  }
  return { columns, rows: rows.slice(0, EXPORT_CAP), total: rows.length };
}

/* ---------------------- Serialize ---------------------- */

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Bọc một trường CSV: thêm nháy kép nếu chứa dấu phẩy/nháy/xuống dòng. */
function csvField(v: unknown): string {
  const s = cellText(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rs: RowSet): string {
  const header = rs.columns.map((c) => csvField(c.name)).join(',');
  const lines = rs.rows.map((r) => rs.columns.map((c) => csvField(r[c.name])).join(','));
  return [header, ...lines].join('\r\n');
}

function toJson(rs: RowSet): string {
  return JSON.stringify(rs.rows, null, 2);
}

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function toSql(target: DataTarget, rs: RowSet): string {
  const qualifier = target.schema ? `"${target.schema}".` : target.database ? `\`${target.database}\`.` : '';
  const table = `${qualifier}${target.name}`;
  const cols = rs.columns.map((c) => c.name);
  const colList = cols.join(', ');
  return rs.rows
    .map((r) => `INSERT INTO ${table} (${colList}) VALUES (${cols.map((c) => sqlValue(r[c])).join(', ')});`)
    .join('\n');
}

/* ---------------------- Parse ---------------------- */

/** Parse CSV thành mảng object theo header. Hỗ trợ trường có nháy kép, phẩy, xuống dòng. */
function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  // Trường/hàng cuối (nếu file không kết thúc bằng xuống dòng).
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => {
    const obj: Record<string, unknown> = {};
    header.forEach((h, idx) => { obj[h] = r[idx] ?? ''; });
    return obj;
  });
}

/* ---------------------- IPC entry points ---------------------- */

export async function exportTable(
  sessions: SessionManager,
  connectionId: string,
  target: DataTarget,
  format: IoFormat,
): Promise<ExportResult> {
  const rs = await readAll(sessions, connectionId, target);
  const content = format === 'csv' ? toCsv(rs) : format === 'json' ? toJson(rs) : toSql(target, rs);
  const res = await dialog.showSaveDialog({
    defaultPath: `${target.name}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (res.canceled || !res.filePath) return { count: 0, cancelled: true };
  await writeFile(res.filePath, content, 'utf8');
  return { path: res.filePath, count: rs.rows.length };
}

export async function importTable(
  sessions: SessionManager,
  connectionId: string,
  target: DataTarget,
  format: IoFormat,
): Promise<ImportResult> {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (res.canceled || !res.filePaths[0]) return { count: 0, cancelled: true };
  const text = await readFile(res.filePaths[0], 'utf8');
  const adapter = sessions.get(connectionId);

  if (format === 'sql') {
    // Chạy nguyên file .sql (nhiều câu lệnh) qua executeRaw.
    await adapter.executeRaw(text, { database: target.database, schema: target.schema });
    return { count: 0 };
  }

  const rows: Record<string, unknown>[] = format === 'csv' ? parseCsv(text) : JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('File JSON phải là một mảng object.');
  let count = 0;
  for (const row of rows) {
    await adapter.insertRow(target, row);
    count++;
  }
  return { count };
}

/** Dựng SQL của bảng (DDL, kèm INSERT nếu withData) và copy vào clipboard hệ thống. */
export async function copyTableSql(
  sessions: SessionManager,
  connectionId: string,
  target: DataTarget,
  withData: boolean,
): Promise<{ chars: number }> {
  const adapter = sessions.get(connectionId);
  let sql = await adapter.getCreateStatement(target);
  if (withData) {
    const rs = await readAll(sessions, connectionId, target);
    if (rs.rows.length) sql += `\n\n${toSql(target, rs)}`;
  }
  clipboard.writeText(sql);
  return { chars: sql.length };
}

export async function saveTextFile(
  defaultName: string,
  content: string,
): Promise<{ path?: string; cancelled?: boolean }> {
  const res = await dialog.showSaveDialog({ defaultPath: defaultName });
  if (res.canceled || !res.filePath) return { cancelled: true };
  await writeFile(res.filePath, content, 'utf8');
  return { path: res.filePath };
}
