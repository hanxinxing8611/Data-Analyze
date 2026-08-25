import { useMemo } from 'react';
import type { ScheduleItem } from '../../types';

/** 甘特图颜色映射 */
const STATUS_COLORS: Record<ScheduleItem['status'], { bar: string; barEnd: string; text: string }> = {
  planned: { bar: '#cbd5e1', barEnd: '#94a3b8', text: '#475569' },
  in_progress: { bar: '#3b82f6', barEnd: '#2563eb', text: '#fff' },
  completed: { bar: '#94a3b8', barEnd: '#64748b', text: '#fff' },
};

/** 逾期红色 */
const OVERDUE_COLOR = { bar: '#ef4444', barEnd: '#dc2626', text: '#fff' };

/** 今天日期字符串 YYYY-MM-DD */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 日期差天数 */
function dayDiff(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

/** 状态中文 */
function statusLabel(s: ScheduleItem['status']): string {
  return s === 'in_progress' ? '进行中' : s === 'completed' ? '已完成' : '计划中';
}

interface Props {
  items: ScheduleItem[];
  width?: number;
}

export default function GanttChart({ items, width = 760 }: Props) {
  const today = todayStr();

  const { dateRange, dayLabels, totalDays } = useMemo(() => {
    if (items.length === 0) {
      const d = new Date();
      const start = new Date(d); start.setDate(d.getDate() - 3);
      const end = new Date(d); end.setDate(d.getDate() + 6);
      const range = [fmtDate(start), fmtDate(end)];
      const days = (end.getTime() - start.getTime()) / 86400000 + 1;
      return { dateRange: range, dayLabels: genLabels(start, days), totalDays: days };
    }
    let minD = today;
    let maxD = today;
    for (const it of items) {
      if (it.start_date < minD) minD = it.start_date;
      if (it.report_deadline > maxD) maxD = it.report_deadline;
    }
    const min = new Date(minD); min.setDate(min.getDate() - 2);
    const max = new Date(maxD); max.setDate(max.getDate() + 2);
    const days = Math.round((max.getTime() - min.getTime()) / 86400000) + 1;
    return { dateRange: [fmtDate(min), fmtDate(max)], dayLabels: genLabels(min, days), totalDays: days };
  }, [items, today]);

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

  // 布局参数
  const padLeft = 108;
  const padTop = 38;
  const rowH = 56;
  const barH = 26;
  const barYOff = (rowH - barH) / 2;
  const chartW = width - padLeft;
  const dayW = chartW / totalDays;
  const totalH = padTop + engineers.length * rowH + 16;

  return (
    <div className="overflow-x-auto rounded-lg">
      <svg
        viewBox={`0 0 ${width} ${totalH}`}
        width={width}
        height={totalH}
        className="block"
        style={{ minWidth: width, fontFamily: "Arial, 'Microsoft YaHei', sans-serif" }}
      >
        {/* 渐变定义 */}
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

        {/* 日期刻度 */}
        {dayLabels.map((d, i) => {
          const x = padLeft + i * dayW + dayW / 2;
          const isToday = d.date === today;
          const isMonday = new Date(d.date + 'T00:00:00').getDay() === 1;
          return (
            <g key={d.date}>
              {/* 周末浅色背景 */}
              {(() => {
                const dow = new Date(d.date + 'T00:00:00').getDay();
                if (dow === 0 || dow === 6) {
                  return (
                    <rect
                      x={padLeft + i * dayW}
                      y={padTop}
                      width={dayW}
                      height={totalH - padTop}
                      fill="#f8fafc"
                      opacity={0.6}
                    />
                  );
                }
                return null;
              })()}

              {/* 今日竖线 */}
              {isToday && (
                <>
                  <line
                    x1={x}
                    y1={padTop}
                    x2={x}
                    y2={totalH}
                    stroke="#ef4444"
                    strokeWidth={2}
                    opacity={0.3}
                  />
                  <circle cx={x} cy={padTop - 8} r={3} fill="#ef4444" />
                </>
              )}

              {/* 日期标签 */}
              <text
                x={x}
                y={isToday ? 16 : 22}
                textAnchor="middle"
                fontSize={isToday ? 11 : 10}
                fontWeight={isToday ? 700 : isMonday ? 500 : 400}
                fill={isToday ? '#ef4444' : isMonday ? '#64748b' : '#94a3b8'}
              >
                {d.label}
              </text>

              {/* 今天标记 */}
              {isToday && (
                <text
                  x={x}
                  y={padTop - 14}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={700}
                  fill="#ef4444"
                >
                  今天
                </text>
              )}
            </g>
          );
        })}

        {/* 工程师行 */}
        {engineers.map((eng, ei) => {
          const rowY = padTop + ei * rowH;
          const engTasks = engineerItems.get(eng) || [];
          return (
            <g key={eng}>
              {/* 行背景 */}
              <rect
                x={0}
                y={rowY}
                width={width}
                height={rowH}
                fill={ei % 2 === 0 ? '#fafbfc' : '#fff'}
              />

              {/* 水平分隔线 */}
              <line
                x1={padLeft}
                y1={rowY + rowH}
                x2={width}
                y2={rowY + rowH}
                stroke="#f1f5f9"
                strokeWidth={1}
              />

              {/* 工程师名 - 左侧标签 */}
              <rect x={4} y={rowY + 4} width={padLeft - 12} height={rowH - 8} rx={6} fill="#f1f5f9" />
              <text
                x={padLeft - 12}
                y={rowY + rowH / 2 + 4}
                textAnchor="end"
                fontSize={12}
                fontWeight={600}
                fill="#334155"
              >
                {eng}
              </text>

              {/* 任务条 */}
              {engTasks.map((task) => {
                const startOff = dayDiff(dateRange[0], task.start_date);
                const dur = dayDiff(task.start_date, task.report_deadline) + 1;
                const x = padLeft + startOff * dayW;
                const w = Math.max(dur * dayW, 6);
                const isOverdue = task.status !== 'completed' && task.report_deadline < today;
                const colorKey = isOverdue ? 'overdue' : task.status;
                const colors = isOverdue ? OVERDUE_COLOR : STATUS_COLORS[task.status];

                return (
                  <g key={task.id}>
                    {/* 任务条主体 */}
                    <rect
                      x={x + 1}
                      y={rowY + barYOff}
                      width={Math.max(w - 2, 4)}
                      height={barH}
                      rx={6}
                      fill={`url(#gantt-bar-${colorKey})`}
                      filter="url(#gantt-shadow)"
                    />
                    {/* 亮边高光 */}
                    <rect
                      x={x + 2}
                      y={rowY + barYOff + 1}
                      width={Math.max(w - 4, 2)}
                      height={4}
                      rx={3}
                      fill="white"
                      opacity={0.2}
                    />
                    {/* 批次号文本 */}
                    <text
                      x={x + 8}
                      y={rowY + barYOff + barH / 2 + 4}
                      fontSize={11}
                      fontWeight={600}
                      fill={colors.text}
                      style={{ textShadow: '0 1px 2px rgba(0,0,0,0.15)' }}
                    >
                      {task.batch_id}
                    </text>

                    {/* 截止日期菱形标记 */}
                    <polygon
                      points={`${x + w - 1},${rowY + barYOff + barH / 2} ${x + w + 6},${rowY + barYOff + barH / 2 - 4} ${x + w + 11},${rowY + barYOff + barH / 2} ${x + w + 6},${rowY + barYOff + barH / 2 + 4}`}
                      fill={isOverdue ? '#ef4444' : '#94a3b8'}
                      opacity={0.7}
                    />

                    {/* 逾期/状态标签 */}
                    <text
                      x={x + w + 16}
                      y={rowY + barYOff + barH / 2 + 4}
                      fontSize={9}
                      fontWeight={600}
                      fill={isOverdue ? '#ef4444' : '#64748b'}
                    >
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
  );
}

/* 辅助函数 */

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function genLabels(start: Date, days: number): { date: string; label: string }[] {
  const labels: { date: string; label: string }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const date = fmtDate(d);
    labels.push({
      date,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
    });
  }
  return labels;
}