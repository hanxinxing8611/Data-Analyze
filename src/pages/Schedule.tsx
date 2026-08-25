import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useData } from '../store/DataContext';
import { useCriteria } from '../store/CriteriaContext';
import {
  querySchedules,
  querySamples,
  insertSchedule,
  updateSchedule,
  deleteSchedule,
  replaceAllSchedules,
} from '../database/db';
import { fetchCloudSchedule, pushCloudSchedule } from '../utils/cloudSchedule';
import { computeTaskStats, pushCloudTaskStats } from '../utils/cloudTaskStats';
import { usePermission } from '../utils/permissions';
import { Button, Card, EmptyState, Loading, PageHeader, Badge } from '../components/ui';
import GanttChart from '../components/charts/GanttChart';
import type { ScheduleItem } from '../types';

/* ---- 产品名称选项 ---- */

const PRODUCT_OPTIONS = [
  'α-FAPbI3',
  'MAPbI3',
  'CsPbI3',
  'FAPbBr3',
  'MAPbBr3',
  'CsPbBr3',
  'δ-FAPbI3',
  'PbI2',
  'C60',
];

/* ---- 工程师列表（本地自动保存） ---- */

const ENGINEERS_KEY = 'dv-engineers';

interface EngineerEntry {
  name: string;
  email: string;
}

function loadEngineers(): EngineerEntry[] {
  try {
    const raw = localStorage.getItem(ENGINEERS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is EngineerEntry =>
        !!e && typeof (e as EngineerEntry).name === 'string',
    );
  } catch {
    return [];
  }
}

function saveEngineers(list: EngineerEntry[]): void {
  try {
    localStorage.setItem(ENGINEERS_KEY, JSON.stringify(list));
  } catch {
    /* 存储失败时忽略 */
  }
}

/* ---- 当前工程师（本地存储） ---- */

const CURRENT_ENGINEER_KEY = 'dv-current-engineer';

function loadCurrentEngineer(): string {
  try {
    return localStorage.getItem(CURRENT_ENGINEER_KEY) || '';
  } catch {
    return '';
  }
}

