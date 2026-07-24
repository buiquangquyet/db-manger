import type {
  DataTarget,
  DatabaseAdapter,
  TransferProgress,
  TransferRequest,
  TransferSummary,
  TransferTableResult,
} from '@shared/types';

/** Kích thước trang khi đọc nguồn (đọc rồi ghi cả lô). */
const PAGE = 1000;

/** Nguồn cấp adapter theo connectionId (SessionManager thỏa cấu trúc này). */
export interface TransferDeps {
  get(connectionId: string): DatabaseAdapter;
}

/** Copy dữ liệu một bảng (phân trang), trả số dòng đã copy. */
async function copyData(
  source: DatabaseAdapter,
  dest: DatabaseAdapter,
  srcTarget: DataTarget,
  dstTarget: DataTarget,
  req: TransferRequest,
  tableIndex: number,
  tableCount: number,
  name: string,
  onProgress: (p: TransferProgress) => void,
  isCancelled: () => boolean,
  counter: { rows: number },
): Promise<number> {
  const isDoc = source.capabilities.dataModel === 'document';
  let rowsCopied = 0;
  let offset = 0;

  for (;;) {
    if (isCancelled()) break;

    if (isDoc) {
      if (!source.readDocumentsRaw) throw new Error('Adapter nguồn thiếu readDocumentsRaw.');
      const docs = await source.readDocumentsRaw(srcTarget, { offset, limit: PAGE });
      if (docs.length === 0) break;
      if (dest.insertDocumentsRaw) await dest.insertDocumentsRaw(dstTarget, docs);
      else if (dest.insertDocument) for (const d of docs) await dest.insertDocument(dstTarget, d);
      else throw new Error('Adapter đích không ghi được document.');
      rowsCopied += docs.length;
      counter.rows = rowsCopied;
      offset += docs.length;
      onProgress({ transferId: req.transferId, tableIndex, tableCount, currentTable: name, rowsCopied, rowsTotal: null });
      if (docs.length < PAGE) break;
    } else {
      const rs = await source.readRows(srcTarget, { offset, limit: PAGE });
      if (rs.rows.length === 0) break;
      if (dest.insertRows) await dest.insertRows(dstTarget, rs.rows);
      else for (const r of rs.rows) await dest.insertRow(dstTarget, r);
      rowsCopied += rs.rows.length;
      counter.rows = rowsCopied;
      offset += rs.rows.length;
      onProgress({ transferId: req.transferId, tableIndex, tableCount, currentTable: name, rowsCopied, rowsTotal: rs.total });
      if (rs.rows.length < PAGE) break;
    }
  }
  return rowsCopied;
}

/**
 * Copy các bảng được chọn từ nguồn sang đích (cùng loại DB).
 * Lỗi một bảng không chặn bảng khác; hủy đánh dấu các bảng còn lại là 'cancelled'.
 */
export async function runTransfer(
  deps: TransferDeps,
  req: TransferRequest,
  onProgress: (p: TransferProgress) => void,
  isCancelled: () => boolean,
): Promise<TransferSummary> {
  const source = deps.get(req.sourceConnectionId);
  const dest = deps.get(req.destConnectionId);
  if (source.kind !== dest.kind) {
    throw new Error(`Không thể transfer giữa hai loại DB khác nhau (${source.kind} → ${dest.kind}).`);
  }

  const results: TransferTableResult[] = [];
  const tableCount = req.tables.length;

  for (let tableIndex = 0; tableIndex < tableCount; tableIndex++) {
    const name = req.tables[tableIndex];
    if (isCancelled()) {
      results.push({ table: name, status: 'cancelled', rows: 0 });
      continue;
    }

    const srcTarget: DataTarget = { database: req.source.database, schema: req.source.schema, name };
    const dstTarget: DataTarget = { database: req.dest.database, schema: req.dest.schema, name };
    onProgress({ transferId: req.transferId, tableIndex, tableCount, currentTable: name, rowsCopied: 0, rowsTotal: null });

    const counter = { rows: 0 };
    try {
      const existing = await dest.getTableList(req.dest.database, req.dest.schema);
      const exists = existing.some((t) => t.name === name);

      if (req.createStructure && !exists) {
        if (dest.capabilities.dataModel === 'document') {
          await dest.createTable(dstTarget, []);
        } else {
          // Lưu ý (v1 limitation): getCreateStatement (Postgres) trả DDL gắn với schema
          // của NGUỒN, còn executeRaw bỏ qua tham số database/schema đích. Nếu bật
          // createStructure mà tên schema đích khác tên schema nguồn, bảng sẽ được tạo
          // nhầm vào schema nguồn (hoặc schema mặc định) và bước insert kế tiếp sẽ lỗi.
          // Trường hợp cùng tên schema (vd public → public) vẫn hoạt động đúng.
          const ddl = await source.getCreateStatement(srcTarget);
          await dest.executeRaw(ddl, req.dest.database);
        }
      }

      if (req.writeMode === 'truncateInsert' && exists) {
        await dest.truncateTable(dstTarget);
      }

      const rows = await copyData(source, dest, srcTarget, dstTarget, req, tableIndex, tableCount, name, onProgress, isCancelled, counter);
      results.push({ table: name, status: isCancelled() ? 'cancelled' : 'ok', rows });
    } catch (err) {
      results.push({ table: name, status: 'error', rows: counter.rows, error: (err as Error).message });
    }
  }

  return { results, cancelled: isCancelled() };
}
