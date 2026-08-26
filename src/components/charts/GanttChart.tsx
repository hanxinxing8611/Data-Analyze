import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScheduleItem } from '../../types';

type ViewMode = 'day' | 'week' | 'month';

/** 各视图一次可见的时段数：日=两周(14天)，周=8周，月=6个月 */
const VISIBLE_PERIODS: Record<ViewMode, number> = { day: 14, week: 8, month: 6 };

/** 法定节假日表（按国务院办公厅当年通知维护；跨天区间，含首尾） */
const HOLIDAYS: { name: string; start: string; end: string }[] = [
  { name: '元旦', start: '2026-01-01', end: '2026-01-03' },
  { name: '春节', start: '2026-02-15', end: '2026-02-23' },
  { name: '清明节', start: '2026-04-04', end: '2026-04-06' },
  { name: '劳动节', start: '2026-05-01', end: '2026-05-05' },
  { name: '端午节', start: '2026-06-19', end: '2026-06-21' },
  { name: '中秋节', start: '2026-09-25', end: '2026-09-27' },
  { name: '国庆节', start: '2026-10-01', end: '2026-10-08' },
];

function holidayOf(d: string): string | null {
  const h = HOLIDAYS.find((x) => d >= x.start && d <= x.end);
  return h ? h.name : null;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

interface Period {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
  weekend: boolean;
  /** 时段内是否含法定节假日（日视图用） */
  holiday: string | null;
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------------- 时段生成 ---------------- */

function genPeriods(items: ScheduleItem[], mode: ViewMode, today: string): Period[] {
  let minD = today;
  let maxD = today;
  for (const it of items) {
    if (it.start_date < minD) minD = it.start_date;
    if (it.report_deadline > maxD) maxD = it.report_deadline;
  }
  const min = new Date(minD); min.setDate(min.getDate() - 14);
  const max = new Date(maxD); max.setDate(max.getDate() + 14);
  return mode === 'day' ? genDayPeriods(min, max) : mode === 'week' ? genWeekPeriods(min, max) : genMonthPeriods(min, max);
}

function genDayPeriods(start: Date, end: Date): Period[] {
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const periods: Period[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const ds = fmtDate(d);
    const holiday = holidayOf(ds);
    periods.push({
      key: ds,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      startDate: ds,
      endDate: ds,
      weekend: d.getDay() === 0 || d.getDay() === 6,
      holiday,
    });
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
    const key = fmtDate(monday);
    if (!periods.some(p => p.key === key)) {
      periods.push({
        key,
        label: `${monday.getMonth() + 1}/${monday.getDate()}`,
        startDate: fmtDate(monday),
        endDate: fmtDate(sunday),
        weekend: false,
        holiday: null,
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
    const lastDay = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    periods.push({
      key: `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`,
      label: `${cur.getFullYear()}/${cur.getMonth() + 1}`,
      startDate: fmtDate(cur),
      endDate: fmtDate(lastDay),
      weekend: false,
      holiday: null,
    });
    cur.setMonth(cur.getMonth() + 1);
  }
  return periods;
}

/* ---------------- 组件 ---------------- */

interface Props {
  items: ScheduleItem[];
  width?: number;
}

export default function GanttChart({ items }: Props) {
  const today = todayStr();
  const [viewMode, setViewMode] = useState<ViewMode>('day');

  /* 容器实测宽度（用于计算每时段像素宽） */
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(900);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 100) setContainerW(w);
    });
    ro.observe(el);
    setContainerW(el.clientWidth || 900);
    return () => ro.disconnect();
  }, []);

  const periods = useMemo(() => genPeriods(items, viewMode, today), [items, viewMode, today]);

  const engineers = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) set.add(it.engineer_name);
    return Array.from(set).sort();
  }, [items]);

  /** 任务分泳道：同工程师时间重叠的任务自动错行，避免完全遮挡 */
  const layout = useMemo(() => {
    const m = new Map<string, { task: ScheduleItem; lane: number }[]>();
    for (const eng of engineers) {
      const tasks = items
        .filter((it) => it.engineer_name === eng)
        .sort((a, b) => a.start_date.localeCompare(b.start_date));
      const laneEnds: string[] = [];
      const assigned: { task: ScheduleItem; lane: number }[] = [];
      for (const t of tasks) {
        let lane = laneEnds.findIndex((end) => end < t.start_date);
        if (lane === -1) {
          laneEnds.push(t.report_deadline);
          lane = laneEnds.length - 1;
        } else {
          laneEnds[lane] = t.report_deadline;
        }
        assigned.push({ task: t, lane });
      }
      m.set(eng, assigned);
    }
    return m;
  }, [items, engineers]);

  /* 打开/切换视图后滚到今天居中 */
  const visibleCount = VISIBLE_PERIODS[viewMode];
  const periodW = containerW / visibleCount;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const idx = periods.findIndex((p) => today >= p.startDate && today <= p.endDate);
    const target = idx === -1 ? 0 : idx;
    el.scrollLeft = Math.max(0, (target + 0.5) * periodW - (el.clientWidth || containerW) / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, periods.length, containerW]);

  /* 横向拖动平移 */
  const drag = useRef<{ x: number; sl: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    drag.current = { x: e.clientX, sl: el.scrollLeft };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = drag.current.sl - (e.clientX - drag.current.x);
  };
  const endDrag = () => { drag.current = null; };

  /** 按一次按钮平移一个时段（日视图=1天，周视图=1周，月视图=1月） */
  const nudge = (dir: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * periodW, behavior: 'smooth' });
  };
  const backToToday = () => {
    const el = scrollRef.current;
    if (!el) return;
    const idx = periods.findIndex((p) => today >= p.startDate && today <= p.endDate);
    const target = idx === -1 ? 0 : idx;
    el.scrollTo({ left: Math.max(0, (target + 0.5) * periodW - el.clientWidth / 2), behavior: 'smooth' });
  };

  if (items.length === 0) {
    return (
      <div className="p-5">
        <div className="flex h-36 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/50 text-sm text-slate-400">
          暂无验证计划，请添加新条目
        </div>
      </div>
    );
  }

  /* ---- 几何参数 ---- */
  const padLeft = 92;
  const headH = 40;
  const laneH = 30;
  const barH = 22;
  const rowPadV = 8;
  const width = padLeft + periods.length * periodW;

  const engRows = engineers.map((eng) => {
    const lanes = layout.get(eng) || [];
    const laneCount = Math.max(1, ...lanes.map((l) => l.lane + 1));
    return { eng, laneCount, rowH: laneCount * laneH + rowPadV * 2 };
  });
  const totalH = headH + engRows.reduce((sum, r) => sum + r.rowH, 0) + 8;

  /** 时间 → 时段索引（超出范围取边界） */
  const dateToIdx = (d: string): number => {
    if (viewMode === 'day') {
      const idx = dayDiff(periods[0].startDate, d);
      return Math.max(0, Math.min(periods.length - 1, idx));
    }
    let idx = periods.findIndex((p) => p.startDate <= d && p.endDate >= d);
    if (idx === -1) idx = d < periods[0].startDate ? 0 : periods.length - 1;
    return idx;
  };

  /** 日期在时段内的水平偏移比例（日视图精确到天，周/月视图按天比例） */
  const dateX = (d: string): number => {
    const idx = dateToIdx(d);
    if (viewMode === 'day') return padLeft + idx * periodW;
    const p = periods[idx];
    const total = dayDiff(p.startDate, p.endDate) || 1;
    const offset = Math.max(0, Math.min(total, dayDiff(p.startDate, d)));
    return padLeft + (idx + offset / total) * periodW;
  };

  return (
    <div ref={wrapRef}>
      {/* 顶部：视图切换 + 平移控制 + 图例 */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
            {(['day', 'week', 'month'] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
                  viewMode === mode
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {mode === 'day' ? '日' : mode === 'week' ? '周' : '月'}
              </button>
            ))}
          </div>
          {/* 平移按钮 + 回到今天 */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => nudge(-1)}
              title={viewMode === 'day' ? '前一天' : viewMode === 'week' ? '前一周' : '前一月'}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 text-slate-500 transition hover:border-blue-300 hover:text-blue-600"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={backToToday}
              className="rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-500 transition hover:border-blue-300 hover:text-blue-600"
            >
              今天
            </button>
            <button
              type="button"
              onClick={() => nudge(1)}
              title={viewMode === 'day' ? '后一天' : viewMode === 'week' ? '后一周' : '后一月'}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 text-slate-500 transition hover:border-blue-300 hover:text-blue-600"
            >
              ›
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          {([
            { label: '计划中', c: 'bg-slate-500' },
            { label: '进行中', c: 'bg-blue-600' },
            { label: '已完成', c: 'bg-emerald-500' },
            { label: '逾期', c: 'bg-red-600' },
          ]).map((l) => (
            <span key={l.label} className="flex items-center gap-1.5">
              <span className={`h-2.5 w-3.5 rounded-full ${l.c}`} />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      {/* 甘特图主体（可见窗口 + 横向拖动平移） */}
      <div
        ref={scrollRef}
        className="scroll-shadow-x cursor-grab select-none overflow-x-auto active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <svg
          viewBox={`0 0 ${width} ${totalH}`}
          width={width}
          height={totalH}
          className="block"
          style={{ fontFamily: "Arial, 'Microsoft YaHei', sans-serif" }}
        >
          {/* 条形填充使用纯色而非 url(#id) 渐变/滤镜引用：
              本应用为 hash 路由（URL 含 #），部分浏览器下 url(#片段) 解析会失效，
              且 filter 引用失效时整个元素不渲染（SVG 规范），故全部改用纯色 */}

          {/* 时段底色：今天=浅蓝，周末/法定节假日=浅灰（日视图精确到天；周/月视图按含今天） */}
          {periods.map((p, i) => {
            const x = padLeft + i * periodW;
            const isToday = today >= p.startDate && today <= p.endDate;
            const rest = viewMode === 'day' ? p.weekend || p.holiday !== null : p.weekend;
            if (isToday) {
              return <rect key={`bg-${p.key}`} x={x} y={0} width={periodW} height={totalH} fill="#dbeafe" />;
            }
            if (rest) {
              return <rect key={`bg-${p.key}`} x={x} y={0} width={periodW} height={totalH} fill="#f1f5f9" />;
            }
            return null;
          })}

          {/* 表头背景 */}
          <rect x={0} y={0} width={width} height={headH} fill="#f8fafc" />
          <line x1={0} y1={headH} x2={width} y2={headH} stroke="#e2e8f0" strokeWidth={1} />

          {/* 纵向网格线 */}
          {periods.map((p, i) => (
            <line
              key={`grid-${p.key}`}
              x1={padLeft + i * periodW}
              y1={headH}
              x2={padLeft + i * periodW}
              y2={totalH}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
          ))}
          <line x1={padLeft} y1={headH} x2={padLeft} y2={totalH} stroke="#e2e8f0" strokeWidth={1} />

          {/* 时段刻度文字（日视图两行：日期 + 节假日/星期） */}
          {periods.map((p, i) => {
            const cx = padLeft + i * periodW + periodW / 2;
            const isToday = today >= p.startDate && today <= p.endDate;
            const sub = viewMode === 'day' ? (p.holiday ?? '') : '';
            return (
              <g key={`tick-${p.key}`}>
                <text
                  x={cx}
                  y={viewMode === 'day' ? 16 : headH / 2 + 4}
                  textAnchor="middle"
                  fontSize={viewMode === 'day' ? 10 : 11}
                  fontWeight={isToday ? 700 : 400}
                  fill={isToday ? '#2563eb' : p.weekend || p.holiday ? '#cbd5e1' : '#94a3b8'}
                >
                  {p.label}
                </text>
                {sub && (
                  <text x={cx} y={30} textAnchor="middle" fontSize={8.5} fontWeight={600} fill="#f97316">
                    {sub}
                  </text>
                )}
              </g>
            );
          })}

          {/* 今天标记线 */}
          {(() => {
            const idx = periods.findIndex((p) => today >= p.startDate && today <= p.endDate);
            if (idx === -1) return null;
            const x = padLeft + (idx + 0.5) * periodW;
            return (
              <g>
                <line x1={x} y1={headH} x2={x} y2={totalH} stroke="#2563eb" strokeWidth={1.5} strokeDasharray="3 3" opacity={0.6} />
                <rect x={x - 15} y={headH + 4} width={30} height={16} rx={8} fill="#2563eb" />
                <text x={x} y={headH + 15.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff">今天</text>
              </g>
            );
          })()}

          {/* 工程师行 */}
          {engRows.map(({ eng, laneCount, rowH }, rowIndex) => {
            const rowY = headH + engRows.slice(0, rowIndex).reduce((s, r) => s + r.rowH, 0);
            const tasks = layout.get(eng) || [];

            return (
              <g key={eng}>
                {/* 行底色（隔行，半透明让底纹透出） */}
                <rect
                  x={0}
                  y={rowY}
                  width={width}
                  height={rowH}
                  fill={rowIndex % 2 === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(248,250,252,0.55)'}
                />
                <line x1={0} y1={rowY + rowH} x2={width} y2={rowY + rowH} stroke="#f1f5f9" strokeWidth={1} />

                {/* 工程师名（含任务数） */}
                <text x={padLeft - 10} y={rowY + rowH / 2 - 2} textAnchor="end" fontSize={12} fontWeight={600} fill="#334155">
                  {eng}
                </text>
                <text x={padLeft - 10} y={rowY + rowH / 2 + 12} textAnchor="end" fontSize={9} fill="#94a3b8">
                  {tasks.length} 个任务{laneCount > 1 ? ` · ${laneCount}行` : ''}
                </text>

                {/* 任务条（纯色填充，不用 url(#id) 渐变/滤镜引用） */}
                {tasks.map(({ task, lane }) => {
                  const x = dateX(task.start_date);
                  const xEnd = dateX(task.report_deadline);
                  const w = Math.max(xEnd - x + periodW, 8);
                  const y = rowY + rowPadV + lane * laneH + (laneH - barH) / 2;
                  const isOverdue = task.status !== 'completed' && task.report_deadline < today;
                  const barColor = isOverdue
                    ? '#dc2626'
                    : task.status === 'in_progress'
                      ? '#2563eb'
                      : task.status === 'completed'
                        ? '#10b981'
                        : '#64748b';
                  const barW = Math.max(w - 2, 6);

                  // 条形足够宽时批次号放条内
                  const labelFits = w >= 52;

                  return (
                    <g key={task.id ?? `${task.batch_id}-${lane}`}>
                      {/* 条形（50% 透明度） */}
                      <rect
                        x={x + 1}
                        y={y}
                        width={barW}
                        height={barH}
                        rx={11}
                        fill={barColor}
                        fillOpacity={0.5}
                      />
                      {/* 批次号 */}
                      {labelFits ? (
                        <text x={x + Math.max(w, 8) / 2} y={y + barH / 2 + 4} textAnchor="middle" fontSize={10} fontWeight={600} fill="#334155">
                          {task.batch_id}
                        </text>
                      ) : (
                        <text x={x + w + 6} y={y + barH / 2 + 4} fontSize={10} fontWeight={600} fill={isOverdue ? '#dc2626' : '#475569'}>
                          {task.batch_id}
                        </text>
                      )}
                      {/* 逾期小标 */}
                      {isOverdue && (
                        <text
                          x={labelFits ? x + Math.max(w, 8) + 6 : x + w + 6 + task.batch_id.length * 10 + 4}
                          y={y + barH / 2 + 4}
                          fontSize={10}
                          fontWeight={700}
                          fill="#dc2626"
                        >
                          逾期
                        </text>
                      )}
                      {/* 基准批次：黄色小旗子，插在条形图正中 */}
                      {task.is_baseline === 1 && (() => {
                        const fx = x + 1 + barW / 2;
                        const flagH = 13;
                        const flagW = 9;
                        return (
                          <g>
                            {/* 旗杆 */}
                            <line x1={fx} y1={y} x2={fx} y2={y - flagH} stroke="#d97706" strokeWidth={1.6} strokeLinecap="round" />
                            {/* 旗面 */}
                            <path d={`M${fx} ${y - flagH} L${fx + flagW} ${y - flagH + 3.5} L${fx} ${y - flagH + 7} Z`} fill="#f59e0b" />
                          </g>
                        );
                      })()}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      {/* 底部提示 */}
      <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 px-4 py-2 text-[10px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <svg width="10" height="13" viewBox="0 0 10 13" aria-hidden="true">
            <line x1="0.8" y1="0" x2="0.8" y2="13" stroke="#d97706" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M0.8 0 L10 3.5 L0.8 7 Z" fill="#f59e0b" />
          </svg>
          基准批次
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-blue-100" />
          今天
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-slate-100" />
          周末 / 法定节假日
        </span>
        <span>小旗子插在条形正中表示基准批次</span>
        <span>按住时间轴左右拖动可查看过去与未来的计划</span>
      </div>
    </div>
  );
}
