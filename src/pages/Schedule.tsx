import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useData } from '../store/DataContext';
import {
  querySchedules,
  insertSchedule,
  updateSchedule,
  deleteSchedule,
  queryBatches,
} from '../database/db';
import { loadMailRecipients } from '../utils/mailRecipients';
import { Button, Card, EmptyState, Loading, PageHeader, Badge } from '../components/ui';
import GanttChart from '../components/charts/GanttChart';
import type { ScheduleItem } from '../types';

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

/* ---- 提醒邮件正文 ---- */

function buildReminderText(items: ScheduleItem[]): string {
  const lines = ['您好，以下器件验证报告已到期或即将到期，请及时提交：', ''];
  for (const it of items) {
    const overdue = it.status !== 'completed' && it.report_deadline < todayStr();
    const tag = overdue ? '【逾期】' : '【今日到期】';
    lines.push(
      `${tag} ${it.batch_id}（${it.material_type}）— 截止日期：${it.report_deadline}，负责人：${it.engineer_name}`,
    );
  }
  lines.push('');
  lines.push('请登录器件验证系统 → 报告生成页提交报告。');
  lines.push('本提醒由器件验证排产计划自动生成');
  return lines.join('\n');
}

export default function Schedule() {
  const { dbReady, version } = useData();
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [batches, setBatches] = useState<{ batch_id: string; material_type: string }[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!dbReady) return;
    setItems(querySchedules());
    setBatches(queryBatches().map((b) => ({ batch_id: b.batch_id, material_type: b.material_type })));
  }, [dbReady, version]);

  /* 逾期/到期提醒列表 */
  const dueItems = useMemo(() => {
    const today = todayStr();
    return items.filter(
      (it) => it.status !== 'completed' && it.report_deadline <= today,
    );
  }, [items]);

  /* 表单提交 */
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.batch_id.trim()) { setError('请选择批次'); return; }
    if (!form.engineer_name.trim()) { setError('请填写工程师姓名'); return; }
    if (!form.engineer_email.trim()) { setError('请填写工程师邮箱'); return; }
    if (!form.start_date) { setError('请选择开始日期'); return; }

    const deadline = addWorkingDays(form.start_date, 2);

    try {
      if (editId !== null) {
        await updateSchedule(editId, {
          batch_id: form.batch_id,
          material_type: form.material_type,
          engineer_name: form.engineer_name,
          engineer_email: form.engineer_email,
          start_date: form.start_date,
          report_deadline: deadline,
          status: form.status,
          notes: form.notes || null,
        });
        setMsg('排产条目已更新');
      } else {
        await insertSchedule({
          batch_id: form.batch_id,
          material_type: form.material_type,
          engineer_name: form.engineer_name,
          engineer_email: form.engineer_email,
          start_date: form.start_date,
          report_deadline: deadline,
          status: form.status,
          notes: form.notes || null,
        });
        setMsg('排产条目已添加');
      }
      setForm(emptyForm());
      setEditId(null);
      setItems(querySchedules());
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
    if (!window.confirm('确定删除该排产条目？')) return;
    await deleteSchedule(id);
    setItems(querySchedules());
    if (editId === id) {
      setEditId(null);
      setForm(emptyForm());
    }
  };

  /* 状态切换 */
  const handleStatus = async (item: ScheduleItem) => {
    const next: ScheduleItem['status'] =
      item.status === 'planned' ? 'in_progress' : item.status === 'in_progress' ? 'completed' : 'planned';
    await updateSchedule(item.id, { status: next });
    setItems(querySchedules());
  };

  /* 发送提醒 */
  const handleRemind = (single?: ScheduleItem) => {
    const targets = single ? [single] : dueItems;
    if (targets.length === 0) return;
    const body = buildReminderText(targets);
    const emails = targets.map((t) => t.engineer_email).filter(Boolean);
    const recipients = [...new Set(emails)].join(',');
    const subject = single
      ? `器件验证报告提交提醒 - ${single.batch_id}（${single.material_type}）`
      : `器件验证报告提交提醒 - ${targets.length} 项到期/逾期`;
    const mailto = `mailto:${recipients}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(mailto, '_blank');
  };

  if (!dbReady) return <Loading text="数据库初始化中…" />;

  return (
    <div>
      <PageHeader
        title="排产计划"
        description="器件验证排产与报告提交时间管理"
      />

      {/* 到期提醒 */}
      {dueItems.length > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50" bodyClassName="py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-amber-500" />
              <span className="text-sm font-medium text-amber-800">
                {dueItems.length} 项任务到期/逾期
              </span>
              <span className="text-xs text-amber-600">
                {dueItems.map((it) => `${it.batch_id}（${it.engineer_name}）`).join('、')}
              </span>
            </div>
            <Button variant="secondary" onClick={() => handleRemind()}>
              发送提醒邮件
            </Button>
          </div>
        </Card>
      )}

      {/* 时间轴 */}
      <Card title="时间轴" bodyClassName="p-0">
        <GanttChart items={items} />
      </Card>

      {/* 排产列表 */}
      <Card title="排产明细" className="mt-4" bodyClassName="px-0 py-0">
        {items.length === 0 ? (
          <EmptyState icon="calendar" title="暂无排产计划" description="点击下方表单添加第一条排产" />
        ) : (
          <div className="max-h-[400px] overflow-auto">
            <table className="data-table w-full">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th>批次</th>
                  <th>材料</th>
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
                          <button
                            className="text-xs text-amber-600 hover:underline"
                            onClick={() => handleRemind(it)}
                          >
                            提醒
                          </button>
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
      <Card title={editId !== null ? '编辑排产' : '新增排产'} className="mt-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {/* 批次选择 */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">批次</label>
              <select
                value={form.batch_id}
                onChange={(e) => {
                  const b = batches.find((x) => x.batch_id === e.target.value);
                  setForm({ ...form, batch_id: e.target.value, material_type: b?.material_type || '' });
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">请选择批次</option>
                {batches.map((b) => (
                  <option key={b.batch_id} value={b.batch_id}>
                    {b.batch_id}（{b.material_type}）
                  </option>
                ))}
              </select>
            </div>

            {/* 材料类型 */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">材料类型</label>
              <input
                type="text"
                value={form.material_type}
                onChange={(e) => setForm({ ...form, material_type: e.target.value })}
                placeholder="自动带出，可手动修改"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            {/* 工程师 */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">工程师姓名</label>
              <input
                type="text"
                value={form.engineer_name}
                onChange={(e) => setForm({ ...form, engineer_name: e.target.value })}
                placeholder="例如：张三"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
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

          {error && <p className="text-xs text-red-500">{error}</p>}
          {msg && <p className="text-xs text-emerald-600">{msg}</p>}

          <div className="flex items-center gap-3">
            <Button type="submit">
              {editId !== null ? '更新排产' : '添加排产'}
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
    </div>
  );
}