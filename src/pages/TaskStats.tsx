import { useEffect, useMemo, useState } from 'react';
import { useData } from '../store/DataContext';
import { useCriteria } from '../store/CriteriaContext';
import { mergeSchedules } from '../database/db';
import { fetchCloudTaskStats, type CloudTaskStat } from '../utils/cloudTaskStats';
import { fetchCloudSchedule } from '../utils/cloudSchedule';
import { criteriaTextShort } from '../report/reportData';
import { Card, Badge, Loading, PageHeader, EmptyState } from '../components/ui';
import type { ScheduleItem } from '../types';

/* ========== 合并后的工程师统计行（schedule 实时计算 + taskStats 快照补充） ========== */

interface MergedStat {
  name: string;
  email: string;
  batchCount: number;          // 基于 schedule.json 实时计算
  totalTasks: number;           // 基于 schedule.json 实时计算
  completedTasks: number;       // 基于 schedule.json 实时计算
  overdueTasks: number;         // 基于 schedule.json 实时计算
  avgCycleDays: number | null;  // 基于 schedule.json 实时计算
  cycleStd: number | null;      // 基于 schedule.json 实时计算
  avgPce: number | null;        // 来自 taskStats.json 快照（需本地样本才能计算）
  medPce: number | null;        // 来自 taskStats.json 快照
  maxPce: number | null;        // 来自 taskStats.json 快照
  pceDeviceCount: number;       // 来自 taskStats.json 快照
  pceFromCloud: boolean;        // PCE 数据是否来自云端快照
}

/* ========== 工作日计算 ========== */

function isWeekend(date: Date): boolean {
  const d = date.getDay();
  return d === 0 || d === 6;
}

