import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useData } from '../store/DataContext';
import { useCriteria } from '../store/CriteriaContext';
import {
  querySchedules,
  querySamples,
  insertSchedule,
  updateSchedule,
  deleteSchedule,
  mergeSchedules,
} from '../database/db';
import { fetchCloudSchedule, pushCloudSchedule, type CloudScheduleItem } from '../utils/cloudSchedule';
import { computeTaskStats, pushCloudTaskStats } from '../utils/cloudTaskStats';
import {
  loadEngineerList,
  usePermission,
  type EngineerEntry,
} from '../utils/permissions';
import { Button, Card, EmptyState, Loading, PageHeader, Badge } from '../components/ui';
import GanttChart from '../components/charts/GanttChart';
import type { ScheduleItem } from '../types';

/* ---- 工程师列表（本地自动保存，读取逻辑统一在 permissions.ts） ---- */

const ENGINEERS_KEY = 'dv-engineers';

function saveEngineers(list: EngineerEntry[]): void {
  try {
    localStorage.setItem(ENGINEERS_KEY, JSON.stringify(list));
  } catch {
    /* 存储失败时忽略 */
  }
}

/* ---- 查看筛选（仅影响本页显示范围，与登录身份解耦） ---- */

const SCHEDULE_FILTER_KEY = 'dv-schedule-filter';
/** 旧版筛选值（曾与登录身份共用），首次访问时迁移 */
const LEGACY_FILTER_KEY = 'dv-current-engineer';

function loadScheduleFilter(): string {
  try {
    const v = localStorage.getItem(SCHEDULE_FILTER_KEY);
    if (v !== null) return v;
    return localStorage.getItem(LEGACY_FILTER_KEY) || '';
  } catch {
    return '';
  }
}

function saveScheduleFilter(name: string): void {
  try {
    localStorage.setItem(SCHEDULE_FILTER_KEY, name);
  } catch {
    /* 忽略 */
  }
}

/* ---- 工作日计算 ---- */

function isWeekend(date: Date): boolean {
  const d = date.getDay();
  return d === 0 || d === 6;
}

