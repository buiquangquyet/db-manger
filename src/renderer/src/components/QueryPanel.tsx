import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { Button, Dropdown, Select, Space, message } from 'antd';
import { CaretRightOutlined, DownloadOutlined } from '@ant-design/icons';
import { monaco } from '../monaco-setup';
import { setActiveSchema, clearActiveSchema } from '../sql-completion';
import type { QueryResult, QueryTarget, RowSet, StoredConnection } from '@shared/types';

/** Loại DB có khái niệm đích chạy chọn được trong panel (khớp phạm vi v2 của spec). */
const TARGETABLE = ['mariadb', 'postgres'] as const;

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Bọc trường CSV nếu chứa dấu phẩy/nháy/xuống dòng. */
function csvField(v: unknown): string {
  const s = cellText(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowSetToCsv(rs: RowSet): string {
  const names = rs.columns.map((c) => c.name);
  const header = names.map(csvField).join(',');
  return [header, ...rs.rows.map((r) => names.map((n) => csvField(r[n])).join(','))].join('\r\n');
}

interface Props {
  connectionId: string;
  language: 'sql' | 'plaintext';
  placeholder: string;
  database?: string;
  schema?: string;
  /** Danh sách kết nối đã lưu — nguồn cho select server host. */
  connections: StoredConnection[];
}

export function QueryPanel({
  connectionId,
  language,
  placeholder,
  database,
  schema,
  connections,
}: Props) {
  const editorHost = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  // Đích chạy query, tách khỏi phiên đang mở ở tab: cho phép chạy sang kết nối khác
  // mà không đổi toàn bộ ngữ cảnh app.
  const [targetConnId, setTargetConnId] = useState(connectionId);
  // Dùng chung cho database (MariaDB) và schema (Postgres) — mỗi lúc chỉ một nghĩa.
  const [targetDb, setTargetDb] = useState<string | undefined>(database ?? schema);
  const [dbOptions, setDbOptions] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);

  // Chỉ kết nối SQL mới chọn được đích; Mongo/Redis giữ nguyên hành vi cũ.
  const hostOptions = useMemo(
    () => connections.filter((c) => (TARGETABLE as readonly string[]).includes(c.kind)),
    [connections],
  );
  const targetKind = hostOptions.find((c) => c.id === targetConnId)?.kind;
  // Bám vào language thay vì tra `connections`: danh sách kết nối nạp bất đồng bộ, tra ở
  // đó sẽ khiến hai select nhấp nháy ẩn/hiện ở lần render đầu. `language === 'sql'` đến
  // từ capabilities của phiên nên đã đúng ngay từ đầu, và chỉ đúng với mariadb/postgres.
  const showTargets = language === 'sql';
  const dbLabel = targetKind === 'postgres' ? 'Schema' : 'Database';

  /** Đổi host: xóa luôn database đang chọn vì tên đó thường không tồn tại ở server khác. */
  const changeHost = (id: string) => {
    setTargetConnId(id);
    setTargetDb(undefined);
    setDbOptions([]);
  };

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

  // Sidebar luôn ghi đè: mỗi lần người dùng bấm database khác ở cây, đích chạy nhảy theo.
  // Prop chỉ đổi khi sidebar đổi, nên lựa chọn tay được giữ tới lần bấm sidebar kế tiếp.
  useEffect(() => {
    setTargetConnId(connectionId);
    setTargetDb(database ?? schema);
  }, [connectionId, database, schema]);

  // Nạp danh sách database/schema của host đích; mở phiên trước nếu kết nối chưa mở.
  useEffect(() => {
    if (!showTargets) return;
    let cancelled = false;
    setLoadingDbs(true);
    void (async () => {
      try {
        // openSession idempotent phía main (SessionManager trả lại adapter đang có).
        await window.api.openSession(targetConnId);
        const nodes = await window.api.getRootNodes(targetConnId);
        if (cancelled) return;
        setDbOptions(
          nodes
            .map((n) => (n.meta?.database ?? n.meta?.schema) as string | undefined)
            .filter((v): v is string => Boolean(v)),
        );
      } catch (err) {
        if (cancelled) return;
        message.error(`Không nạp được danh sách ${dbLabel.toLowerCase()}: ${(err as Error).message}`);
        setDbOptions([]);
      } finally {
        if (!cancelled) setLoadingDbs(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // dbLabel chỉ dùng cho thông báo lỗi, không cần nạp lại khi nó đổi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetConnId, showTargets]);

  /** Đích chạy query, diễn giải theo mô hình của loại DB đang nhắm tới. */
  const queryTarget = useMemo<QueryTarget | undefined>(() => {
    if (!showTargets || !targetDb) return undefined;
    return targetKind === 'postgres' ? { schema: targetDb } : { database: targetDb };
  }, [showTargets, targetDb, targetKind]);

  // Nạp schema cho autocomplete theo ĐÍCH đã chọn, không theo prop từ sidebar — để gợi ý
  // và thực thi luôn dùng chung một nguồn sự thật.
  useEffect(() => {
    if (language !== 'sql') return;
    let cancelled = false;
    window.api
      .getSchemaObjects(targetConnId, queryTarget?.database, queryTarget?.schema)
      .then((objs) => {
        if (!cancelled) setActiveSchema(objs);
      })
      .catch(() => {
        /* mất autocomplete không chặn gõ query */
      });
    return () => {
      cancelled = true;
      clearActiveSchema();
    };
  }, [targetConnId, queryTarget, language]);

  const run = async () => {
    const query = editorRef.current?.getValue() ?? '';
    if (!query.trim()) return;
    setRunning(true);
    try {
      const res = await window.api.executeQuery(targetConnId, query, queryTarget);
      setResult(res);
    } catch (err) {
      message.error((err as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const exportResult = async (format: 'csv' | 'json') => {
    const rs = result?.rowSet;
    if (!rs) return;
    const content = format === 'csv' ? rowSetToCsv(rs) : JSON.stringify(rs.rows, null, 2);
    try {
      const res = await window.api.saveTextFile(`query-result.${format}`, content);
      if (!res.cancelled) message.success(`Đã lưu → ${res.path}`);
    } catch (err) {
      message.error(`Lưu thất bại: ${(err as Error).message}`);
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
          {showTargets && (
            <>
              <Select
                size="small"
                showSearch
                style={{ width: 200 }}
                value={targetConnId}
                onChange={changeHost}
                optionFilterProp="label"
                options={hostOptions.map((c) => ({
                  value: c.id,
                  label: `${c.name} (${c.host}:${c.port})`,
                }))}
              />
              <Select
                size="small"
                allowClear
                showSearch
                style={{ width: 180 }}
                placeholder={dbLabel}
                loading={loadingDbs}
                disabled={loadingDbs || dbOptions.length === 0}
                value={targetDb}
                onChange={(v?: string) => setTargetDb(v)}
                options={dbOptions.map((d) => ({ value: d, label: d }))}
              />
            </>
          )}
          <Button type="primary" icon={<CaretRightOutlined />} loading={running} onClick={run}>
            Chạy
          </Button>
          {result?.rowSet && (
            <Dropdown
              menu={{
                items: [
                  { key: 'csv', label: 'CSV' },
                  { key: 'json', label: 'JSON' },
                ],
                onClick: ({ key }) => void exportResult(key as 'csv' | 'json'),
              }}
            >
              <Button size="small" icon={<DownloadOutlined />}>
                Xuất kết quả
              </Button>
            </Dropdown>
          )}
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
