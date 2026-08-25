import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../store/DataContext';
import { useCriteria } from '../store/CriteriaContext';
import { queryBatches, queryDashboardStats, querySamples, querySchedules } from '../database/db';
import { fmt, median } from '../utils/statistics';
import { isValidDevice, metricValue } from '../report/reportData';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, StatCard } from '../components/ui';
import type { BatchSummary, SampleRecord, ScheduleItem } from '../types';

/* ---- 弹窗提醒 ---- */

function ReminderModal({
  items,
  onClose,
}: {
  items: ScheduleItem[];
  onClose: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 mx-4 w-full max-w-lg rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between rounded-t-xl border-b border-slate-100 bg-amber-50 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-2.5 w-2.5 rounded-full bg-amber-500" />
            <span className="text-base font-semibold text-amber-900">
              验证报告提交提醒
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ×
          </button>
        </div>
        <div className="max-h-[420px] overflow-auto px-5 py-4">
          <p className="mb-3 text-sm text-slate-600">
            以下 {items.length} 项验证报告已到期或即将到期，请及时提交：
          </p>
          <div className="space-y-2.5">
            {items.map((it) => {
              const overdue = it.report_deadline < today;
              return (
                <div
                  key={it.id}
                  className={`rounded-lg border px-3.5 py-2.5 ${
                    overdue ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-900">
                        {it.batch_id}
                      </span>
                      <span className="text-xs text-slate-500">{it.material_type}</span>
                    </div>
                    <Badge tone={overdue ? 'red' : 'amber'}>
                      {overdue ? '逾期' : '今日到期'}
                    </Badge>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                    <span>负责人：{it.engineer_name}</span>
                    <span>截止：{it.report_deadline}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex items-center justify-between rounded-b-xl border-t border-slate-100 bg-slate-50 px-5 py-3">
          <span className="text-xs text-slate-400">
            本提醒由验证计划系统自动生成
          </span>
          <Link to="/schedule">
            <Button variant="secondary">前往验证计划</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { dbReady, version } = useData();
  const { thresholds } = useCriteria();
  const [stats, setStats] = useState<ReturnType<typeof queryDashboardStats> | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [records, setRecords] = useState<SampleRecord[]>([]);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [showReminder, setShowReminder] = useState(false);

  useEffect(() => {
    if (!dbReady) return;
    setStats(queryDashboardStats());
    setBatches(queryBatches());
    setRecords(querySamples());
    setSchedules(querySchedules());
  }, [dbReady, version]);

  /* 各批次关键指标（PCE 冠军/中位、Voc*FF 平均），基于有效测试记录随口径实时重算，与报告页口径一致 */
  const batchMetrics = useMemo(() => {
    const m = new Map<
      string,
      { champion: number | null; medianPce: number | null; vocffMean: number | null }
    >();
    for (const b of batches) {
      const valid = records.filter((r) => r.batch_id === b.batch_id && isValidDevice(r, thresholds));
      const effs = valid.map((r) => r.efficiency).filter((v): v is number => v != null);
      const vocffs = valid
        .map((r) => metricValue(r, 'vocff'))
        .filter((v) => !isNaN(v));
      m.set(b.batch_id, {
        champion: effs.length > 0 ? Math.max(...effs) : null,
        medianPce: effs.length > 0 ? median(effs) : null,
        vocffMean: vocffs.length > 0 ? vocffs.reduce((a, c) => a + c, 0) / vocffs.length : null,
      });
    }
    return m;
  }, [batches, records, thresholds]);

  /* 验证计划到期/逾期提醒 */
  const dueSchedules = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return schedules.filter((s) => s.status !== 'completed' && s.report_deadline <= today);
  }, [schedules]);

  /* 页面加载时自动弹出提醒 */
  useEffect(() => {
    if (dbReady && dueSchedules.length > 0) {
      setShowReminder(true);
    }
  }, [dbReady, dueSchedules.length]);

  if (!dbReady || !stats) return <Loading text="数据库初始化中…" />;

  const hasData = stats.totalSamples > 0;

  return (
    <div>
      {/* 弹窗提醒 */}
      {showReminder && dueSchedules.length > 0 && (
        <ReminderModal items={dueSchedules} onClose={() => setShowReminder(false)} />
      )}

      <PageHeader
        title="数据总览"
        description="器件验证数据概况与快捷入口"
        actions={
          <>
            <Link to="/data">
              <Button variant="secondary">导入数据</Button>
            </Link>
            <Link to="/comparison">
              <Button>对比分析</Button>
            </Link>
          </>
        }
      />

      {/* 验证计划到期提醒横幅 */}
      {dueSchedules.length > 0 && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 rounded-full bg-amber-500" />
            <span className="text-sm font-medium text-amber-800">
              {dueSchedules.length} 项器件验证报告到期/逾期
            </span>
            <span className="text-xs text-amber-600">
              {dueSchedules.map((s) => `${s.batch_id}（${s.engineer_name}）`).join('、')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setShowReminder(true)}>
              查看提醒
            </Button>
            <Link to="/schedule">
              <Button variant="secondary">查看验证计划</Button>
            </Link>
          </div>
        </div>
      )}

      {!hasData ? (
        <Card>
          <EmptyState
            icon="database"
            title="暂无数据"
            description="请先导入 IV 测试导出的 TXT 源文件，系统将自动解析样本参数、识别材料批次并入库"
            action={
              <Link to="/data">
                <Button>
                  <span>前往导入</span>
                </Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {/* 统计卡片 */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="样本总数" value={String(stats.totalSamples)} unit="条" />
            <StatCard label="材料批次" value={String(stats.totalBatches)} unit="个" />
            <StatCard
              label="平均效率"
              value={fmt(stats.avgEfficiency, 2)}
              unit="%"
              hint="全部样本平均"
            />
            <StatCard
              label="最高效率"
              value={fmt(stats.maxEfficiency, 2)}
              unit="%"
              hint="全部样本最优"
            />
          </div>

          {/* 批次概览 */}
          <Card title="批次概览" className="mt-6" bodyClassName="px-0 py-0">
            <div className="max-h-[520px] overflow-auto">
              <table className="data-table w-full">
                <thead className="sticky top-0 bg-slate-50">
                  <tr>
                    <th>批次</th>
                    <th>材料类型</th>
                    <th>样本数</th>
                    <th>正扫 / 反扫</th>
                    <th>PCE冠军 (%)</th>
                    <th>PCE中位 (%)</th>
                    <th>VOC*FF平均 (V)</th>
                    <th>最近测试日期</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {batches.map((b) => {
                    const m = batchMetrics.get(b.batch_id);
                    return (
                      <tr key={b.batch_id}>
                        <td className="font-mono font-medium text-slate-900">{b.batch_id}</td>
                        <td>{b.material_type}</td>
                        <td className="font-mono">{b.sample_count}</td>
                        <td>
                          <span className="font-mono text-slate-500">
                            {b.forward_count} / {b.reverse_count}
                          </span>
                        </td>
                        <td className="font-mono">
                          <Badge tone="green">{fmt(m?.champion ?? NaN)}</Badge>
                        </td>
                        <td className="font-mono">{fmt(m?.medianPce ?? NaN)}</td>
                        <td className="font-mono">{fmt(m?.vocffMean ?? NaN, 3)}</td>
                        <td className="text-slate-500">{b.last_test_date || '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="border-t border-slate-100 px-5 py-2.5 text-[11px] text-slate-400">
              PCE冠军 / PCE中位 / VOC*FF平均 均基于各批次有效测试记录统计（口径可在「报告生成」页调整）
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
