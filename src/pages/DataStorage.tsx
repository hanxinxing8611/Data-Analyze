import { useRef, useState } from 'react';
import { useData } from '../store/DataContext';
import { queryDashboardStats, resetDB } from '../database/db';
import {
  exportDatabaseBackup,
  importDatabaseBackup,
} from '../database/backup';
import { Button, Card } from '../components/ui';

/* ================= 数据库备份卡片 ================= */

function BackupCard() {
  const { refresh } = useData();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const summarize = (s: {
    material_batch: number;
    sample_record: number;
    iv_curve_data: number;
    report_metadata: number;
    schedule: number;
  }) =>
    `${s.material_batch} 批次 / ${s.sample_record} 样本 / ${s.iv_curve_data} 曲线点 / ${s.report_metadata} 报告模板 / ${s.schedule} 验证计划`;

  const handleExport = async () => {
    setBusy('export');
    setMsg(null);
    try {
      const summary = await exportDatabaseBackup();
      refresh();
      setMsg({ tone: 'success', text: `备份已导出：${summarize(summary)}` });
    } catch (e) {
      setMsg({ tone: 'error', text: `导出失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const handleFile = async (file: File) => {
    const stats = queryDashboardStats();
    const ok = window.confirm(
      `将使用「${file.name}」替换当前全部数据\n` +
        `（当前：${stats.totalBatches} 批次 / ${stats.totalSamples} 样本）。\n` +
        '此操作会先清空现有数据再导入备份，确定继续吗？',
    );
    if (!ok) return;
    setBusy('import');
    setMsg(null);
    try {
      const summary = await importDatabaseBackup(file);
      refresh();
      setMsg({ tone: 'success', text: `备份已导入：${summarize(summary)}` });
    } catch (e) {
      setMsg({
        tone: 'error',
        text: `导入失败（数据未改动）：${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Card
      title="数据库备份"
      extra={<span className="text-[11px] text-slate-400">Excel 工作簿（.xlsx）</span>}
    >
      <div className="space-y-4">
        <p className="text-sm leading-6 text-slate-600">
          导出全部数据（材料批次、样本记录、IV 曲线、报告文字模板）为 Excel 工作簿，
          可用于定期备份或将数据迁移到其他设备；导入时会替换当前全部数据。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleExport} disabled={busy !== null}>
            {busy === 'export' ? '导出中…' : '导出备份'}
          </Button>
          <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
            {busy === 'import' ? '导入中…' : '导入备份'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
          {msg && (
            <span className={`text-xs ${msg.tone === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
              {msg.text}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-400">
          注意：仅支持本系统导出的 .xlsx 备份；旧版 .xls 文件请先用 Excel 另存为 .xlsx 再导入。
        </p>
      </div>
    </Card>
  );
}

/* ================= 数据存储区块（嵌入数据总览页底部） ================= */

/** 数据存储区块：数据库说明、备份导入导出与数据清空（工程师可直接操作，数据仅存本地） */
export default function StorageSection() {
  const { refresh } = useData();
  const [cleared, setCleared] = useState(false);

  const handleReset = async () => {
    if (!window.confirm('确认清空全部数据？所有批次、样本与曲线数据将被删除，此操作不可撤销。')) {
      return;
    }
    await resetDB();
    refresh();
    setCleared(true);
    setTimeout(() => setCleared(false), 3000);
  };

  return (
    <div className="space-y-6">
      <Card title="存储说明">
        <div className="space-y-3 text-sm text-slate-600">
          <p>
            数据以 SQLite 格式存储于浏览器 IndexedDB 中，全部在本地运行，不会上传到任何服务器。
            每次数据变更后自动保存，关闭页面不会丢失数据。
          </p>
          <p className="text-xs text-slate-400">
            注意：清除浏览器站点数据（Cookie / 站点数据）会同时删除已导入的数据库，请定期「导出备份」妥善保存。
          </p>
        </div>
      </Card>

      <BackupCard />

      <Card title="危险操作">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-700">清空全部数据</p>
            <p className="mt-0.5 text-xs text-slate-400">
              删除所有材料批次、样本记录与 IV 曲线数据，数据库结构保留
            </p>
          </div>
          <Button variant="danger" onClick={handleReset}>
            {cleared ? '已清空' : '清空数据'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
