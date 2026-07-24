import { useEffect, useMemo, useState } from 'react';
import { Checkbox, Modal, Progress, Radio, Select, Steps, Table, message } from 'antd';
import type { DbKind, StoredConnection, TransferProgress, TransferSummary } from '@shared/types';

export interface TransferSource {
  connectionId: string;
  kind: DbKind;
  database?: string;
  schema?: string;
  label: string;
}

interface Props {
  open: boolean;
  source: TransferSource;
  connections: StoredConnection[];
  onClose: () => void;
}

/** Wizard 3 bước: chọn đích → chọn bảng & tùy chọn → tiến trình. */
export function TransferModal({ open, source, connections, onClose }: Props): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [destConnId, setDestConnId] = useState<string>();
  const [destDb, setDestDb] = useState<string>();
  const [dbOptions, setDbOptions] = useState<
    { id: string; database?: string; schema?: string; label: string }[]
  >([]);
  const [tables, setTables] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [createStructure, setCreateStructure] = useState(true);
  const [writeMode, setWriteMode] = useState<'append' | 'truncateInsert'>('append');
  const [transferId] = useState(() => `tf_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [summary, setSummary] = useState<TransferSummary | null>(null);
  const [running, setRunning] = useState(false);

  // Chỉ cho chọn connection cùng loại.
  const destConns = useMemo(
    () => connections.filter((c) => c.kind === source.kind),
    [connections, source.kind],
  );

  // Danh sách bảng nguồn.
  useEffect(() => {
    if (!open) return;
    window.api
      .getTableList(source.connectionId, source.database, source.schema)
      .then((list) => setTables(list.map((t) => t.name)))
      .catch((e) => message.error(`Không tải được danh sách bảng: ${(e as Error).message}`));
  }, [open, source]);

  // Khi chọn connection đích: mở session & tải danh sách database/schema đích.
  async function pickDest(id: string): Promise<void> {
    setDestConnId(id);
    setDestDb(undefined);
    try {
      await window.api.openSession(id);
      const roots = await window.api.getRootNodes(id);
      // node database/schema có meta.database / meta.schema
      const opts = roots
        .filter((n) => n.type === 'database' || n.type === 'schema')
        .map((n, index) => {
          const database = (n.meta?.database as string) ?? n.label;
          const schema = n.meta?.schema as string | undefined;
          return { id: `${database ?? ''}::${schema ?? ''}::${index}`, database, schema, label: n.label };
        });
      setDbOptions(opts);
    } catch (e) {
      message.error(`Không mở được kết nối đích: ${(e as Error).message}`);
    }
  }

  async function runTransfer(): Promise<void> {
    if (!destConnId) return;
    const dest = dbOptions.find((o) => o.id === destDb);
    setStep(2);
    setRunning(true);
    setSummary(null);
    const off = window.api.onTransferProgress((p) => {
      if (p.transferId === transferId) setProgress(p);
    });
    try {
      const res = await window.api.startTransfer({
        transferId,
        sourceConnectionId: source.connectionId,
        source: { database: source.database, schema: source.schema },
        destConnectionId: destConnId,
        dest: { database: dest?.database, schema: dest?.schema },
        tables: selected,
        createStructure,
        writeMode,
      });
      setSummary(res);
    } catch (e) {
      message.error(`Transfer lỗi: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      off();
    }
  }

  function start(): void {
    if (!destConnId) return;
    if (writeMode === 'truncateInsert') {
      Modal.confirm({
        title: 'Xóa sạch dữ liệu các bảng đích rồi nạp lại?',
        content: 'Toàn bộ dữ liệu hiện có trong các bảng đích đã chọn sẽ bị xóa trước khi nạp dữ liệu mới. Không thể hoàn tác.',
        okText: 'Xóa & nạp',
        okType: 'danger',
        cancelText: 'Hủy',
        onOk: () => runTransfer(),
      });
      return;
    }
    void runTransfer();
  }

  const pct = summary ? 100 : progress && progress.tableCount ? Math.round((progress.tableIndex / progress.tableCount) * 100) : 0;

  return (
    <Modal
      open={open}
      title={`Transfer từ "${source.label}"`}
      onCancel={onClose}
      width={640}
      footer={null}
      destroyOnClose
      closable={!running}
      maskClosable={!running}
      keyboard={!running}
    >
      <Steps current={step} size="small" style={{ marginBottom: 16 }} items={[{ title: 'Chọn đích' }, { title: 'Chọn bảng' }, { title: 'Tiến trình' }]} />

      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Select
            placeholder="Kết nối đích (cùng loại)"
            value={destConnId}
            onChange={pickDest}
            options={destConns.map((c) => ({ value: c.id, label: `${c.name} (${c.kind})` }))}
          />
          <Select
            placeholder="Database/schema đích"
            value={destDb}
            disabled={!destConnId}
            onChange={setDestDb}
            options={dbOptions.map((o) => ({ value: o.id, label: o.label }))}
          />
          <div style={{ textAlign: 'right' }}>
            <a onClick={() => destConnId && destDb && setStep(1)}>Tiếp →</a>
          </div>
        </div>
      )}

      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Checkbox
            indeterminate={selected.length > 0 && selected.length < tables.length}
            checked={selected.length === tables.length && tables.length > 0}
            onChange={(e) => setSelected(e.target.checked ? [...tables] : [])}
          >
            Chọn tất cả ({tables.length})
          </Checkbox>
          <Checkbox.Group
            style={{ display: 'flex', flexDirection: 'column', maxHeight: 220, overflow: 'auto' }}
            value={selected}
            onChange={(v) => setSelected(v as string[])}
            options={tables.map((t) => ({ label: t, value: t }))}
          />
          <Checkbox checked={createStructure} onChange={(e) => setCreateStructure(e.target.checked)}>
            Tạo cấu trúc nếu bảng đích chưa có
          </Checkbox>
          <Radio.Group value={writeMode} onChange={(e) => setWriteMode(e.target.value)}>
            <Radio value="append">Thêm vào (append)</Radio>
            <Radio value="truncateInsert">Xóa sạch rồi nạp (truncate + insert)</Radio>
          </Radio.Group>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <a onClick={() => setStep(0)}>← Quay lại</a>
            <a onClick={() => selected.length && start()}>Bắt đầu transfer →</a>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Progress percent={pct} />
          {running && progress && (
            <div>
              Đang copy <b>{progress.currentTable}</b> ({progress.tableIndex + 1}/{progress.tableCount}) — {progress.rowsCopied} dòng
            </div>
          )}
          {running && (
            <div>
              <a onClick={() => window.api.cancelTransfer(transferId)}>Hủy</a>
            </div>
          )}
          {summary && (
            <Table
              size="small"
              pagination={false}
              rowKey="table"
              dataSource={summary.results}
              columns={[
                { title: 'Bảng', dataIndex: 'table' },
                { title: 'Trạng thái', dataIndex: 'status' },
                { title: 'Số dòng', dataIndex: 'rows' },
                { title: 'Lỗi', dataIndex: 'error' },
              ]}
            />
          )}
          {summary && (
            <div style={{ textAlign: 'right' }}>
              <a onClick={onClose}>Đóng</a>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
