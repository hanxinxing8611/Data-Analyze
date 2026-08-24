import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useData } from '../store/DataContext';
import { useCriteria } from '../store/CriteriaContext';
import { queryDashboardStats, resetDB } from '../database/db';
import { exportDatabaseBackup, importDatabaseBackup, importSharedSnapshot } from '../database/backup';
import { Button, Card, PageHeader } from '../components/ui';
import Icon from '../components/layout/Icon';
import {
  DEFAULT_THRESHOLDS,
  criteriaText,
  type CriteriaThresholds,
} from '../report/reportData';

/** 系统设置访问密码（防误改，非安全加密） */
const SETTINGS_PASSWORD = '000000';
/** 解锁状态会话内有效（关闭标签页后失效），刷新页面不重复输入 */
const UNLOCKED_KEY = 'dv-settings-unlocked';

/** 数值输入框状态 */
interface NumberField {
  value: string;
  error: string;
}

function emptyField(n: number): NumberField {
  return { value: String(n), error: '' };
}

/* ================= 密码解锁遮罩 ================= */

function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [pwd, setPwd] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pwd === SETTINGS_PASSWORD) {
      try {
        sessionStorage.setItem(UNLOCKED_KEY, '1');
      } catch {
        // sessionStorage 不可用时跳过记忆
      }
      onUnlock();
    } else {
      setError('密码错误，请重试');
      setPwd('');
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <form
        onSubmit={submit}
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-8 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_16px_40px_-16px_rgba(15,23,42,0.16)]"
      >
        {/* 顶部柔光 */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-28"
          style={{
            background:
              'radial-gradient(240px 90px at 50% -30px, rgba(37,99,235,0.10), transparent 70%)',
          }}
        />
        <div className="relative flex flex-col items-center text-center">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg shadow-blue-600/25"
            style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #22d3ee 130%)' }}
          >
            <Icon name="lock" className="h-6 w-6" strokeWidth={2.2} />
          </div>
          <h2 className="mt-4 text-base font-semibold tracking-tight text-slate-800">
            系统设置已锁定
          </h2>
          <p className="mt-1.5 text-xs leading-5 text-slate-500">
            统计口径等参数会影响全部报告统计结果，请输入访问密码
          </p>
        </div>
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pwd}
          onChange={(e) => {
            setPwd(e.target.value);
            setError('');
          }}
          placeholder="请输入密码"
          className={`mt-6 w-full rounded-lg border px-4 py-2.5 text-center font-mono text-lg tracking-[0.5em] outline-none transition-colors ${
            error
              ? 'border-red-300 bg-red-50 focus:border-red-400'
              : 'border-slate-300 focus:border-blue-500'
          }`}
        />
        {error && <p className="mt-2 text-center text-xs text-red-500">{error}</p>}
        <button
          type="submit"
          className="mt-5 w-full rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 py-2.5 text-sm font-medium text-white shadow-sm shadow-blue-600/25 transition-all duration-150 hover:to-blue-700 active:scale-[0.99]"
        >
          解锁
        </button>
      </form>
    </div>
  );
}

/* ================= 统计口径表单 ================= */

