import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
// Chỉ nạp highlighting cho các ngôn ngữ cần — giảm kích thước bundle.
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';

// Monaco cần web worker cho các dịch vụ nền. SQL/plaintext chỉ cần editor worker cơ bản.
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

export { monaco };