function saveCurrentEngineer(name: string): void {
  try {
    localStorage.setItem(CURRENT_ENGINEER_KEY, name);
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

/* ---- 表单初始值 ---- */

function emptyForm(): {
  batch_id: string;
  material_type: string;
  engineer_name: string;
  engineer_email: string;
  start_date: string;
  status: ScheduleItem['status'];
  notes: string;
} {
  return {
    batch_id: '',
    material_type: '',
    engineer_name: '',
    engineer_email: '',
    start_date: todayStr(),
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
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [showReminder, setShowReminder] = useState(false);
  const { canWrite, engineerName } = usePermission();

  useEffect(() => {
    if (!dbReady) return;
    setItems(querySchedules());
  }, [dbReady, version]);

  useEffect(() => {
    setEngineers(loadEngineers());
    setCurrentEngineer(loadCurrentEngineer());
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

  /* 页面挂载时从云端拉取最新验证计划（其他工程师可能已更新） */
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const cloud = await fetchCloudSchedule();
        if (!cloud || cancelled) return;
        if (cloud.length > 0) {
          await replaceAllSchedules(cloud);
          setItems(querySchedules());
        }
      } catch {
        // 静默
      }
    })();
    return () => { cancelled = true; };
  }, [dbReady]);

  /* 推送本地排产数据到云端，同时推送任务统计 */
  const syncToCloud = async () => {
    const all = querySchedules();
    const payload = all.map(({ id, created_at, ...rest }) => rest);
    const result = await pushCloudSchedule(payload);
    if (result.ok) {
      setMsg('已同步云端');
      setTimeout(() => setMsg(''), 3000);
    } else if (result.message === 'not-configured') {
      // 未配置 Token，静默（仅本地操作）
    } else {
      setError(`云端同步失败：${result.message}`);
    }

    // 同步推送任务统计（基于当前本地样本数据计算）
    try {
      const samples = querySamples();
      const stats = computeTaskStats(all, samples, thresholds);
      await pushCloudTaskStats(stats);
    } catch {
      // 任务统计推送失败不影响主流程
    }
  };

  /* 工程师姓名输入：精确匹配已保存工程师时自动带出邮箱 */
  const handleEngineerName = (name: string) => {
    const found = engineers.find((e) => e.name === name);
    setForm((prev) => ({
      ...prev,
      engineer_name: name,
      engineer_email: found && found.email ? found.email : prev.engineer_email,
    }));
  };

  /* 删除已保存工程师 */
  const handleRemoveEngineer = (name: string) => {
    setEngineers((prev) => {
      const next = prev.filter((e) => e.name !== name);
      saveEngineers(next);
      return next;
    });
    // 如果删除的是当前选择的工程师，同时清除选择
    if (currentEngineer === name) {
      setCurrentEngineer('');
      saveCurrentEngineer('');
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
    if (!form.batch_id.trim()) { setError('请填写批次号'); return; }
    if (!form.material_type) { setError('请选择产品名称'); return; }
    if (!form.engineer_name.trim()) { setError('请填写工程师姓名'); return; }
    if (!form.engineer_email.trim()) { setError('请填写工程师邮箱'); return; }
    if (!form.start_date) { setError('请选择开始日期'); return; }

    const deadline = addWorkingDays(form.start_date, 2);

    try {
      if (editId !== null) {
        await updateSchedule(editId, {
          batch_id: form.batch_id.trim(),
          material_type: form.material_type,
          engineer_name: form.engineer_name.trim(),
          engineer_email: form.engineer_email.trim(),
          start_date: form.start_date,
          report_deadline: deadline,
          status: form.status,
          notes: form.notes || null,
        });
        setMsg('验证计划条目已更新');
      } else {
        await insertSchedule({
          batch_id: form.batch_id.trim(),
          material_type: form.material_type,
          engineer_name: form.engineer_name.trim(),
          engineer_email: form.engineer_email.trim(),
          start_date: form.start_date,
          report_deadline: deadline,
          status: form.status,
          notes: form.notes || null,
        });
        setMsg('验证计划条目已添加');
      }
      persistEngineer(form.engineer_name.trim(), form.engineer_email.trim());
      setForm(emptyForm());
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
    setForm({
      batch_id: item.batch_id,
      material_type: item.material_type,
      engineer_name: item.engineer_name,
      engineer_email: item.engineer_email,
      start_date: item.start_date,
      status: item.status,
      notes: item.notes || '',
    });
    setError('');
    setMsg('');
  };

  /* 删除 */
  const handleDelete = async (id: number) => {
    if (!canWrite) { setError('仅管理员可删除验证计划'); return; }
    if (!window.confirm('确定删除该验证计划条目？')) return;
    await deleteSchedule(id);
    setItems(querySchedules());
    syncToCloud();
    if (editId === id) {
      setEditId(null);
      setForm(emptyForm());
    }
  };

  /* 状态切换 */
  const handleStatus = async (item: ScheduleItem) => {
    if (!canWrite) { setError('仅管理员可变更验证计划状态'); return; }
    const next: ScheduleItem['status'] =
      item.status === 'planned' ? 'in_progress' : item.status === 'in_progress' ? 'completed' : 'planned';
    await updateSchedule(item.id, { status: next });
    setItems(querySchedules());
    syncToCloud();
  };

  if (!dbReady) return <Loading text="数据库初始化中…" />;

  /* 旧数据的产品名称可能不在固定选项中，编辑时动态补充显示 */
  const extraProduct =
    form.material_type && !PRODUCT_OPTIONS.includes(form.material_type)
      ? form.material_type
      : null;

  return (
    <div>
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
          <Button variant="secondary" onClick={async () => {
            setMsg('正在同步…');
            await syncToCloud();
          }}>
            同步云端
          </Button>
        }
      />

      {/* 当前工程师选择器 */}
      {engineers.length > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5">
          <span className="text-xs font-medium text-slate-500">当前工程师：</span>
          <select
            value={currentEngineer}
            onChange={(e) => {
              const v = e.target.value;
              setCurrentEngineer(v);
              saveCurrentEngineer(v);
            }}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700"
          >
            <option value="">全部工程师</option>
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
                  <th>产品名称</th>
                  <th>工程师</th>
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
                      <td className="font-mono font-medium">{it.batch_id}</td>
                      <td>{it.material_type}</td>
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
                        <div className="flex items-center gap-1.5">
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
                                onClick={() => handleDelete(it.id)}
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
          <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {/* 批次号（手工录入） */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">批次号</label>
              <input
                type="text"
                value={form.batch_id}
                onChange={(e) => setForm({ ...form, batch_id: e.target.value })}
                placeholder="手工录入，例如：CB615W1"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            {/* 产品名称（下拉选择） */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">产品名称</label>
              <select
                value={form.material_type}
                onChange={(e) => setForm({ ...form, material_type: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">请选择产品名称</option>
                {extraProduct && <option value={extraProduct}>{extraProduct}</option>}
                {PRODUCT_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            {/* 工程师（可输入 + 已保存建议） */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">工程师姓名</label>
              <input
                type="text"
                list="engineer-name-list"
                value={form.engineer_name}
                onChange={(e) => handleEngineerName(e.target.value)}
                placeholder="输入姓名，可从已保存工程师中选择"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <datalist id="engineer-name-list">
                {engineers.map((e) => (
                  <option key={e.name} value={e.name} />
                ))}
              </datalist>
            </div>

            {/* 邮箱 */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">工程师邮箱</label>
              <input
                type="email"
                value={form.engineer_email}
                onChange={(e) => setForm({ ...form, engineer_email: e.target.value })}
                placeholder="例如：zhangsan@example.com"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            {/* 开始日期 */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                验证计划开始日期
              </label>
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            {/* 截止日期（自动计算，仅展示） */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                报告截止日期（自动）
              </label>
              <input
                type="text"
                readOnly
                value={form.start_date ? addWorkingDays(form.start_date, 2) : '—'}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500"
              />
            </div>

            {/* 状态 */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">状态</label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as ScheduleItem['status'] })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="planned">计划中</option>
                <option value="in_progress">进行中</option>
                <option value="completed">已完成</option>
              </select>
            </div>

            {/* 备注 */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">备注</label>
              <input
                type="text"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="可选备注"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* 已保存工程师（自动记录，可删除） */}
          {engineers.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-slate-600">
                已保存工程师（提交时自动记录，点击 × 删除）
              </div>
              <div className="flex flex-wrap gap-2">
                {engineers.map((e) => (
                  <span
                    key={e.name}
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-1 pl-2.5 pr-1.5 text-xs text-slate-700"
                  >
                    <span className="font-medium">{e.name}</span>
                    {e.email && <span className="text-slate-400">{e.email}</span>}
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