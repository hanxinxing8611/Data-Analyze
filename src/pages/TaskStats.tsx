import { useEffect, useMemo, useState } from 'react';
import { useData } from '../store/DataContext';
import { useCriteria } from '../store/CriteriaContext';
import { querySchedules, querySamples, queryBatches } from '../database/db';
import { fetchCloudTaskStats, computeTaskStats, type CloudTaskStat } from '../utils/cloudTaskStats';
import { Card, Badge, Loading, PageHeader, EmptyState } from '../components/ui';
import type { ScheduleItem, SampleRecord, BatchSummary } from '../types';

/* ========== 页面组件 ========== */

export default function TaskStats() {
  const { dbReady, version } = useData();
  const { thresholds } = useCriteria();
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [samples, setSamples] = useState<SampleRecord[]>([]);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [cloudStats, setCloudStats] = useState<CloudTaskStat[] | null>(null);
  const [fromCloud, setFromCloud] = useState(false);

  useEffect(() => {
    if (!dbReady) return;
    setSchedules(querySchedules());
    setSamples(querySamples());
    setBatches(queryBatches());
  }, [dbReady, version]);

  /* 拉取云端任务统计（优先使用云端预计算数据） */
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const cloud = await fetchCloudTaskStats();
        if (!cancelled && cloud && cloud.length > 0) {
          setCloudStats(cloud);
          setFromCloud(true);
        }
      } catch {
        // 云端无数据，回退本地计算
      }
    })();
    return () => { cancelled = true; };
  }, [dbReady]);

  /* 统计数据：优先云端，本地计算为回退 */
  const stats = useMemo(() => {
    if (fromCloud && cloudStats && cloudStats.length > 0) return cloudStats;
    return computeTaskStats(schedules, samples, thresholds);
  }, [fromCloud, cloudStats, schedules, samples, thresholds]);

  if (!dbReady) return <Loading text="数据库初始化中…" />;

  if (stats.length === 0) {
    return (
      <div>
        <PageHeader title="任务统计" description="工程师工作效率、质量、执行力与负荷统计" />
        <Card>
          <EmptyState
            icon="chart"
            title="暂无统计数据"
            description="请先在「验证计划」页添加验证计划条目，然后再回来查看统计"
          />
        </Card>
      </div>
    );
  }

  /* 进度条色阶 */
  function progressColor(ratio: number): string {
    if (ratio >= 0.8) return 'bg-emerald-500';
    if (ratio >= 0.5) return 'bg-amber-500';
    return 'bg-red-500';
  }

  return (
    <div>
      <PageHeader
        title="任务统计"
        description="工程师工作效率、质量、执行力与负荷统计"
      />
      {fromCloud && (
        <div className="-mt-4 mb-4">
          <Badge tone="blue">云端数据</Badge>
        </div>
      )}

      {/* 总览卡片（内容居中，数字 Arial 36px） */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-blue-100 bg-blue-50/50" bodyClassName="py-4 text-center">
          <div className="text-xs text-slate-500">工程师总数</div>
          <div
            className="mt-1 font-bold text-slate-900"
            style={{ fontFamily: 'Arial, "Helvetica Neue", sans-serif', fontSize: '36px', lineHeight: 1.2 }}
          >
            {stats.length}
          </div>
        </Card>
        <Card className="border-emerald-100 bg-emerald-50/50" bodyClassName="py-4 text-center">
          <div className="text-xs text-slate-500">验证批次总数</div>
          <div
            className="mt-1 font-bold text-slate-900"
            style={{ fontFamily: 'Arial, "Helvetica Neue", sans-serif', fontSize: '36px', lineHeight: 1.2 }}
          >
            {new Set(schedules.map((s) => s.batch_id)).size}
          </div>
        </Card>
        <Card className="border-violet-100 bg-violet-50/50" bodyClassName="py-4 text-center">
          <div className="text-xs text-slate-500">验证计划总数</div>
          <div
            className="mt-1 font-bold text-slate-900"
            style={{ fontFamily: 'Arial, "Helvetica Neue", sans-serif', fontSize: '36px', lineHeight: 1.2 }}
          >
            {schedules.length}
          </div>
        </Card>
        <Card className="border-amber-100 bg-amber-50/50" bodyClassName="py-4 text-center">
          <div className="text-xs text-slate-500">总体完成率</div>
          <div
            className="mt-1 font-bold text-slate-900"
            style={{ fontFamily: 'Arial, "Helvetica Neue", sans-serif', fontSize: '36px', lineHeight: 1.2 }}
          >
            {schedules.length > 0
              ? ((schedules.filter((s) => s.status === 'completed').length / schedules.length) * 100).toFixed(0) + '%'
              : '—'}
          </div>
        </Card>
      </div>

      {/* 详细统计表 */}
      <Card title="工程师统计明细" bodyClassName="px-0 py-0">
        <div className="max-h-[600px] overflow-auto">
          <table className="data-table w-full">
            <thead className="sticky top-0 bg-slate-50">
              <tr>
                <th>工程师</th>
                <th>验证批次</th>
                <th>验证周期（工作日）</th>
                <th>PCE平均效率</th>
                <th>PCE中位效率</th>
                <th>PCE最高效率</th>
                <th>报告及时性</th>
                <th>逾期任务</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stats.map((st) => {
                const avgCycle = st.avgCycleDays != null ? st.avgCycleDays.toFixed(1) : '—';
                const cycleStd = st.cycleStd;

                const avgPce = st.avgPce != null ? st.avgPce.toFixed(2) : '—';
                const medPce = st.medPce != null ? st.medPce.toFixed(2) : '—';
                const maxPce = st.maxPce != null ? st.maxPce.toFixed(2) : '—';

                const completeRate =
                  st.totalTasks > 0
                    ? (st.completedTasks / st.totalTasks) * 100
                    : 0;

                return (
                  <tr key={st.name}>
                    {/* 工程师 */}
                    <td>
                      <div className="font-medium text-slate-900">{st.name}</div>
                      {st.email && (
                        <div className="text-xs text-slate-400">{st.email}</div>
                      )}
                    </td>

                    {/* 验证批次数量（工作负荷） */}
                    <td className="text-center">
                      <span className="font-mono text-lg font-semibold text-slate-800">
                        {st.batchCount}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">个</span>
                      {st.batchCount >= 5 && (
                        <Badge tone="red">高负荷</Badge>
                      )}
                    </td>

                    {/* 验证周期（工作效率） */}
                    <td className="text-center">
                      <span className="font-mono text-sm font-semibold text-slate-800">
                        {avgCycle}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">天</span>
                      {cycleStd != null && cycleStd > 0 && (
                        <div className="text-[10px] text-slate-400">
                          波动 ±{cycleStd.toFixed(1)} 天
                        </div>
                      )}
                    </td>

                    {/* PCE平均效率（工作质量） */}
                    <td className="text-center">
                      <span className="font-mono text-sm font-semibold text-slate-800">
                        {avgPce}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">%</span>
                      {typeof avgPce === 'string' && avgPce !== '—' && (
                        <Badge
                          tone={
                            parseFloat(avgPce) >= 20
                              ? 'green'
                              : parseFloat(avgPce) >= 15
                                ? 'blue'
                                : 'amber'
                          }
                        >
                          {parseFloat(avgPce) >= 20
                            ? '优秀'
                            : parseFloat(avgPce) >= 15
                              ? '良好'
                              : '一般'}
                        </Badge>
                      )}
                    </td>

                    {/* PCE中位效率 */}
                    <td className="text-center">
                      <span className="font-mono text-sm text-slate-700">
                        {medPce}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">%</span>
                    </td>

                    {/* PCE最高效率 */}
                    <td className="text-center">
                      <span className="font-mono text-sm text-slate-700">
                        {maxPce}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">%</span>
                    </td>

                    {/* 报告及时性（执行力） */}
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full rounded-full transition-all ${progressColor(completeRate / 100)}`}
                            style={{ width: `${completeRate}%` }}
                          />
                        </div>
                        <span className="font-mono text-xs font-medium text-slate-600">
                          {st.completedTasks}/{st.totalTasks}
                        </span>
                        <span className="text-xs text-slate-400">
                          ({completeRate.toFixed(0)}%)
                        </span>
                      </div>
                    </td>

                    {/* 逾期任务 */}
                    <td className="text-center">
                      {st.overdueTasks > 0 ? (
                        <Badge tone="red">{st.overdueTasks} 项逾期</Badge>
                      ) : (
                        <span className="text-xs text-slate-400">无逾期</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-slate-100 px-5 py-2.5">
          <p className="text-[11px] leading-relaxed text-slate-400">
            <strong>验证周期</strong>：验证计划开始至报告截止的工作日天数（平均值），反映工作效率；
            <strong>PCE平均效率</strong>：该工程师负责批次中所有有效器件的PCE均值，反映工作质量（口径与「报告生成」页一致）；
            <strong>报告及时性</strong>：已完成任务占比，反映执行力；
            <strong>验证批次</strong>：该工程师负责的验证批次数量，≥5个标记为高负荷。
          </p>
        </div>
      </Card>

      {/* 效率分布图 */}
      {stats.length > 0 && (
        <Card title="效率对比" className="mt-4" bodyClassName="pb-2">
          <div className="space-y-3">
            {stats
              .filter((st) => st.avgPce != null)
              .map((st) => {
                const avgPce = st.avgPce!;
                const maxBarWidth = 80;
                const barPct = Math.min((avgPce / 25) * 100, maxBarWidth);
                return (
                  <div key={st.name} className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-right text-sm font-medium text-slate-700">
                      {st.name}
                    </span>
                    <div className="flex-1">
                      <div className="flex h-5 items-center rounded-full bg-slate-100">
                        <div
                          className="flex h-full items-center justify-end rounded-full bg-gradient-to-r from-blue-500 to-emerald-500 px-2"
                          style={{ width: `${barPct}%`, minWidth: barPct > 0 ? '40px' : '0' }}
                        >
                          <span className="text-xs font-semibold text-white">
                            {avgPce.toFixed(2)}%
                          </span>
                        </div>
                      </div>
                    </div>
                    <span className="w-12 text-right text-xs text-slate-400">
                      {st.pceDeviceCount} 器件
                    </span>
                  </div>
                );
              })}
          </div>
          <div className="mt-3 border-t border-slate-50 pt-3 text-center text-[10px] text-slate-400">
            仅统计有效器件（PCE≥15% / FF≥0.5 / Rs&gt;0 / Rsh&gt;0），基准线 20% PCE
          </div>
        </Card>
      )}
    </div>
  );
}