function workingDaysBetween(start: string, end: string): number {
  if (!start || !end) return 0;
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  let count = 0;
  const d = new Date(s);
  while (d <= e) {
    if (!isWeekend(d)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

/* ========== 页面组件 ========== */

export default function TaskStats() {
  const { dbReady } = useData();
  const { thresholds } = useCriteria();
  const [cloudStats, setCloudStats] = useState<CloudTaskStat[] | null>(null);
  const [cloudSchedules, setCloudSchedules] = useState<ScheduleItem[]>([]);
  const [loading, setLoading] = useState(true);

  /* 仅从云端拉取数据：schedule.json（工程师列表+计划数据）+ taskStats.json（PCE 快照） */
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [scheduleRes, statsRes] = await Promise.all([
          fetchCloudSchedule(),
          fetchCloudTaskStats(),
        ]);

        if (cancelled) return;

        if (scheduleRes && scheduleRes.length > 0) {
          setCloudSchedules(scheduleRes as ScheduleItem[]);
          try { await mergeSchedules(scheduleRes); } catch { /* 静默 */ }
        }

        if (statsRes && statsRes.length > 0) {
          setCloudStats(statsRes);
        }
      } catch {
        // 网络失败，静默
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbReady]);

  const today = new Date().toISOString().slice(0, 10);

  /* ---- 合并数据：schedule.json（工程师列表+非PCE指标）+ taskStats.json（PCE 快照） ---- */
  const mergedStats = useMemo((): MergedStat[] => {
    if (cloudSchedules.length === 0) return [];
    const cloudStatsMap = new Map<string, CloudTaskStat>();
    if (cloudStats) {
      for (const cs of cloudStats) {
        cloudStatsMap.set(cs.name, cs);
      }
    }

    // 从 schedule.json 提取工程师 → 聚合数据
    const engMap = new Map<string, {
      name: string;
      email: string;
      batchSet: Set<string>;
      totalTasks: number;
      completedTasks: number;
      overdueTasks: number;
      cycleDays: number[];
    }>();

    for (const s of cloudSchedules) {
      if (!engMap.has(s.engineer_name)) {
        engMap.set(s.engineer_name, {
          name: s.engineer_name,
          email: s.engineer_email || '',
          batchSet: new Set(),
          totalTasks: 0,
          completedTasks: 0,
          overdueTasks: 0,
          cycleDays: [],
        });
      }
      const e = engMap.get(s.engineer_name)!;
      e.totalTasks++;
      if (s.status === 'completed') e.completedTasks++;
      if (s.status !== 'completed' && s.report_deadline < today) e.overdueTasks++;
      e.batchSet.add(s.batch_id || String(s.id));
      const days = workingDaysBetween(s.start_date, s.report_deadline);
      if (days > 0) e.cycleDays.push(days);
    }

    return Array.from(engMap.values())
      .map((e) => {
        const cloud = cloudStatsMap.get(e.name);
        const avgCycle = e.cycleDays.length > 0
          ? parseFloat((e.cycleDays.reduce((a, b) => a + b, 0) / e.cycleDays.length).toFixed(1))
          : null;
        const cycleStd = e.cycleDays.length > 1
          ? parseFloat(Math.sqrt(
              e.cycleDays.reduce((sum, d) => sum + Math.pow(d - (e.cycleDays.reduce((a, b) => a + b, 0) / e.cycleDays.length), 2), 0) / e.cycleDays.length,
            ).toFixed(1))
          : null;

        return {
          name: e.name,
          email: e.email || (cloud?.email ?? ''),
          batchCount: e.batchSet.size,
          totalTasks: e.totalTasks,
          completedTasks: e.completedTasks,
          overdueTasks: e.overdueTasks,
          avgCycleDays: avgCycle,
          cycleStd,
          // PCE 数据优先用 taskStats.json 快照（有本地样本计算），否则置空
          avgPce: cloud?.avgPce ?? null,
          medPce: cloud?.medPce ?? null,
          maxPce: cloud?.maxPce ?? null,
          pceDeviceCount: cloud?.pceDeviceCount ?? 0,
          pceFromCloud: cloud != null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }, [cloudSchedules, cloudStats, today]);

  /* ---- 按周/按月切换 ---- */
  type ChartMode = 'week' | 'month';
  const [chartMode, setChartMode] = useState<ChartMode>('week');

  /* 各工程师按时段批次数（基于 cloudSchedules） */
  const periodChartData = useMemo(() => {
    if (cloudSchedules.length === 0) return null;
    try {
      const engineers = [...new Set(cloudSchedules.map((s) => s.engineer_name))].filter(Boolean).sort();
      if (engineers.length === 0) return null;

      function getPeriodKey(dateStr: string): { key: string; label: string } {
        if (!dateStr) return { key: '__unknown__', label: '—' };
        const d = new Date(dateStr + 'T00:00:00');
        if (Number.isNaN(d.getTime())) return { key: '__unknown__', label: '—' };
        if (chartMode === 'month') {
          return {
            key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
            label: `${d.getMonth() + 1}月`,
          };
        }
        const day = d.getDay();
        const monday = new Date(d);
        monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
        const startOfYear = new Date(monday.getFullYear(), 0, 1);
        const weekNum = Math.max(1, Math.ceil(
          ((monday.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7,
        ));
        return {
          key: `${monday.getFullYear()}-W${String(weekNum).padStart(2, '0')}`,
          label: `${monday.getMonth() + 1}/${monday.getDate()}`,
        };
      }

      const periodMap = new Map<string, { label: string; engineers: Map<string, Set<string>> }>();
      for (const s of cloudSchedules) {
        if (!s.start_date) continue;
        const { key, label } = getPeriodKey(s.start_date);
        if (!periodMap.has(key)) {
          periodMap.set(key, { label, engineers: new Map() });
        }
        const entry = periodMap.get(key)!;
        if (!entry.engineers.has(s.engineer_name)) {
          entry.engineers.set(s.engineer_name, new Set());
        }
        entry.engineers.get(s.engineer_name)!.add(s.batch_id || String(s.id));
      }

      const periods = [...periodMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, { label }]) => ({ key, label }));

      if (periods.length === 0) return null;

      const data = engineers.map((name) =>
        periods.map((p) => periodMap.get(p.key)?.engineers.get(name)?.size ?? 0),
      );

      return { engineers, periods, data };
    } catch (e) {
      console.warn('[TaskStats] periodChartData error:', e);
      return null;
    }
  }, [cloudSchedules, chartMode]);

  if (!dbReady || loading) return <Loading text="正在从云端拉取统计数据…" />;

  if (mergedStats.length === 0) {
    return (
      <div>
        <PageHeader title="任务统计" description="工程师工作效率、质量、执行力与负荷统计" />
        <Card>
          <EmptyState
            icon="chart"
            title="暂无统计数据"
            description="请先在「验证计划」页添加验证计划并同步到云端，然后再回来查看统计"
          />
        </Card>
      </div>
    );
  }

  /* 总览卡片数据 */
  const totalBatches = mergedStats.reduce((sum, s) => sum + s.batchCount, 0);
  const totalTasks = mergedStats.reduce((sum, s) => sum + s.totalTasks, 0);
  const totalCompleted = mergedStats.reduce((sum, s) => sum + s.completedTasks, 0);
  const completionRate = totalTasks > 0 ? (totalCompleted / totalTasks) * 100 : 0;

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
      <div className="-mt-4 mb-4">
        <Badge tone="blue">云端数据</Badge>
      </div>

      {/* 总览卡片 */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-blue-100 bg-blue-50/50" bodyClassName="py-4 text-center">
          <div className="text-xs text-slate-500">工程师总数</div>
          <div
            className="mt-1 font-bold text-slate-900"
            style={{ fontFamily: 'Arial, "Helvetica Neue", sans-serif', fontSize: '36px', lineHeight: 1.2 }}
          >
            {mergedStats.length}
          </div>
        </Card>
        <Card className="border-emerald-100 bg-emerald-50/50" bodyClassName="py-4 text-center">
          <div className="text-xs text-slate-500">验证批次总数</div>
          <div
            className="mt-1 font-bold text-slate-900"
            style={{ fontFamily: 'Arial, "Helvetica Neue", sans-serif', fontSize: '36px', lineHeight: 1.2 }}
          >
            {totalBatches}
          </div>
        </Card>
        <Card className="border-violet-100 bg-violet-50/50" bodyClassName="py-4 text-center">
          <div className="text-xs text-slate-500">验证计划总数</div>
          <div
            className="mt-1 font-bold text-slate-900"
            style={{ fontFamily: 'Arial, "Helvetica Neue", sans-serif', fontSize: '36px', lineHeight: 1.2 }}
          >
            {totalTasks}
          </div>
        </Card>
        <Card className="border-amber-100 bg-amber-50/50" bodyClassName="py-4 text-center">
          <div className="text-xs text-slate-500">总体完成率</div>
          <div
            className="mt-1 font-bold text-slate-900"
            style={{ fontFamily: 'Arial, "Helvetica Neue", sans-serif', fontSize: '36px', lineHeight: 1.2 }}
          >
            {totalTasks > 0 ? completionRate.toFixed(0) + '%' : '—'}
          </div>
        </Card>
      </div>

      {/* 工程师统计明细 */}
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
              {mergedStats.map((st) => {
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
                    <td>
                      <div className="font-medium text-slate-900">{st.name}</div>
                      {st.email && (
                        <div className="text-xs text-slate-400">{st.email}</div>
                      )}
                    </td>

                    <td className="text-center">
                      <span className="font-mono text-lg font-semibold text-slate-800">
                        {st.batchCount}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">个</span>
                      {st.batchCount >= 5 && (
                        <Badge tone="red">高负荷</Badge>
                      )}
                    </td>

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

                    <td className="text-center">
                      <span className="font-mono text-sm font-semibold text-slate-800">
                        {avgPce}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">%</span>
                      {typeof avgPce === 'string' && avgPce !== '—' && (
                        <Badge
                          tone={
                            parseFloat(avgPce) >= thresholds.pceMin + 5
                              ? 'green'
                              : parseFloat(avgPce) >= thresholds.pceMin
                                ? 'blue'
                                : 'amber'
                          }
                        >
                          {parseFloat(avgPce) >= thresholds.pceMin + 5
                            ? '优秀'
                            : parseFloat(avgPce) >= thresholds.pceMin
                              ? '良好'
                              : '一般'}
                        </Badge>
                      )}
                      {st.pceDeviceCount === 0 && st.batchCount > 0 && (
                        <div className="text-[10px] text-amber-500">待同步</div>
                      )}
                    </td>

                    <td className="text-center">
                      <span className="font-mono text-sm text-slate-700">
                        {medPce}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">%</span>
                    </td>

                    <td className="text-center">
                      <span className="font-mono text-sm text-slate-700">
                        {maxPce}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">%</span>
                    </td>

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
            <strong>PCE平均效率</strong>：该工程师负责批次中所有有效测试记录的PCE均值，反映工作质量（{criteriaTextShort(thresholds)}）；
            <strong>报告及时性</strong>：已完成任务占比，反映执行力；
            <strong>验证批次</strong>：该工程师负责的验证批次数量，≥5个标记为高负荷；
            <strong>待同步</strong>：表示该工程师的 PCE 效率数据尚未在云端 taskStats 快照中，需管理员在验证计划页同步。
          </p>
        </div>
      </Card>

      {/* 验证批次数对比（按周/按月） */}
      {periodChartData && periodChartData.periods.length > 0 && periodChartData.engineers.length > 0 && (() => {
        try {
          const { engineers, periods, data } = periodChartData;
          const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1', '#14B8A6', '#D946EF'];
          const MARGIN = { top: 30, right: 24, bottom: 60, left: 44 };
          const PLOT_H = 280;
          const engCount = Math.max(1, engineers.length);
          const periodCount = Math.max(1, periods.length);
          const PLOT_W = Math.max(600, engCount * Math.max(80, periodCount * 20 + 60));
          const CHART_W = PLOT_W + MARGIN.left + MARGIN.right;
          const CHART_H = PLOT_H + MARGIN.top + MARGIN.bottom;
          const flatVals = data.flat().map(Number).filter(v => Number.isFinite(v));
          const maxVal = flatVals.length > 0 ? Math.max(1, ...flatVals) : 1;
          const yMax = Math.ceil(maxVal * 1.15) || 5;
          const yTicks = yMax <= 5 ? yMax : Math.ceil(yMax / 2) * 2;
          const yTicksSafe = Math.max(1, Number.isFinite(yTicks) ? yTicks : 5);
          const groupW = PLOT_W / engCount;
          const barCount = periodCount;
          const barGap = 3;
          const barW = barCount > 0 ? Math.max(4, (groupW * 0.7 - barGap * (barCount - 1)) / barCount) : 8;
          if (!Number.isFinite(CHART_W) || !Number.isFinite(CHART_H)) return null;
          return (
            <Card title="验证批次数对比" className="mt-4" bodyClassName="pb-2">
              <div className="mb-3 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setChartMode('week')}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    chartMode === 'week' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  按周
                </button>
                <button
                  type="button"
                  onClick={() => setChartMode('month')}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    chartMode === 'month' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  按月
                </button>
              </div>

              <div className="overflow-auto scroll-shadow-x">
                <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width={CHART_W} height={CHART_H} style={{ minWidth: '100%' }} fontFamily="Arial, 'Microsoft YaHei', sans-serif">
                  {Array.from({ length: yTicksSafe + 1 }, (_, i) => {
                    const y = MARGIN.top + PLOT_H - (i / yTicksSafe) * PLOT_H;
                    return (
                      <g key={i}>
                        <line x1={MARGIN.left} y1={y} x2={MARGIN.left + PLOT_W} y2={y} stroke="#E2E8F0" strokeWidth={1} />
                        <text x={MARGIN.left - 6} y={y + 4} textAnchor="end" fill="#94A3B8" fontSize={11}>{i}</text>
                      </g>
                    );
                  })}
                  <line x1={MARGIN.left} y1={MARGIN.top + PLOT_H} x2={MARGIN.left + PLOT_W} y2={MARGIN.top + PLOT_H} stroke="#CBD5E1" strokeWidth={1} />

                  {engineers.map((eng, ei) => {
                    const gx = MARGIN.left + ei * groupW + groupW * 0.15;
                    return periods.map((p, pi) => {
                      const rawVal = data[ei]?.[pi];
                      const val = Number.isFinite(rawVal) ? (rawVal as number) : 0;
                      if (val === 0) return null;
                      const barH = (val / yTicksSafe) * PLOT_H;
                      const bx = gx + pi * (barW + barGap);
                      const by = MARGIN.top + PLOT_H - barH;
                      if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(barW) || !Number.isFinite(barH)) return null;
                      return (
                        <g key={`${eng}-${p.key}`}>
                          <rect x={bx} y={by} width={barW} height={barH} rx={2} fill={COLORS[pi % COLORS.length]} opacity={0.88} />
                          <text x={bx + barW / 2} y={by - 4} textAnchor="middle" fill="#475569" fontSize={10} fontWeight={600}>{val}</text>
                        </g>
                      );
                    });
                  })}

                  {engineers.map((eng, ei) => {
                    const cx = MARGIN.left + ei * groupW + groupW / 2;
                    return (
                      <text key={eng} x={cx} y={MARGIN.top + PLOT_H + 20} textAnchor="middle" fill="#334155" fontSize={12} fontWeight={600}>{eng}</text>
                    );
                  })}

                  <g transform={`translate(${MARGIN.left}, ${MARGIN.top + PLOT_H + 42})`}>
                    {periods.map((p, pi) => {
                      const lx = pi * 80;
                      const wkLabel = chartMode === 'week' && p.key.includes('-W') ? `W${p.key.split('-W')[1]}` : p.label;
                      return (
                        <g key={p.key} transform={`translate(${lx}, 0)`}>
                          <rect x={0} y={0} width={10} height={10} rx={2} fill={COLORS[pi % COLORS.length]} opacity={0.88} />
                          <text x={14} y={9} fill="#64748B" fontSize={10}>{wkLabel}</text>
                        </g>
                      );
                    })}
                  </g>
                </svg>
              </div>
            </Card>
          );
        } catch (e) {
          console.warn('[TaskStats] period chart render error:', e);
          return null;
        }
      })()}

      {/* 效率对比（基于 mergedStats，PCE 来自 taskStats.json 快照） */}
      <Card title="效率对比" className="mt-4" bodyClassName="pb-2">
        {mergedStats.filter((st) => st.avgPce != null).length > 0 ? (
          <div className="space-y-3">
            {mergedStats
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
        ) : (
          <p className="py-6 text-center text-sm text-slate-400">
            暂无 PCE 效率数据，请管理员在「验证计划」页同步云端数据以生成 PCE 统计快照
          </p>
        )}
        <div className="mt-3 border-t border-slate-50 pt-3 text-center text-[10px] text-slate-400">
          {criteriaTextShort(thresholds)}
        </div>
      </Card>
    </div>
  );
}