function CriteriaForm() {
  const { thresholds, saveThresholds, resetThresholds } = useCriteria();
  const [verdictMode, setVerdictMode] = useState(thresholds.verdictMode);
  const [verdictTh, setVerdictTh] = useState<NumberField>(
    () => emptyField(thresholds.verdictThreshold),
  );
  const [pceMin, setPceMin] = useState<NumberField>(() => emptyField(thresholds.pceMin));
  const [ffMin, setFfMin] = useState<NumberField>(() => emptyField(thresholds.ffMin));
  const [resistanceMin, setResistanceMin] = useState<NumberField>(
    () => emptyField(thresholds.resistanceMin),
  );
  const [saved, setSaved] = useState(false);

  const dirty =
    verdictMode !== thresholds.verdictMode ||
    verdictTh.value !== String(thresholds.verdictThreshold) ||
    pceMin.value !== String(thresholds.pceMin) ||
    ffMin.value !== String(thresholds.ffMin) ||
    resistanceMin.value !== String(thresholds.resistanceMin);

  /** 校验并提交；返回是否成功 */
  const validate = (f: NumberField, min: number, max: number, label: string): NumberField => {
    const n = parseFloat(f.value);
    if (f.value.trim() === '' || isNaN(n)) return { ...f, error: `${label}须为数值` };
    if (n < min || n > max) return { ...f, error: `取值范围 ${min} ~ ${max}` };
    return { value: f.value, error: '' };
  };

  const handleSave = () => {
    const vt = validate(verdictTh, -100, 100, 'Δ 阈值');
    const pc = validate(pceMin, 0, 100, 'PCE 下限');
    const ff = validate(ffMin, 0, 1, 'FF 下限');
    const rs = validate(resistanceMin, 0, 1e9, '电阻下限');
    setVerdictTh(vt);
    setPceMin(pc);
    setFfMin(ff);
    setResistanceMin(rs);
    if (vt.error || pc.error || ff.error || rs.error) return;

    const next: CriteriaThresholds = {
      verdictMode,
      verdictThreshold: parseFloat(vt.value),
      pceMin: parseFloat(pc.value),
      ffMin: parseFloat(ff.value),
      resistanceMin: parseFloat(rs.value),
    };
    saveThresholds(next);
    setVerdictTh(emptyField(next.verdictThreshold));
    setPceMin(emptyField(next.pceMin));
    setFfMin(emptyField(next.ffMin));
    setResistanceMin(emptyField(next.resistanceMin));
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const handleReset = () => {
    resetThresholds();
    setVerdictMode(DEFAULT_THRESHOLDS.verdictMode);
    setVerdictTh(emptyField(DEFAULT_THRESHOLDS.verdictThreshold));
    setPceMin(emptyField(DEFAULT_THRESHOLDS.pceMin));
    setFfMin(emptyField(DEFAULT_THRESHOLDS.ffMin));
    setResistanceMin(emptyField(DEFAULT_THRESHOLDS.resistanceMin));
  };

  const fieldCls = (err: string) =>
    `w-32 rounded-lg border px-3 py-2 text-right font-mono text-sm outline-none transition-colors ${
      err ? 'border-red-300 bg-red-50 focus:border-red-400' : 'border-slate-300 focus:border-blue-500'
    }`;

  return (
    <Card
      title="统计口径设置"
      extra={<span className="text-[11px] text-slate-400">修改后全部报告统计实时重算</span>}
    >
      <div className="space-y-4">
        <p className="text-sm leading-6 text-slate-600">
          全部统计基于各批次有效测试记录；「有效 X/Y」= 符合口径反扫数 / 反扫总数。
          当前口径：
          <span className="ml-1 rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">
            {criteriaText(thresholds)}
          </span>
        </p>

        {/* 有效测试记录判定阈值 */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-4 py-3">
          <div className="mb-2 text-sm font-medium text-slate-700">有效测试记录判定</div>
          <p className="mb-3 text-[11px] leading-4 text-slate-400">
            反扫记录需同时满足以下条件才算有效测试记录；修改后全部报告统计实时重算
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">PCE 下限（%）</span>
              <input
                type="number"
                step="any"
                value={pceMin.value}
                onChange={(e) => setPceMin({ value: e.target.value, error: '' })}
                className={fieldCls(pceMin.error)}
              />
              {pceMin.error && <span className="text-xs text-red-500">{pceMin.error}</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">FF 下限</span>
              <input
                type="number"
                step="any"
                value={ffMin.value}
                onChange={(e) => setFfMin({ value: e.target.value, error: '' })}
                className={fieldCls(ffMin.error)}
              />
              {ffMin.error && <span className="text-xs text-red-500">{ffMin.error}</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">电阻下限（Ω，Rs/Rsh &gt;）</span>
              <input
                type="number"
                step="any"
                value={resistanceMin.value}
                onChange={(e) => setResistanceMin({ value: e.target.value, error: '' })}
                className={fieldCls(resistanceMin.error)}
              />
              {resistanceMin.error && (
                <span className="text-xs text-red-500">{resistanceMin.error}</span>
              )}
            </div>
          </div>
        </div>

        {/* 优秀判定逻辑 */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-4 py-3">
          <div className="mb-2 text-sm font-medium text-slate-700">优秀批次判定</div>
          <p className="mb-3 text-[11px] leading-4 text-slate-400">
            对比批次与 Baseline 比较时，满足以下条件即判定为「优秀」；否则为「不合格」
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="radio"
                  name="verdictMode"
                  checked={verdictMode === 'champion_and_median'}
                  onChange={() => setVerdictMode('champion_and_median')}
                  className="text-blue-600"
                />
                冠军 Δ&gt;0 且 中位 Δ&gt;0
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="radio"
                  name="verdictMode"
                  checked={verdictMode === 'champion_only'}
                  onChange={() => setVerdictMode('champion_only')}
                  className="text-blue-600"
                />
                仅冠军 Δ&gt;0
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="radio"
                  name="verdictMode"
                  checked={verdictMode === 'median_only'}
                  onChange={() => setVerdictMode('median_only')}
                  className="text-blue-600"
                />
                仅中位 Δ&gt;0
              </label>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">Δ 阈值</span>
              <input
                type="number"
                step="any"
                value={verdictTh.value}
                onChange={(e) => setVerdictTh({ value: e.target.value, error: '' })}
                className={fieldCls(verdictTh.error)}
              />
              {verdictTh.error && (
                <span className="text-xs text-red-500">{verdictTh.error}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 pt-4">
          <p className="text-xs text-slate-400">
            {saved ? (
              <span className="text-emerald-600">已保存，报告页与导出将使用新口径</span>
            ) : dirty ? (
              <span className="text-amber-600">有未保存的修改</span>
            ) : (
              '配置持久化于本浏览器，默认：PCE≥15%、FF≥0.5、Rs/Rsh>0Ω，冠军 Δ>0 且 中位 Δ>0'
            )}
          </p>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={handleReset}>
              恢复默认
            </Button>
            <Button onClick={handleSave}>保存口径</Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ================= 数据库备份卡片 ================= */

function BackupCard() {
  const { refresh } = useData();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'export' | 'import' | 'pull' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const summarize = (s: {
    material_batch: number;
    sample_record: number;
    iv_curve_data: number;
    report_metadata: number;
  }) =>
    `${s.material_batch} 批次 / ${s.sample_record} 样本 / ${s.iv_curve_data} 曲线点 / ${s.report_metadata} 报告模板`;

  const handleExport = async () => {
    setBusy('export');
    setMsg(null);
    try {
      const summary = await exportDatabaseBackup();
      setMsg({ tone: 'success', text: `备份已导出：${summarize(summary)}` });
    } catch (e) {
      setMsg({ tone: 'error', text: `导出失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const handleFile = async (file: File) => {
    const stats = queryDashboardStats();
    const ok = window.confirm(
      `将使用「${file.name}」替换当前全部数据\n` +
        `（当前：${stats.totalBatches} 批次 / ${stats.totalSamples} 样本）。\n` +
        '此操作会先清空现有数据再导入备份，确定继续吗？',
    );
    if (!ok) return;
    setBusy('import');
    setMsg(null);
    try {
      const summary = await importDatabaseBackup(file);
      refresh();
      setMsg({ tone: 'success', text: `备份已导入：${summarize(summary)}` });
    } catch (e) {
      setMsg({
        tone: 'error',
        text: `导入失败（数据未改动）：${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handlePullShared = async () => {
    const stats = queryDashboardStats();
    const ok = window.confirm(
      '将从站点共享数据快照（public/shared/data-latest.xlsx）拉取并替换当前全部数据\n' +
        `（当前：${stats.totalBatches} 批次 / ${stats.totalSamples} 样本）。\n` +
        '此操作会先清空现有数据再导入共享数据，确定继续吗？',
    );
    if (!ok) return;
    setBusy('pull');
    setMsg(null);
    try {
      const summary = await importSharedSnapshot();
      refresh();
      setMsg({ tone: 'success', text: `共享数据已拉取：${summarize(summary)}` });
    } catch (e) {
      setMsg({
        tone: 'error',
        text: `拉取失败（数据未改动）：${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="数据库备份" extra={<span className="text-[11px] text-slate-400">Excel 工作簿（.xlsx）</span>}>
      <div className="space-y-4">
        <p className="text-sm leading-6 text-slate-600">
          导出全部数据（材料批次、样本记录、IV 曲线、报告文字模板）为 Excel 工作簿，
          可用于定期备份或将数据迁移到其他设备；导入时会替换当前全部数据。
          也可直接拉取维护者发布在站点上的共享数据快照。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleExport} disabled={busy !== null}>
            {busy === 'export' ? '导出中…' : '导出备份'}
          </Button>
          <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
            {busy === 'import' ? '导入中…' : '导入备份'}
          </Button>
          <Button variant="secondary" onClick={handlePullShared} disabled={busy !== null}>
            {busy === 'pull' ? '拉取中…' : '拉取共享数据'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
          {msg && (
            <span className={`text-xs ${msg.tone === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
              {msg.text}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-400">
          注意：仅支持本系统导出的 .xlsx 备份；旧版 .xls 文件请先用 Excel 另存为 .xlsx 再导入。
          「拉取共享数据」依赖维护者发布的共享快照（未发布时会给出提示，本地数据不受影响）。
        </p>
      </div>
    </Card>
  );
}

/* ================= 设置页主体 ================= */

export default function Settings() {
  const { refresh } = useData();
  const [unlocked, setUnlocked] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(UNLOCKED_KEY) === '1') setUnlocked(true);
    } catch {
      // sessionStorage 不可用时保持锁定
    }
  }, []);

  const handleReset = async () => {
    if (!window.confirm('确认清空全部数据？所有批次、样本与曲线数据将被删除，此操作不可撤销。')) {
      return;
    }
    await resetDB();
    refresh();
    setCleared(true);
    setTimeout(() => setCleared(false), 3000);
  };

  if (!unlocked) {
    return (
      <div>
        <PageHeader title="系统设置" description="数据管理与系统参数配置" />
        <PasswordGate onUnlock={() => setUnlocked(true)} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="系统设置" description="数据管理与系统参数配置" />

      <div className="space-y-6">
        <CriteriaForm />

        <BackupCard />

        <Card title="数据存储">
          <div className="space-y-3 text-sm text-slate-600">
            <p>
              数据以 SQLite 格式存储于浏览器 IndexedDB 中，全部在本地运行，不会上传到任何服务器。
              每次数据变更后自动保存，关闭页面不会丢失数据。
            </p>
            <p className="text-xs text-slate-400">
              注意：清除浏览器站点数据（Cookie / 站点数据）会同时删除已导入的数据库，请谨慎操作。
            </p>
          </div>
        </Card>

        <Card title="危险操作">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700">清空全部数据</p>
              <p className="mt-0.5 text-xs text-slate-400">
                删除所有材料批次、样本记录与 IV 曲线数据，数据库结构保留
              </p>
            </div>
            <Button variant="danger" onClick={handleReset}>
              {cleared ? '已清空' : '清空数据'}
            </Button>
          </div>
        </Card>

        <Card title="规划功能（后续阶段）">
          <ul className="space-y-2 text-sm text-slate-500">
            <li>· 操作员信息管理与默认报告人设置</li>
            <li>· 报告模板管理</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
