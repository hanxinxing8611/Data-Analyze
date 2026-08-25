import { useMemo, useState } from 'react';
import type { ScheduleItem } from '../../types';

type ViewMode = 'day' | 'week' | 'month';

/** 甘特图颜色映射 */
const STATUS_COLORS: Record<ScheduleItem['status'], { bar: string; barEnd: string; text: string }> = {
  planned: { bar: '#cbd5e1', barEnd: '#94a3b8', text: '#475569' },
  in_progress: { bar: '#3b82f6', barEnd: '#2563eb', text: '#fff' },
  completed: { bar: '#94a3b8', barEnd: '#64748b', text: '#fff' },
};

const OVERDUE_COLOR = { bar: '#ef4444', barEnd: '#dc2626', text: '#fff' };

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function statusLabel(s: ScheduleItem['status']): string {
  return s === 'in_progress' ? '进行中' : s === 'completed' ? '已完成' : '计划中';
}

interface Period { key: string; label: string; startDate: string; endDate: string; }

/** 按 viewMode 生成时段列表 */
function genPeriods(items: ScheduleItem[], mode: ViewMode, today: string): Period[] {
  if (items.length === 0) {
    const d = new Date();
    const start = new Date(d); start.setDate(d.getDate() - 3);
    const end = new Date(d); end.setDate(d.getDate() + 6);
    return mode === 'day' ? genDayPeriods(start, end) : mode === 'week' ? genWeekPeriods(start, end) : genMonthPeriods(start, end);
  }
  let minD = today;
  let maxD = today;
  for (const it of items) {
    if (it.start_date < minD) minD = it.start_date;
    if (it.report_deadline > maxD) maxD = it.report_deadline;
  }
  const min = new Date(minD); min.setDate(min.getDate() - 2);
  const max = new Date(maxD); max.setDate(max.getDate() + 2);
  return mode === 'day' ? genDayPeriods(min, max) : mode === 'week' ? genWeekPeriods(min, max) : genMonthPeriods(min, max);
}

function genDayPeriods(start: Date, end: Date): Period[] {
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const periods: Period[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const ds = fmtDate(d);
    periods.push({ key: ds, label: `${d.getMonth() + 1}/${d.getDate()}`, startDate: ds, endDate: ds });
  }
  return periods;
}

