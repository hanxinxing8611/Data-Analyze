import { useEffect, useMemo, useState } from 'react';
import { useData } from '../store/DataContext';
import { useCriteria } from '../store/CriteriaContext';
import { mergeSchedules } from '../database/db';
import { fetchCloudTaskStats, type CloudTaskStat } from '../utils/cloudTaskStats';
import { fetchCloudSchedule } from '../utils/cloudSchedule';
import { criteriaTextShort } from '../report/reportData';
import { Card, Badge, Loading, PageHeader, EmptyState } from '../components/ui';
import type { ScheduleItem } from '../types';

/* ========== 页面组件 ========== */

export default function TaskStats() {
  const { dbReady } = useData();
  const { thresholds } = useCriteria();
  const [cloudStats, setCloudStats] = useState<CloudTaskStat[] | null>(null);
  const [cloudSchedules, setCloudSchedules] = useState<ScheduleItem[]>([]);
  const [loading, setLoading] = useState(true);

  /* 仅从云端拉取数据：验证计划 + 任务统计（不使用本地 samples/schedules） */
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        // 并行拉取云端验证计划和任务统计
        const [scheduleRes, statsRes] = await Promise.all([
          fetchCloudSchedule(),
          fetchCloudTaskStats(),
        ]);

        if (cancelled) return;

        // 验证计划：存入 cloudSchedules 用于逾期计算，同时合并到本地 DB（供其他页面使用）
        if (scheduleRes && scheduleRes.length > 0) {
          setCloudSchedules(scheduleRes as ScheduleItem[]);
          // 合并到本地 DB（不影响 TaskStats 展示，仅供 Dashboard/Schedule 页面使用）
          try { await mergeSchedules(scheduleRes); } catch { /* 静默 */ }
        }

        // 任务统计：仅使用云端预计算数据
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

  /* 统计数据：仅云端 */
  const stats = useMemo(() => cloudStats ?? [], [cloudStats]);

  if (!dbReady || loading) return <Loading text="正在从云端拉取统计数据…" />;

  if (stats.length === 0) {
    return (
      <div>
        <PageHeader title="任务统计" description="工程师工作效率、质量、执行力与负荷统计" />
        <Card>
          <EmptyState
            icon="chart"
            title="暂无云端统计数据"
            description="请先在「验证计划」页添加验证计划并同步到云端，然后再回来查看统计"
          />
        </Card>
      </div>
    );
  }

  /* 卡片数据统一从云端 stats 汇总 */
  const totalBatches = stats.reduce((sum, s) => sum + s.batchCount, 0);
  const totalTasks = stats.reduce((sum, s) => sum + s.totalTasks, 0);
  const totalCompleted = stats.reduce((sum, s) => sum + s.completedTasks, 0);
  const completionRate = totalTasks > 0 ? (totalCompleted / totalTasks) * 100 : 0;

  /* 逾期数实时计算（基于云端验证计划 + 当前日期，不依赖云端快照） */
  const today = new Date().toISOString().slice(0, 10);
  const getRealOverdue = (engineerName: string) =>
    cloudSchedules.filter((s) => s.engineer_name === engineerName && s.status !== 'completed' && s.report_deadline < today).length;

  /* ---- 按周/按月切换 ---- */
  type ChartMode = 'week' | 'month';
  const [chartMode, setChartMode] = useState<ChartMode>('week');

  /* 各工程师按时段批次数（基于云端验证计划的 start_date） */
  const periodChartData = useMemo(() => {
    if (cloudSchedules.length === 0) return null;

    const engineers = [...new Set(cloudSchedules.map((s) => s.engineer_name))].sort();

    function getPeriodKey(dateStr: string): { key: string; label: string } {
      const d = new Date(dateStr + 'T00:00:00');
      if (chartMode === 'month') {
        return {
          key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
          label: `${d.getMonth() + 1}月`,
        };
      }
      // Week: get Monday date
      const day = d.getDay();
      const monday = new Date(d);
      monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
      const startOfYear = new Date(monday.getFullYear(), 0, 1);
      const weekNum = Math.ceil(
        ((monday.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7,
      );
      return {
        key: `${monday.getFullYear()}-W${String(weekNum).padStart(2, '0')}`,
        label: `${monday.getMonth() + 1}/${monday.getDate()}`,
      };
    }

    // periodKey → { label, engineer → Set<batchId> }
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
      entry.engineers.get(s.engineer_name)!.add(s.batch_id);
    }

    const periods = [...periodMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, { label }]) => ({ key, label }));

    const data = engineers.map((name) =>
      periods.map((p) => periodMap.get(p.key)?.engineers.get(name)?.size ?? 0),
    );

    return { engineers, periods, data };
  }, [cloudSchedules, chartMode]);

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
      {/* 数据来源标识 */}
      <div className="-mt-4 mb-4">
        <Badge tone="blue">云端数据</Badge>
      </div>

      {/* 总览卡片（A1: 数据统一从 stats 汇总，内容居中，数字 Arial 36px） */}
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

                    {/* 逾期任务（A3: 用当前日期实时计算） */}
                    <td className="text-center">
                      {(() => {
                        const realOverdue = getRealOverdue(st.name);
                        return realOverdue > 0 ? (
                          <Badge tone="red">{realOverdue} 项逾期</Badge>
                        ) : (
                          <span className="text-xs text-slate-400">无逾期</span>
                        );
                      })()}
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
            <strong>验证批次</strong>：该工程师负责的验证批次数量，≥5个标记为高负荷。
          </p>
        </div>
      </Card>

      {/* 验证批次数对比（按周/按月） */}
      {periodChartData && periodChartData.periods.length > 0 && (() => {
        const { engineers, periods, data } = periodChartData;
        const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1', '#14B8A6', '#D946EF'];
        const MARGIN = { top: 30, right: 24, bottom: 60, left: 44 };
        const PLOT_H = 280;
        const PLOT_W = Math.max(600, engineers.length * 90 + 40);
        const CHART_W = PLOT_W + MARGIN.left + MARGIN.right;
        const CHART_H = PLOT_H + MARGIN.top + MARGIN.bottom;
        const maxVal = Math.max(1, ...data.flat());
        const yMax = Math.ceil(maxVal * 1.15);
        const yTicks = yMax <= 5 ? yMax : Math.ceil(yMax / 2) * 2;
        const groupW = PLOT_W / engineers.length;
        const barCount = periods.length;
        const barGap = 3;
        const barW = Math.max(4, (groupW * 0.7 - barGap * (barCount - 1)) / barCount);

        return (
          <Card title="验证批次数对比" className="mt-4" bodyClassName="pb-2">
            {/* 切换按钮 */}
            <div className="mb-3 flex items-center gap-1">
              <button
                onClick={() => setChartMode('week')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  chartMode === 'week'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                按周
              </button>
              <button
                onClick={() => setChartMode('month')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  chartMode === 'month'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                按月
              </button>
            </div>

            <div className="overflow-auto scroll-shadow-x">
              <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width={CHART_W} height={CHART_H} style={{ minWidth: '100%' }} fontFamily="Arial, 'Microsoft YaHei', sans-serif">
                {/* Y-axis grid lines */}
                {Array.from({ length: yTicks + 1 }, (_, i) => {
                  const y = MARGIN.top + PLOT_H - (i / yTicks) * PLOT_H;
                  return (
                    <g key={i}>
                      <line x1={MARGIN.left} y1={y} x2={MARGIN.left + PLOT_W} y2={y} stroke="#E2E8F0" strokeWidth={1} />
                      <text x={MARGIN.left - 6} y={y + 4} textAnchor="end" fill="#94A3B8" fontSize={11}>
                        {i}
                      </text>
                    </g>
                  );
                })}

                {/* X-axis line */}
                <line x1={MARGIN.left} y1={MARGIN.top + PLOT_H} x2={MARGIN.left + PLOT_W} y2={MARGIN.top + PLOT_H} stroke="#CBD5E1" strokeWidth={1} />

                {/* Bars */}
                {engineers.map((eng, ei) => {
                  const gx = MARGIN.left + ei * groupW + groupW * 0.15;
                  return periods.map((p, pi) => {
                    const val = data[ei][pi];
                    if (val === 0) return null;
                    const barH = (val / yTicks) * PLOT_H;
                    const bx = gx + pi * (barW + barGap);
                    const by = MARGIN.top + PLOT_H - barH;
                    return (
                      <g key={`${ei}-${pi}`}>
                        <rect
                          x={bx}
                          y={by}
                          width={barW}
                          height={barH}
                          rx={2}
                          fill={COLORS[pi % COLORS.length]}
                          opacity={0.88}
                        />
                        {/* Value label on top of bar */}
                        <text
                          x={bx + barW / 2}
                          y={by - 4}
                          textAnchor="middle"
                          fill="#475569"
                          fontSize={10}
                          fontWeight={600}
                        >
                          {val}
                        </text>
                      </g>
                    );
                  });
                })}

                {/* X-axis engineer labels */}
                {engineers.map((eng, ei) => {
                  const cx = MARGIN.left + ei * groupW + groupW / 2;
                  return (
                    <text
                      key={eng}
                      x={cx}
                      y={MARGIN.top + PLOT_H + 20}
                      textAnchor="middle"
                      fill="#334155"
                      fontSize={12}
                      fontWeight={600}
                    >
                      {eng}
                    </text>
                  );
                })}

                {/* Legend */}
                <g transform={`translate(${MARGIN.left}, ${MARGIN.top + PLOT_H + 42})`}>
                  {periods.map((p, pi) => {
                    const lx = pi * 80;
                    return (
                      <g key={p.key} transform={`translate(${lx}, 0)`}>
                        <rect x={0} y={0} width={10} height={10} rx={2} fill={COLORS[pi % COLORS.length]} opacity={0.88} />
                        <text x={14} y={9} fill="#64748B" fontSize={10}>
                          {chartMode === 'week' ? `W${p.key.split('-W')[1]}` : p.label}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </svg>
            </div>
          </Card>
        );
      })()}

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
            {criteriaTextShort(thresholds)}
          </div>
        </Card>
      )}
    </div>
  );
}