import { useEffect, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { Button, Space, message } from 'antd';
import { CaretRightOutlined } from '@ant-design/icons';
import { monaco } from '../monaco-setup';
import type { QueryResult } from '@shared/types';

interface Props {
  connectionId: string;
  language: 'sql' | 'plaintext';
  placeholder: string;
}

export function QueryPanel({ connectionId, language, placeholder }: Props) {
  const editorHost = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!editorHost.current) return;
    const editor = monaco.editor.create(editorHost.current, {
      value: placeholder,
      language,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    return () => editor.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    const query = editorRef.current?.getValue() ?? '';
    if (!query.trim()) return;
    setRunning(true);
    try {
      const res = await window.api.executeQuery(connectionId, query);
      setResult(res);
    } catch (err) {
      message.error((err as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const columnDefs: ColDef[] =
    result?.rowSet?.columns.map((c) => ({
      field: c.name,
      headerName: c.name,
      sortable: true,
      resizable: true,
      valueFormatter: (p) =>
        p.value === null || p.value === undefined
          ? ''
          : typeof p.value === 'object'
            ? JSON.stringify(p.value)
            : String(p.value),
    })) ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, borderBottom: '1px solid #f0f0f0' }}>
        <Space>
          <Button type="primary" icon={<CaretRightOutlined />} loading={running} onClick={run}>
            Chạy
          </Button>
          {result && <span style={{ color: '#888' }}>{result.durationMs.toFixed(1)} ms</span>}
        </Space>
      </div>
      <div className="query-editor" ref={editorHost} />
      <div className="grid-wrap ag-theme-quartz">
        {result?.rowSet ? (
          <AgGridReact
            rowData={result.rowSet.rows}
            columnDefs={columnDefs}
            defaultColDef={{ minWidth: 120, filter: true }}
          />
        ) : (
          <pre className="result-message">{result?.message ?? '(chưa có kết quả)'}</pre>
        )}
      </div>
    </div>
  );
}
