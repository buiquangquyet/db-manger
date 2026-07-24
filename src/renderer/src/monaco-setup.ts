import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
// Chỉ nạp highlighting cho các ngôn ngữ cần — giảm kích thước bundle.
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import { registerSqlCompletion } from './sql-completion';

// Monaco cần web worker cho các dịch vụ nền. JSON dùng json worker (validate/format),
// còn lại dùng editor worker cơ bản.
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    label === 'json' ? new jsonWorker() : new editorWorker(),
};

registerSqlCompletion(monaco);

export { monaco };