/** start_date 后第 n 个工作日（包含 start_date 为第 1 天） */
function addWorkingDays(start: string, n: number): string {
  const d = new Date(start);
  let count = 0;
  while (count < n) {
    if (!isWeekend(d)) count++;
    if (count < n) d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ---- 表单 ---- */

/** 一组验证计划的批次数量 */
const BATCH_GROUP_SIZE = 4;

/** 报告截止日期默认 = 开始日期 + N 个工作日 */
const DEADLINE_WORKING_DAYS = 3;

interface ScheduleForm {
  /** 批次号（一组 4 个，允许留空跳过） */
  batches: string[];
  /** 基准批次在组内的下标（null = 未指定基准） */
  baselineIndex: number | null;
  engineer_name: string;
  start_date: string;
  report_deadline: string;
  status: ScheduleItem['status'];
  notes: string;
}

function emptyForm(): ScheduleForm {
  const today = todayStr();
  return {
    batches: Array.from({ length: BATCH_GROUP_SIZE }, () => ''),
    baselineIndex: null,
    engineer_name: '',
    start_date: today,
    // 截止日期默认 = 开始日期 + 3 个工作日（可手动修改）
    report_deadline: addWorkingDays(today, DEADLINE_WORKING_DAYS),
    status: 'planned',
    notes: '',
  };
}

/* ======================== 弹窗提醒组件 ======================== */

function ReminderModal({
  items,
  currentEngineer,
  onClose,
}: {
  items: ScheduleItem[];
  currentEngineer: string;
  onClose: () => void;
}) {
  const today = todayStr();
  const filtered = currentEngineer
    ? items.filter((it) => it.engineer_name === currentEngineer)
    : items;

  if (filtered.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* 弹窗 */}
      <div className="relative z-10 mx-4 w-full max-w-lg rounded-xl bg-white shadow-2xl">
        {/* 标题栏 */}
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
        {/* 内容 */}
        <div className="max-h-[420px] overflow-auto px-5 py-4">
          <p className="mb-3 text-sm text-slate-600">
            {currentEngineer
              ? `${currentEngineer}，以下 ${filtered.length} 项验证报告已到期或即将到期，请及时提交：`
              : `以下 ${filtered.length} 项验证报告已到期或即将到期，请及时提交：`}
          </p>
          <div className="space-y-2.5">
            {filtered.map((it) => {
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
                      {!!it.is_baseline && <Badge tone="blue">基准</Badge>}
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
        {/* 底部 */}
        <div className="flex items-center justify-between rounded-b-xl border-t border-slate-100 bg-slate-50 px-5 py-3">
          <span className="text-xs text-slate-400">
            本提醒由验证计划系统自动生成
          </span>
          <Button variant="secondary" onClick={onClose}>
            我知道了
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ======================== 主页面 ======================== */

export default function Schedule() {
  const { dbReady, version } = useData();
  const { thresholds } = useCriteria();
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [engineers, setEngineers] = useState<EngineerEntry[]>([]);
  const [currentEngineer, setCurrentEngineer] = useState('');
  const [form, setForm] = useState(emptyForm);
  /** 截止日期是否被手动修改过（手动修改后不再随开始日期自动重算） */
  const [deadlineManual, setDeadlineManual] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [showReminder, setShowReminder] = useState(false);
  const { canWrite } = usePermission();
  /** 同步锁：防止并发推送（B3 防抖） */
  const syncLock = useRef(false);
  /** 同步动画状态 */
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!dbReady) return;
    setItems(querySchedules());
  }, [dbReady, version]);

  useEffect(() => {
    setEngineers(loadEngineerList());
    setCurrentEngineer(loadScheduleFilter());
  }, []);

  /* 逾期/到期提醒列表 */
  const dueItems = useMemo(() => {
    const today = todayStr();
    return items.filter(
      (it) => it.status !== 'completed' && it.report_deadline <= today,
    );
  }, [items]);

  /* 按当前工程师过滤的提醒 */
  const myDueItems = useMemo(() => {
    if (!currentEngineer) return dueItems;
    return dueItems.filter((it) => it.engineer_name === currentEngineer);
  }, [dueItems, currentEngineer]);

  /* 页面加载时自动弹出提醒 */
  useEffect(() => {
    if (dbReady && myDueItems.length > 0) {
      setShowReminder(true);
    }
  }, [dbReady, myDueItems.length]);

  /* 页面挂载时从云端同步验证计划（B1: 先推送本地未同步数据，再合并云端） */
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const localItems = querySchedules();
        const cloud = await fetchCloudSchedule();
        if (!cloud || cancelled) return;

        // 检查本地是否有云端不存在的记录（未推送的新增）
        const cloudKeys = new Set(cloud.map((c: CloudScheduleItem) => `${c.batch_id}|${c.engineer_name}|${c.start_date}`));
        const localOnly = localItems.filter((l) => !cloudKeys.has(`${l.batch_id}|${l.engineer_name}|${l.start_date}`));

        // 本地有未同步数据 → 先推送（需要 Token）
        if (localOnly.length > 0) {
          const payload = localItems.map(({ id, created_at, ...rest }) => rest);
          await pushCloudSchedule(payload);
        }

        // 合并云端到本地（不删除本地独有数据）
        await mergeSchedules(cloud);
        setItems(querySchedules());
      } catch {
        // 静默
      }
    })();
    return () => { cancelled = true; };
  }, [dbReady]);

  /* 推送本地排产数据到云端，同时推送任务统计（B3 防抖 + B4 串行推送） */
  const syncToCloud = async () => {
    if (syncLock.current) return;
    syncLock.current = true;
    setSyncing(true);
    try {
      const all = querySchedules();
      const payload = all.map(({ id, created_at, ...rest }) => rest);

      // B4: 先推 schedule，成功后才推 taskStats
      const result = await pushCloudSchedule(payload);
      if (result.ok) {
        setMsg('已同步云端');
        setTimeout(() => setMsg(''), 3000);
      } else if (result.message === 'not-configured') {
        // 未配置 Token，提示用户
        setError('未配置 GitHub Token，数据仅保存在本地。请在「系统设置」→「云共享设置」中配置 Token 后同步。');
        return;
      } else {
        setError(`云端同步失败：${result.message}`);
        return; // schedule 推送失败 → 不推 taskStats（B4 串行回滚）
      }

      // schedule 推送成功 → 推送任务统计
      try {
        const samples = querySamples();
        const stats = computeTaskStats(all, samples, thresholds);
        await pushCloudTaskStats(stats);
      } catch {
        // 任务统计推送失败不影响主流程
      }
    } finally {
      syncLock.current = false;
      setSyncing(false);
    }
  };

  /* 开始日期变化：截止日期未手动修改过时自动跟随（开始+3 个工作日） */
  const handleStartDate = (date: string) => {
    setForm((prev) => ({
      ...prev,
      start_date: date,
      report_deadline: deadlineManual ? prev.report_deadline : addWorkingDays(date, DEADLINE_WORKING_DAYS),
    }));
  };

  /* 删除已保存工程师 */
  const handleRemoveEngineer = (name: string) => {
    setEngineers((prev) => {
      const next = prev.filter((e) => e.name !== name);
      saveEngineers(next);
      return next;
    });
    // 如果删除的是当前筛选的工程师，同时清除筛选
    if (currentEngineer === name) {
      setCurrentEngineer('');
      saveScheduleFilter('');
    }
  };

  /* 提交时自动保存/更新工程师信息 */
  const persistEngineer = (name: string, email: string) => {
    setEngineers((prev) => {
      const idx = prev.findIndex((e) => e.name === name);
      let next: EngineerEntry[];
      if (idx >= 0) {
        next = [...prev];
        if (email) next[idx] = { ...next[idx], email };
      } else {
        next = [...prev, { name, email }];
      }
      saveEngineers(next);
      return next;
    });
  };

  /* 表单提交 */
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canWrite) { setError('仅管理员可增改验证计划'); return; }
    setError('');

    const name = form.engineer_name.trim();
    if (!name) { setError('请填写负责人'); return; }
    if (!form.start_date) { setError('请选择开始日期'); return; }
    if (!form.report_deadline) { setError('请选择报告截止日期'); return; }

    /* 编辑模式：仅第 1 个批次框生效；新增模式：4 个批次一组 */
    const batches = (editId !== null ? form.batches.slice(0, 1) : form.batches)
      .map((b) => b.trim())
      .filter(Boolean);
    if (batches.length === 0) { setError('请至少填写一个批次号'); return; }

    /* 组内批次号查重 */
    const seen = new Set<string>();
    for (const b of batches) {
      if (seen.has(b)) { setError(`批次号重复：${b}`); return; }
      seen.add(b);
    }

    /* 基准批次必须落在已填写的批次上 */
    const baselineBatch = form.baselineIndex !== null ? form.batches[form.baselineIndex]?.trim() : '';
    if (form.baselineIndex !== null && (!baselineBatch || !batches.includes(baselineBatch))) {
      setError('基准批次对应的批次号不能为空'); return;
    }

    /* 邮箱不再录入，自动沿用已保存负责人的邮箱（无则留空，保持数据兼容） */
    const email = engineers.find((en) => en.name === name)?.email ?? '';

    try {
      if (editId !== null) {
        await updateSchedule(editId, {
          batch_id: batches[0],
          engineer_name: name,
          engineer_email: email,
          start_date: form.start_date,
          report_deadline: form.report_deadline,
          status: form.status,
          notes: form.notes || null,
          // C2: 编辑模式下基准标记直接取 form.baselineIndex 是否选中
          is_baseline: form.baselineIndex !== null ? 1 : 0,
        });
        setMsg('验证计划条目已更新');
      } else {
        /* C1: 同组批次生成共享 group_id（时间戳+随机后缀） */
        const groupId = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        /* 一组批次逐条插入，共享负责人/日期/备注/group_id；选中者标记为基准 */
        for (let i = 0; i < form.batches.length; i++) {
          const b = form.batches[i].trim();
          if (!b) continue;
          await insertSchedule({
            batch_id: b,
            material_type: '',
            engineer_name: name,
            engineer_email: email,
            start_date: form.start_date,
            report_deadline: form.report_deadline,
            status: form.status,
            notes: form.notes || null,
            is_baseline: i === form.baselineIndex ? 1 : 0,
            group_id: groupId,
          });
        }
        setMsg(`已添加 ${batches.length} 条验证计划${baselineBatch ? `（基准：${baselineBatch}）` : ''}`);
      }
      persistEngineer(name, email);
      setForm(emptyForm());
      setDeadlineManual(false);
      setEditId(null);
      setItems(querySchedules());
      syncToCloud();
      setTimeout(() => setMsg(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  };

  /* 编辑 */
  const handleEdit = (item: ScheduleItem) => {
    setEditId(item.id);
    const next = emptyForm();
    setForm({
      ...next,
      batches: [item.batch_id, ...next.batches.slice(1)],
      baselineIndex: item.is_baseline ? 0 : null,
      engineer_name: item.engineer_name,
      start_date: item.start_date,
      report_deadline: item.report_deadline,
      status: item.status,
      notes: item.notes || '',
    });
    /* 已保存的截止日期与默认值不一致 → 视为手动指定，改开始日期时不覆盖 */
    setDeadlineManual(item.report_deadline !== addWorkingDays(item.start_date, DEADLINE_WORKING_DAYS));
    setError('');
    setMsg('');
  };

  /* 删除（C1: 支持 group_id 整组删除提示） */
  const handleDelete = async (item: ScheduleItem) => {
    if (!canWrite) { setError('仅管理员可删除验证计划'); return; }
    // 同组其他记录
    const groupSiblings = item.group_id
      ? querySchedules().filter((s) => s.group_id === item.group_id && s.id !== item.id)
      : [];
    if (groupSiblings.length > 0) {
      const batchList = groupSiblings.map((g) => g.batch_id).join('、');
      const choice = window.confirm(
        `该批次属于一组（同组：${batchList}）。\n点击「确定」删除整组，点击「取消」仅删除当前条目。\n（取消后在确认弹窗选择否可取消删除）`,
      );
      if (choice) {
        // 删除整组
        for (const g of groupSiblings) await deleteSchedule(g.id);
        await deleteSchedule(item.id);
      } else {
        if (!window.confirm(`仅删除 ${item.batch_id}？`)) return;
        await deleteSchedule(item.id);
      }
    } else {
      if (!window.confirm('确定删除该验证计划条目？')) return;
      await deleteSchedule(item.id);
    }
    setItems(querySchedules());
    syncToCloud();
    if (editId === item.id) {
      setEditId(null);
      setForm(emptyForm());
    }
  };

  /* 状态切换（C4: 同组状态联动——标记完成时提示是否整组完成） */
  const handleStatus = async (item: ScheduleItem) => {
    if (!canWrite) { setError('仅管理员可变更验证计划状态'); return; }
    const next: ScheduleItem['status'] =
      item.status === 'planned' ? 'in_progress' : item.status === 'in_progress' ? 'completed' : 'planned';
    await updateSchedule(item.id, { status: next });

    // C4: 标记完成且属于某组时，提示是否将同组全部标记完成
    if (next === 'completed' && item.group_id) {
      const groupItems = querySchedules().filter(
        (s) => s.group_id === item.group_id && s.id !== item.id && s.status !== 'completed',
      );
      if (groupItems.length > 0) {
        const batchList = groupItems.map((g) => g.batch_id).join('、');
        if (window.confirm(`同组批次 ${batchList} 尚未完成，是否一并标记为已完成？`)) {
          for (const g of groupItems) {
            await updateSchedule(g.id, { status: 'completed' });
          }
        }
      }
    }

    setItems(querySchedules());
    syncToCloud();
  };

  if (!dbReady) return <Loading text="数据库初始化中…" />;

  return (
    <div>
      <style>{`
        @keyframes cloud-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.08); }
        }
      `}</style>
      {/* 弹窗提醒 */}
      {showReminder && myDueItems.length > 0 && (
        <ReminderModal
          items={dueItems}
          currentEngineer={currentEngineer}
          onClose={() => setShowReminder(false)}
        />
      )}

      <PageHeader
        title="验证计划"
        description="器件验证任务安排与报告提交时间管理"
        actions={
          <button
            onClick={async () => {
              setMsg('正在同步…');
              setError('');
              await syncToCloud();
              setTimeout(() => {
                setMsg((prev) => {
                  if (prev === '正在同步…') return '';
                  return prev;
                });
              }, 500);
            }}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-60"
            title="同步验证计划到云端"
          >
            {/* 云朵 SVG 图标 */}
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={syncing ? 'animate-[cloud-pulse_1.2s_ease-in-out_infinite]' : ''}
            >
              <path d="M17.5 19H9a4.5 4.5 0 1 1 0-9h.1A5.5 5.5 0 0 1 19 6.5a5.5 5.5 0 0 1 .5 10.98" />
              {syncing && (
                <>
                  <path d="M12 2v2" className="animate-[spin_1.5s_linear_infinite]" style={{ transformOrigin: '12px 3px' }} />
                  <path d="M12 2v2" className="animate-[spin_1.5s_linear_infinite_0.5s]" style={{ transformOrigin: '12px 3px', opacity: 0.5 }} />
                </>
              )}
            </svg>
            {syncing ? '同步中…' : '同步云端'}
          </button>
        }
      />

      {/* 负责人筛选（仅影响查看范围，登录身份请在左侧边栏切换） */}
      {engineers.length > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5">
          <span className="text-xs font-medium text-slate-500">筛选负责人：</span>
          <select
            value={currentEngineer}
            onChange={(e) => {
              const v = e.target.value;
              setCurrentEngineer(v);
              saveScheduleFilter(v);
            }}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700"
          >
            <option value="">全部负责人</option>
            {engineers.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
          {currentEngineer && (
            <span className="text-xs text-slate-400">
              （仅显示 {currentEngineer} 的提醒和任务）
            </span>
          )}
          {myDueItems.length > 0 && !showReminder && (
            <Button variant="secondary" onClick={() => setShowReminder(true)}>
              查看提醒 ({myDueItems.length})
            </Button>
          )}
        </div>
      )}

      {/* 到期提醒横幅 */}
      {myDueItems.length > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50" bodyClassName="py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-amber-500" />
              <span className="text-sm font-medium text-amber-800">
                {myDueItems.length} 项任务到期/逾期
              </span>
              <span className="text-xs text-amber-600">
                {myDueItems.map((it) => `${it.batch_id}（${it.engineer_name}）`).join('、')}
              </span>
            </div>
            <Button variant="secondary" onClick={() => setShowReminder(true)}>
              查看提醒详情
            </Button>
          </div>
        </Card>
      )}

      {/* 时间轴 */}
      <Card title="时间轴" bodyClassName="p-0">
        <GanttChart items={items} />
      </Card>

      {/* 验证计划列表 */}
      <Card title="验证计划明细" className="mt-4" bodyClassName="px-0 py-0">
        {items.length === 0 ? (
          <EmptyState icon="calendar" title="暂无验证计划" description="点击下方表单添加第一条验证计划" />
        ) : (
          <div className="max-h-[400px] overflow-auto">
            <table className="data-table w-full">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th>批次</th>
                  <th>负责人</th>
                  <th>开始</th>
                  <th>截止</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it) => {
                  const overdue = it.status !== 'completed' && it.report_deadline < todayStr();
                  return (
                    <tr key={it.id} className={overdue ? 'bg-red-50' : ''}>
                      <td>
                        <span className="flex items-center justify-center gap-1.5">
                          <span className="font-mono font-medium">{it.batch_id}</span>
                          {!!it.is_baseline && (
                            <Badge tone="blue">基准</Badge>
                          )}
                        </span>
                      </td>
                      <td>{it.engineer_name}</td>
                      <td className="font-mono text-xs">{it.start_date}</td>
                      <td className={`font-mono text-xs ${overdue ? 'font-semibold text-red-600' : ''}`}>
                        {it.report_deadline}
                      </td>
                      <td>
                        <Badge
                          tone={
                            it.status === 'completed'
                              ? 'green'
                              : it.status === 'in_progress'
                                ? 'blue'
                                : overdue
                                  ? 'red'
                                  : 'slate'
                          }
                        >
                          {it.status === 'in_progress'
                            ? '进行中'
                            : it.status === 'completed'
                              ? '已完成'
                              : overdue
                                ? '逾期'
                                : '计划中'}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex items-center justify-center gap-1.5">
                          {canWrite && (
                            <>
                              <button
                                className="text-xs text-blue-600 hover:underline"
                                onClick={() => handleStatus(it)}
                              >
                                {it.status === 'planned'
                                  ? '开始'
                                  : it.status === 'in_progress'
                                    ? '完成'
                                    : '重置'}
                              </button>
                              <button
                                className="text-xs text-slate-500 hover:underline"
                                onClick={() => handleEdit(it)}
                              >
                                编辑
                              </button>
                              <button
                                className="text-xs text-red-500 hover:underline"
                                onClick={() => handleDelete(it)}
                              >
                                删除
                              </button>
                            </>
                          )}
                          {!canWrite && (
                            <span className="text-xs text-slate-400">只读</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 新增/编辑表单 */}
      {canWrite ? (
        <Card title={editId !== null ? '编辑验证计划' : '新增验证计划'} className="mt-4">
          <form onSubmit={handleSubmit} className="space-y-3">
            {/* 批次号组（新增：4 个一组紧凑排列 + 基准单选；编辑：单批次） */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">
                {editId !== null
                  ? '批次号'
                  : `批次号（${BATCH_GROUP_SIZE} 个一组，至少填写 1 个）`}
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                {(editId !== null ? [form.batches[0]] : form.batches).map((b, idx) => {
                  const i = editId !== null ? 0 : idx;
                  return (
                    <div key={i} className="flex items-center gap-1">
                      <input
                        type="text"
                        value={b}
                        onChange={(e) => {
                          const batches = [...form.batches];
                          batches[i] = e.target.value;
                          setForm({ ...form, batches });
                        }}
                        placeholder={`批次${i + 1}`}
                        className="w-[120px] rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                      />
                      <label
                        className="flex shrink-0 cursor-pointer select-none items-center gap-0.5 rounded px-1.5 py-1 text-[11px] text-slate-400 transition hover:bg-blue-50 hover:text-blue-600"
                        title="设为基准批次"
                      >
                        <input
                          type="radio"
                          name="baseline-batch"
                          className="accent-blue-600"
                          checked={form.baselineIndex === i}
                          onClick={() =>
                            setForm((prev) => ({
                              ...prev,
                              baselineIndex: prev.baselineIndex === i ? null : i,
                            }))
                          }
                          readOnly
                        />
                        基准
                      </label>
                    </div>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                同组批次共享负责人与日期；勾选「基准」标记基准批次
              </p>
            </div>

            <div className="grid grid-cols-4 gap-3">
              {/* 负责人 */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">负责人</label>
                <input
                  type="text"
                  list="engineer-name-list"
                  value={form.engineer_name}
                  onChange={(e) => setForm({ ...form, engineer_name: e.target.value })}
                  placeholder="输入姓名"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                />
                <datalist id="engineer-name-list">
                  {engineers.map((e) => (
                    <option key={e.name} value={e.name} />
                  ))}
                </datalist>
              </div>

              {/* 开始日期 */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">开始日期</label>
                <input
                  type="date"
                  value={form.start_date}
                  onChange={(e) => handleStartDate(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                />
              </div>

              {/* 报告截止日期 */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">截止日期</label>
                <input
                  type="date"
                  value={form.report_deadline}
                  onChange={(e) => {
                    setDeadlineManual(true);
                    setForm({ ...form, report_deadline: e.target.value });
                  }}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                />
                <div className="mt-0.5 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400">+3工作日</span>
                  {deadlineManual && form.start_date && (
                    <button
                      type="button"
                      className="text-[10px] text-blue-600 hover:underline"
                      onClick={() => {
                        setDeadlineManual(false);
                        setForm((prev) => ({
                          ...prev,
                          report_deadline: addWorkingDays(prev.start_date, DEADLINE_WORKING_DAYS),
                        }));
                      }}
                    >
                      恢复
                    </button>
                  )}
                </div>
              </div>

              {/* 备注 */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">备注</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="可选"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                />
              </div>
            </div>

          {/* 已保存负责人（自动记录，可删除） */}
          {engineers.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-slate-600">
                已保存负责人（提交时自动记录，点击 × 删除）
              </div>
              <div className="flex flex-wrap gap-2">
                {engineers.map((e) => (
                  <span
                    key={e.name}
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-1 pl-2.5 pr-1.5 text-xs text-slate-700"
                  >
                    <span className="font-medium">{e.name}</span>
                    <button
                      type="button"
                      title={`删除 ${e.name}`}
                      className="flex h-4 w-4 items-center justify-center rounded-full text-slate-400 hover:bg-red-100 hover:text-red-600"
                      onClick={() => handleRemoveEngineer(e.name)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}
          {msg && <p className="text-xs text-emerald-600">{msg}</p>}

          <div className="flex items-center gap-3">
            <Button type="submit">
              {editId !== null ? '更新验证计划' : '添加验证计划'}
            </Button>
            {editId !== null && (
              <Button
                variant="secondary"
                onClick={() => {
                  setEditId(null);
                  setForm(emptyForm());
                  setDeadlineManual(false);
                  setError('');
                }}
              >
                取消编辑
              </Button>
            )}
          </div>
        </form>
        </Card>
      ) : (
        <Card title="新增验证计划" className="mt-4">
          <div className="flex items-center gap-3 rounded-lg border border-amber-100 bg-amber-50/50 px-4 py-3 text-sm text-amber-700">
            <span className="text-base">🔒</span>
            <span>
              当前为<b>工程师</b>身份，仅可查看验证计划。如需增删改，请联系管理员。
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}