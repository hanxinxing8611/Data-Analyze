import { useMemo } from 'react';
import type { ScheduleItem } from '../../types';

/** 甘特图颜色映射 */
const STATUS_COLORS: Record<ScheduleItem['status'], { bar: string; text: string }> = {
  planned: { bar: '#e2e8f0', text: '#64748b' },
  in_progress: { bar: '#3b82f6', text: '#fff' },
  completed: { bar: '#94a3b8', text: '#fff' },
};

/** 逾期红色（report_deadline < 今天 且 非 completed） */
const OVERDUE_COLOR = { bar: '#ef4444', text: '#fff' };

/** 今天日期字符串 YYYY-MM-DD */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 日期差天数（含首尾） */
function dayDiff(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

/** 状态中文 */
function statusLabel(s: ScheduleItem['status']): string {
  return s === 'in_progress' ? '进行中' : s === 'completed' ? '已完成' : '计划中';
}

interface Props {
  items: ScheduleItem[];
  /** 对外可见宽度（默认 720） */
  width?: number;
}

export default function GanttChart({ items, width = 720 }: Props) {
  const today = todayStr();

  /* 计算日期范围（最早 start_date ~ 最晚 report_deadline，至少覆盖今天前后各 3 天） */
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
    // 左右各扩展 2 天留白
    const min = new Date(minD); min.setDate(min.getDate() - 2);
    const max = new Date(maxD); max.setDate(max.getDate() + 2);
    const days = Math.round((max.getTime() - min.getTime()) / 86400000) + 1;
    return { dateRange: [fmtDate(min), fmtDate(max)], dayLabels: genLabels(min, days), totalDays: days };
  }, [items, today]);

  /* 按工程师分组（去重排序） */
  const engineers = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) set.add(it.engineer_name);
    return Array.from(set).sort();
  }, [items]);

  /* 工程师名下各任务条 */
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
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-400">
        暂无验证计划，请添加新条目
      </div>
    );
  }

  // 布局参数
  const padLeft = 100; // 工程师名宽度
  const padTop = 32; // 顶部日期刻度
  const rowH = 52; // 每行高度
  const barH = 22; // 任务条高度
  const barYOff = (rowH - barH) / 2;
  const chartW = width - padLeft;
  const dayW = chartW / totalDays;
  const totalH = padTop + engineers.length * rowH + 20;

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <svg
        viewBox={`0 0 ${width} ${totalH}`}
        width={width}
        height={totalH}
        className="block"
        style={{ minWidth: width }}
      >
        {/* 日期刻度 */}
        <line x1={padLeft} y1={padTop} x2={width} y2={padTop} stroke="#e2e8f0" strokeWidth={1} />
        {dayLabels.map((d, i) => {
          const x = padLeft + i * dayW + dayW / 2;
          const isToday = d.date === today;
          return (
            <g key={d.date}>
              {/* 今日竖线 */}
              {isToday && (
                <line
                  x1={x}
                  y1={padTop - 4}
                  x2={x}
                  y2={totalH - 4}
                  stroke="#ef4444"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
              )}
              <text
                x={x}
                y={isToday ? 14 : 22}
                textAnchor="middle"
                fontSize={isToday ? 11 : 10}
                fontWeight={isToday ? 700 : 400}
                fill={isToday ? '#ef4444' : '#94a3b8'}
              >
                {d.label}
              </text>
              {isToday && (
                <text
                  x={x}
                  y={padTop - 8}
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
                fill={ei % 2 === 0 ? '#fafafa' : '#fff'}
              />
              {/* 工程师名 */}
              <text
                x={padLeft - 8}
                y={rowY + rowH / 2 + 4}
                textAnchor="end"
                fontSize={12}
                fontWeight={600}
                fill="#1e293b"
              >
                {eng}
              </text>

              {/* 任务条 */}
              {engTasks.map((task) => {
                const startOff = dayDiff(dateRange[0], task.start_date);
                const dur = dayDiff(task.start_date, task.report_deadline) + 1;
                const x = padLeft + startOff * dayW;
                const w = Math.max(dur * dayW, 4);
                const isOverdue = task.status !== 'completed' && task.report_deadline < today;
                const colors = isOverdue ? OVERDUE_COLOR : STATUS_COLORS[task.status];

                return (
                  <g key={task.id}>
                    {/* 任务条 */}
                    <rect
                      x={x}
                      y={rowY + barYOff}
                      width={w}
                      height={barH}
                      rx={4}
                      fill={colors.bar}
                    />
                    {/* 批次号文本 */}
                    <text
                      x={x + 6}
                      y={rowY + barYOff + barH / 2 + 4}
                      fontSize={10}
                      fontWeight={500}
                      fill={colors.text}
                    >
                      {task.batch_id}
                      {task.material_type ? ` ${task.material_type}` : ''}
                    </text>
                    {/* 截止日期小标记 */}
                    <line
                      x1={padLeft + (startOff + dur - 1) * dayW + dayW / 2}
                      y1={rowY + barYOff}
                      x2={padLeft + (startOff + dur - 1) * dayW + dayW / 2}
                      y2={rowY + barYOff + barH}
                      stroke="#94a3b8"
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                    {/* 逾期/状态标签 */}
                    {(isOverdue || task.report_deadline === today) && (
                      <text
                        x={x + w + 4}
                        y={rowY + barYOff + barH / 2 + 4}
                        fontSize={9}
                        fontWeight={600}
                        fill={isOverdue ? '#ef4444' : '#f59e0b'}
                      >
                        {isOverdue ? '逾期' : '今日到期'}
                      </text>
                    )}
                    {/* 状态小标签 */}
                    <text
                      x={x + 6}
                      y={rowY + barYOff + barH + 12}
                      fontSize={9}
                      fill="#94a3b8"
                    >
                      {statusLabel(task.status)}
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