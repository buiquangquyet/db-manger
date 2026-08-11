import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { Button, Checkbox, Dropdown, Modal, Select, Space, Table, Tabs, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CaretRightOutlined, DownloadOutlined } from '@ant-design/icons';
import { monaco } from '../monaco-setup';
import { setActiveSchema, clearActiveSchema } from '../sql-completion';
import type { QueryHistoryEntry, QueryResult, QueryTarget, RowSet, StoredConnection } from '@shared/types';

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
  const [history, setHistory] = useState<QueryHistoryEntry[]>([]);
  const [onlyThisConn, setOnlyThisConn] = useState(true);
  const [bottomTab, setBottomTab] = useState<'result' | 'history'>('result');

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await window.api.listQueryHistory());
    } catch (err) {
      message.error(`Không đọc được lịch sử: ${(err as Error).message}`);
    }
  }, []);

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

  // Nạp lịch sử khi mount, để tab Lịch sử có dữ liệu ngay cả khi chưa chạy query nào.
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

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
      // Nạp lại lịch sử sau MỌI lần chạy (cả lỗi) để tab Lịch sử luôn khớp với file lưu ở
      // main — bắt buộc phải ở đây, không ở nhánh try/catch, để không bị bỏ sót khi rewrite
      // run() cho tính năng hủy query (queryId, chọn vùng chạy...).
      void loadHistory();
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

  const visibleHistory = useMemo(
    () => (onlyThisConn ? history.filter((h) => h.connectionId === targetConnId) : history),
    [history, onlyThisConn, targetConnId],
  );

  const historyCols: ColumnsType<QueryHistoryEntry> = [
    {
      title: 'Lúc',
      dataIndex: 'startedAt',
      width: 150,
      render: (t: number) => new Date(t).toLocaleString('vi-VN'),
    },
    {
      title: 'Trạng thái',
      dataIndex: 'status',
      width: 100,
      render: (s: QueryHistoryEntry['status']) => (
        <Tag color={s === 'ok' ? 'green' : 'red'}>{s === 'ok' ? 'OK' : 'Lỗi'}</Tag>
      ),
    },
    { title: 'ms', dataIndex: 'durationMs', width: 80, align: 'right', render: (v: number) => v.toFixed(0) },
    { title: 'Dòng', dataIndex: 'rowCount', width: 80, align: 'right', render: (v?: number) => v ?? '—' },
    ...(onlyThisConn
      ? []
      : [
          {
            title: 'Kết nối',
            dataIndex: 'connectionId',
            width: 160,
            render: (id: string) => connections.find((c) => c.id === id)?.name ?? id,
          } as ColumnsType<QueryHistoryEntry>[number],
        ]),
    { title: 'SQL', dataIndex: 'sql', ellipsis: true },
  ];

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
      <div className="grid-wrap">
        <Tabs
          style={{ height: '100%' }}
          className="full-height-tabs"
          activeKey={bottomTab}
          onChange={(k) => setBottomTab(k as 'result' | 'history')}
          items={[
            {
              key: 'result',
              label: 'Kết quả',
              children: (
                <div className="ag-theme-quartz" style={{ height: '100%' }}>
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
              ),
            },
            {
              key: 'history',
              label: 'Lịch sử',
              children: (
                <div style={{ height: '100%', overflow: 'auto', padding: 8 }}>
                  <Space style={{ marginBottom: 8 }}>
                    <Checkbox checked={onlyThisConn} onChange={(e) => setOnlyThisConn(e.target.checked)}>
                      Chỉ kết nối này
                    </Checkbox>
                    <Button
                      size="small"
                      danger
                      onClick={() =>
                        Modal.confirm({
                          title: 'Xóa toàn bộ lịch sử query?',
                          content: 'Không thể hoàn tác.',
                          okText: 'Xóa',
                          okType: 'danger',
                          cancelText: 'Hủy',
                          onOk: async () => {
                            await window.api.clearQueryHistory();
                            await loadHistory();
                          },
                        })
                      }
                    >
                      Xóa lịch sử
                    </Button>
                  </Space>
                  <Table<QueryHistoryEntry>
                    size="small"
                    rowKey="id"
                    pagination={false}
                    columns={historyCols}
                    dataSource={visibleHistory}
                    locale={{ emptyText: 'Chưa có query nào' }}
                    onRow={(r) => ({
                      style: { cursor: 'pointer' },
                      onClick: () => {
                        editorRef.current?.setValue(r.sql);
                        setBottomTab('result');
                      },
                    })}
                  />
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
