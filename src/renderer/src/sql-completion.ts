import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { SchemaObject } from '@shared/types';

export type SuggestionKind = 'table' | 'column' | 'keyword';
export interface Suggestion {
  label: string;
  kind: SuggestionKind;
}

/** Từ khóa SQL cơ bản gợi ý ở ngữ cảnh chung. */
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'GROUP BY',
  'ORDER BY', 'LIMIT', 'OFFSET', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET',
  'VALUES', 'AND', 'OR', 'NOT', 'NULL', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG',
  'MIN', 'MAX', 'LIKE', 'IN', 'BETWEEN', 'IS', 'ASC', 'DESC',
];

/** Từ khóa mà ngay sau nó nên gợi ý tên bảng. */
const TABLE_CONTEXT = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE']);

/** Tìm cột cho `name`: là tên bảng trực tiếp, hoặc alias trong FROM/JOIN cấp một. */
function resolveColumns(name: string, fullText: string, schema: SchemaObject[]): string[] {
  const lower = name.toLowerCase();
  const direct = schema.find((o) => o.table.toLowerCase() === lower);
  if (direct) return direct.columns;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b(?:FROM|JOIN)\\s+[\`"\\[]?(\\w+)[\`"\\]]?\\s+(?:AS\\s+)?${esc}\\b`, 'i');
  const m = fullText.match(re);
  if (m) {
    const tbl = m[1].toLowerCase();
    const found = schema.find((o) => o.table.toLowerCase() === tbl);
    if (found) return found.columns;
  }
  return [];
}

/**
 * Phân tích ngữ cảnh quanh con trỏ để chọn loại gợi ý. Thuần, không phụ thuộc Monaco/DOM.
 *
 * `schema` được phép null (chưa nạp xong, hoặc nạp thất bại). Khi đó KEYWORDS vẫn phải
 * được gợi ý: đó là danh sách tĩnh, không liên quan gì tới metadata. Trước đây provider
 * chặn cứng khi chưa có schema, khiến một lỗi nạp metadata làm câm luôn cả phần keyword —
 * người dùng gõ gì cũng không thấy gợi ý nào.
 */
export function computeSuggestions(
  textUntilCursor: string,
  fullText: string,
  schema: SchemaObject[] | null,
): Suggestion[] {
  const objects = schema ?? [];
  // 1. `<X>.` -> cột của X (bảng hoặc alias)
  const dot = textUntilCursor.match(/([A-Za-z_][\w$]*)\.\s*$/);
  if (dot) {
    return resolveColumns(dot[1], fullText, objects).map((c) => ({ label: c, kind: 'column' as const }));
  }
  // 2. Ngay sau FROM/JOIN/INTO/UPDATE/TABLE (có khoảng trắng) -> tên bảng.
  // Chưa có schema thì trả rỗng, KHÔNG đổ keyword vào: ở đúng vị trí này keyword là gợi ý sai.
  const kw = textUntilCursor.match(/\b([A-Za-z_]+)\s+$/);
  if (kw && TABLE_CONTEXT.has(kw[1].toUpperCase())) {
    return objects.map((o) => ({ label: o.table, kind: 'table' as const }));
  }
  // 3. Mặc định: keyword + tên bảng
  return [
    ...KEYWORDS.map((k) => ({ label: k, kind: 'keyword' as const })),
    ...objects.map((o) => ({ label: o.table, kind: 'table' as const })),
  ];
}

/* ---- Active schema (module-level: chỉ 1 query editor SQL hoạt động 1 lúc) ---- */

let activeSchema: SchemaObject[] | null = null;

export function setActiveSchema(objs: SchemaObject[]): void {
  activeSchema = objs;
}

export function clearActiveSchema(): void {
  activeSchema = null;
}

/** Đăng ký completion provider cho language 'sql'. Gọi 1 lần từ monaco-setup. */
export function registerSqlCompletion(monaco: typeof Monaco): void {
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      // Không chặn khi activeSchema còn null: computeSuggestions vẫn trả keyword được.
      const textUntilCursor = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const kindOf = (k: SuggestionKind): Monaco.languages.CompletionItemKind =>
        k === 'column'
          ? monaco.languages.CompletionItemKind.Field
          : k === 'table'
            ? monaco.languages.CompletionItemKind.Struct
            : monaco.languages.CompletionItemKind.Keyword;
      const suggestions = computeSuggestions(textUntilCursor, model.getValue(), activeSchema).map((s) => ({
        label: s.label,
        kind: kindOf(s.kind),
        insertText: s.label,
        range,
      }));
      return { suggestions };
    },
  });
}
