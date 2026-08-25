import { useEffect, useMemo, useState } from 'react';
import { useData } from '../store/DataContext';
import { useCriteria } from '../store/CriteriaContext';
import { querySchedules, querySamples, queryBatches } from '../database/db';
import { isValidDevice } from '../report/reportData';
import { median } from '../utils/statistics';
import { Card, Badge, Loading, PageHeader, EmptyState } from '../components/ui';
import type { ScheduleItem, SampleRecord, BatchSummary } from '../types';

/* ========== 工作日计算 ========== */

function isWeekend(date: Date): boolean {
  const d = date.getDay();
  return d === 0 || d === 6;
}

function workingDaysBetween(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  let count = 0;
  const d = new Date(s);
  while (d <= e) {
    if (!isWeekend(d)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ========== 工程师统计 ========== */

interface EngineerStats {
  name: string;
  email: string;
  /** 验证周期：每项计划 start→deadline 工作日数 */
  cycleDays: number[];
  /** PCE 效率：该工程师负责批次中所有有效器件的效率值 */
  pceValues: number[];
  /** 报告及时性：已完成 / 总数 */
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
  /** 验证批次数量 */
  batchCount: number;
}

/* ========== 页面组件 ========== */

export default function TaskStats() {
  const { dbReady, version } = useData();
  const { thresholds } = useCriteria();
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [samples, setSamples] = useState<SampleRecord[]>([]);
  const [batches, setBatches] = useState<BatchSummary[]>([]);

  useEffect(() => {
    if (!dbReady) return;
    setSchedules(querySchedules());
    setSamples(querySamples());
    setBatches(queryBatches());
  }, [dbReady, version]);

  /* 按工程师聚合统计 */
  const stats = useMemo(() => {
    const today = todayStr();
    const map = new Map<string, EngineerStats>();

    // 建立批次→工程师映射（从 schedule 表）
    const batchEngineers = new Map<string, Set<string>>();
    for (const s of schedules) {
      if (!batchEngineers.has(s.batch_id)) {
        batchEngineers.set(s.batch_id, new Set());
      }
      batchEngineers.get(s.batch_id)!.add(s.engineer_name);
    }

    // 初始化工程师统计
    for (const s of schedules) {
      if (!map.has(s.engineer_name)) {
        map.set(s.engineer_name, {
          name: s.engineer_name,
          email: s.engineer_email,
          cycleDays: [],
          pceValues: [],
          totalTasks: 0,
          completedTasks: 0,
          overdueTasks: 0,
          batchCount: 0,
        });
      }
      const st = map.get(s.engineer_name)!;
      st.totalTasks++;
      if (s.status === 'completed') st.completedTasks++;
      if (s.status !== 'completed' && s.report_deadline < today) st.overdueTasks++;

      // 验证周期
      const days = workingDaysBetween(s.start_date, s.report_deadline);
      if (days > 0) st.cycleDays.push(days);
    }

    // 验证批次数量（去重）
    const engineerBatches = new Map<string, Set<string>>();
    for (const s of schedules) {
      if (!engineerBatches.has(s.engineer_name)) {
        engineerBatches.set(s.engineer_name, new Set());
      }
      engineerBatches.get(s.engineer_name)!.add(s.batch_id);
    }
    for (const [name, bSet] of engineerBatches) {
      if (map.has(name)) {
        map.get(name)!.batchCount = bSet.size;
      }
    }

    // PCE 效率：按有效器件统计
    const validSamples = samples.filter((r) => isValidDevice(r, thresholds));
    for (const r of validSamples) {
      if (r.efficiency == null) continue;
      const engineers = batchEngineers.get(r.batch_id);
      if (!engineers) continue;
      for (const eng of engineers) {
        if (map.has(eng)) {
          map.get(eng)!.pceValues.push(r.efficiency);
        }
      }
    }

    return Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name, 'zh'),
    );
  }, [schedules, samples, thresholds]);

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
      <PageHeader title="任务统计" description="工程师工作效率、质量、执行力与负荷统计" />

      {/* 总览卡片 */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-blue-100 bg-blue-50/50" bodyClassName="py-4">
          <div className="text-xs text-slate-500">工程师总数</div>
          <div className="mt-1 text-3xl font-bold text-slate-900">
            {stats.length}
          </div>
        </Card>
        <Card className="border-emerald-100 bg-emerald-50/50" bodyClassName="py-4">
          <div className="text-xs text-slate-500">验证批次总数</div>
          <div className="mt-1 text-3xl font-bold text-slate-900">
            {new Set(schedules.map((s) => s.batch_id)).size}
          </div>
        </Card>
        <Card className="border-violet-100 bg-violet-50/50" bodyClassName="py-4">
          <div className="text-xs text-slate-500">验证计划总数</div>
          <div className="mt-1 text-3xl font-bold text-slate-900">
            {schedules.length}
          </div>
        </Card>
        <Card className="border-amber-100 bg-amber-50/50" bodyClassName="py-4">
          <div className="text-xs text-slate-500">总体完成率</div>
          <div className="mt-1 text-3xl font-bold text-slate-900">
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
                const avgCycle =
                  st.cycleDays.length > 0
                    ? (st.cycleDays.reduce((a, b) => a + b, 0) / st.cycleDays.length).toFixed(1)
                    : '—';
                // 标准差用于判断稳定性
                const cycleStd =
                  st.cycleDays.length > 1
                    ? Math.sqrt(
                        st.cycleDays.reduce(
                          (sum, d) =>
                            sum +
                            Math.pow(
                              d -
                                st.cycleDays.reduce((a, b) => a + b, 0) /
                                  st.cycleDays.length,
                              2,
                            ),
                          0,
                        ) /
                          st.cycleDays.length,
                      )
                    : 0;

                const avgPce =
                  st.pceValues.length > 0
                    ? (st.pceValues.reduce((a, b) => a + b, 0) / st.pceValues.length).toFixed(2)
                    : '—';
                const medPce =
                  st.pceValues.length > 0
                    ? median(st.pceValues).toFixed(2)
                    : '—';
                const maxPce =
                  st.pceValues.length > 0
                    ? Math.max(...st.pceValues).toFixed(2)
                    : '—';

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
                      {cycleStd > 0 && (
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
              .filter((st) => st.pceValues.length > 0)
              .map((st) => {
                const avgPce =
                  st.pceValues.reduce((a, b) => a + b, 0) /
                  st.pceValues.length;
                const maxBarWidth = 80; // percentage
                // 基准线 20%
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
                      {st.pceValues.length} 器件
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