function genWeekPeriods(start: Date, end: Date): Period[] {
  const periods: Period[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    const day = cur.getDay();
    const monday = new Date(cur); monday.setDate(cur.getDate() - (day === 0 ? 6 : day - 1));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    const startOfYear = new Date(monday.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((monday.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
    const key = `${monday.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    if (!periods.some(p => p.key === key)) {
      periods.push({
        key,
        label: `${monday.getMonth() + 1}/${monday.getDate()}`,
        startDate: fmtDate(monday),
        endDate: fmtDate(sunday),
      });
    }
    cur.setDate(cur.getDate() + 7);
  }
  return periods;
}

function genMonthPeriods(start: Date, end: Date): Period[] {
  const periods: Period[] = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
    const lastDay = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    periods.push({
      key,
      label: `${cur.getFullYear()}/${cur.getMonth() + 1}`,
      startDate: fmtDate(cur),
      endDate: fmtDate(lastDay),
    });
    cur.setMonth(cur.getMonth() + 1);
  }
  return periods;
}

interface Props {
  items: ScheduleItem[];
  width?: number;
}

export default function GanttChart({ items, width = 760 }: Props) {
  const today = todayStr();
  const [viewMode, setViewMode] = useState<ViewMode>('day');

  const periods = useMemo(() => genPeriods(items, viewMode, today), [items, viewMode, today]);

  const engineers = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) set.add(it.engineer_name);
    return Array.from(set).sort();
  }, [items]);

  const engineerItems = useMemo(() => {
    const m = new Map<string, ScheduleItem[]>();
    for (const it of items) {
      const arr = m.get(it.engineer_name) || [];
      arr.push(it);
      m.set(it.engineer_name, arr);
    }
    return m;
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/50 text-sm text-slate-400">
        暂无验证计划，请添加新条目
      </div>
    );
  }

  const padLeft = 108;
  const padTop = viewMode === 'day' ? 38 : 36;
  const rowH = 56;
  const barH = 26;
  const barYOff = (rowH - barH) / 2;
  const chartW = width - padLeft;
  const periodW = chartW / periods.length;
  const totalH = padTop + engineers.length * rowH + 16;

  return (
    <div>
      {/* 视图切换按钮 */}
      <div className="mb-3 flex items-center gap-1">
        {(['day', 'week', 'month'] as ViewMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              viewMode === mode
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
          >
            {mode === 'day' ? '日' : mode === 'week' ? '周' : '月'}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <svg
          viewBox={`0 0 ${width} ${totalH}`}
          width={width}
          height={totalH}
          className="block"
          style={{ minWidth: width, fontFamily: "Arial, 'Microsoft YaHei', sans-serif" }}
        >
          <defs>
            <linearGradient id="gantt-bg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f8fafc" />
              <stop offset="100%" stopColor="#f1f5f9" />
            </linearGradient>
            {['planned', 'in_progress', 'completed', 'overdue'].map((key) => (
              <linearGradient key={key} id={`gantt-bar-${key}`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={
                  key === 'overdue' ? '#ef4444' : key === 'in_progress' ? '#3b82f6' : key === 'completed' ? '#94a3b8' : '#cbd5e1'
                } />
                <stop offset="100%" stopColor={
                  key === 'overdue' ? '#dc2626' : key === 'in_progress' ? '#1d4ed8' : key === 'completed' ? '#64748b' : '#94a3b8'
                } />
              </linearGradient>
            ))}
            <filter id="gantt-shadow" x="-4" y="-2" width="calc(100%+8)" height="calc(100%+6)">
              <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#0f172a" floodOpacity="0.08" />
            </filter>
          </defs>

          {/* 顶部标题栏背景 */}
          <rect x={0} y={0} width={width} height={padTop} fill="url(#gantt-bg)" rx={0} />
          <line x1={0} y1={padTop} x2={width} y2={padTop} stroke="#e2e8f0" strokeWidth={1} />

          {/* 时段刻度 */}
          {periods.map((p, i) => {
            const x = padLeft + i * periodW + periodW / 2;
            const containsToday = today >= p.startDate && today <= p.endDate;
            return (
              <g key={p.key}>
                {containsToday && (
                  <>
                    <line x1={x} y1={padTop} x2={x} y2={totalH} stroke="#ef4444" strokeWidth={2} opacity={0.3} />
                    <circle cx={x} cy={padTop - 6} r={3} fill="#ef4444" />
                  </>
                )}
                <text
                  x={x}
                  y={containsToday ? 14 : 20}
                  textAnchor="middle"
                  fontSize={containsToday ? 11 : 10}
                  fontWeight={containsToday ? 700 : 400}
                  fill={containsToday ? '#ef4444' : '#94a3b8'}
                >
                  {p.label}
                </text>
                {containsToday && viewMode === 'day' && (
                  <text x={x} y={padTop - 12} textAnchor="middle" fontSize={10} fontWeight={700} fill="#ef4444">今天</text>
                )}
              </g>
            );
          })}

          {engineers.map((eng, ei) => {
            const rowY = padTop + ei * rowH;
            const engTasks = engineerItems.get(eng) || [];
            return (
              <g key={eng}>
                <rect x={0} y={rowY} width={width} height={rowH} fill={ei % 2 === 0 ? '#fafbfc' : '#fff'} />
                <line x1={padLeft} y1={rowY + rowH} x2={width} y2={rowY + rowH} stroke="#f1f5f9" strokeWidth={1} />
                <rect x={4} y={rowY + 4} width={padLeft - 12} height={rowH - 8} rx={6} fill="#f1f5f9" />
                <text x={padLeft - 12} y={rowY + rowH / 2 + 4} textAnchor="end" fontSize={12} fontWeight={600} fill="#334155">{eng}</text>

                {engTasks.map((task) => {
                  let startIdx = -1, endIdx = -1;
                  if (viewMode === 'day') {
                    startIdx = dayDiff(periods[0].startDate, task.start_date);
                    endIdx = dayDiff(periods[0].startDate, task.report_deadline);
                  } else {
                    startIdx = periods.findIndex(p => p.startDate <= task.start_date && p.endDate >= task.start_date);
                    endIdx = periods.findIndex(p => p.startDate <= task.report_deadline && p.endDate >= task.report_deadline);
                    if (startIdx === -1) startIdx = periods.findIndex(p => p.startDate > task.start_date);
                    if (endIdx === -1) endIdx = periods.length - 1;
                  }
                  if (startIdx === -1 || endIdx === -1) return null;

                  const x = padLeft + startIdx * periodW;
                  const w = Math.max((endIdx - startIdx + 1) * periodW, 6);
                  const isOverdue = task.status !== 'completed' && task.report_deadline < today;
                  const colorKey = isOverdue ? 'overdue' : task.status;
                  const colors = isOverdue ? OVERDUE_COLOR : STATUS_COLORS[task.status];

                  return (
                    <g key={task.id}>
                      <rect x={x + 1} y={rowY + barYOff} width={Math.max(w - 2, 4)} height={barH} rx={6} fill={`url(#gantt-bar-${colorKey})`} filter="url(#gantt-shadow)" />
                      <rect x={x + 2} y={rowY + barYOff + 1} width={Math.max(w - 4, 2)} height={4} rx={3} fill="white" opacity={0.2} />
                      <text x={x + 8} y={rowY + barYOff + barH / 2 + 4} fontSize={11} fontWeight={600} fill={colors.text} style={{ textShadow: '0 1px 2px rgba(0,0,0,0.15)' }}>{task.batch_id}</text>
                      {viewMode === 'day' && (
                        <polygon
                          points={`${x + w - 1},${rowY + barYOff + barH / 2} ${x + w + 6},${rowY + barYOff + barH / 2 - 4} ${x + w + 11},${rowY + barYOff + barH / 2} ${x + w + 6},${rowY + barYOff + barH / 2 + 4}`}
                          fill={isOverdue ? '#ef4444' : '#94a3b8'} opacity={0.7}
                        />
                      )}
                      <text x={x + w + 16} y={rowY + barYOff + barH / 2 + 4} fontSize={9} fontWeight={600} fill={isOverdue ? '#ef4444' : '#64748b'}>
                        {isOverdue ? '逾期' : task.status === 'completed' ? '' : statusLabel(task.status)}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}