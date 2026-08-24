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
import {
  isValidEmail,
  loadMailRecipients,
  saveMailRecipients,
} from '../utils/mailRecipients';
import {
  applyCloudSettings,
  fetchCloudSettings,
  loadCloudConfig,
  loadCloudSyncInfo,
  saveCloudConfig,
  syncSettingsToCloud,
  type CloudConfig,
  type CloudSyncInfo,
} from '../utils/cloudSettings';

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
  /** 云端同步结果提示（保存后显示） */
  const [cloudMsg, setCloudMsg] = useState('');

  /** 外部更新（云端拉取应用）时同步表单显示 */
  useEffect(() => {
    setVerdictMode(thresholds.verdictMode);
    setVerdictTh(emptyField(thresholds.verdictThreshold));
    setPceMin(emptyField(thresholds.pceMin));
    setFfMin(emptyField(thresholds.ffMin));
    setResistanceMin(emptyField(thresholds.resistanceMin));
  }, [thresholds]);

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

    // 已配置云端共享时推送（收件人按共享开关一并打包）
    const cfg = loadCloudConfig();
    if (cfg.token) {
      setCloudMsg('正在同步云端…');
      void syncSettingsToCloud().then((r) => {
        if (r.ok) {
          setCloudMsg('已同步云端，其他工程师下次打开页面即生效');
        } else if (r.message === 'nothing') {
          setCloudMsg('已保存（本机）——云端共享未勾选任何项目');
        } else {
          setCloudMsg(`已保存（本机），云端同步失败：${r.message}`);
        }
        setTimeout(() => setCloudMsg(''), 6000);
      });
    }
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
          <div className="min-w-0">
            <p className="text-xs text-slate-400">
              {saved ? (
                <span className="text-emerald-600">已保存，报告页与导出将使用新口径</span>
              ) : dirty ? (
                <span className="text-amber-600">有未保存的修改</span>
              ) : (
                '配置持久化于本浏览器，默认：PCE≥15%、FF≥0.5、Rs/Rsh>0Ω，冠军 Δ>0 且 中位 Δ>0'
              )}
            </p>
            {cloudMsg && (
              <p className={`mt-0.5 text-xs ${cloudMsg.includes('失败') ? 'text-red-500' : 'text-blue-600'}`}>
                {cloudMsg}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
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

/* ================= 默认收件人管理 ================= */

function MailRecipientsCard() {
  const [list, setList] = useState<string[]>(() => loadMailRecipients());
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [cloudMsg, setCloudMsg] = useState('');

  /** 变更后立即持久化；已配置云端共享时同步推送（收件人按共享开关，口径一并打包） */
  const persist = (next: string[]) => {
    setList(next);
    saveMailRecipients(next);
    const cfg = loadCloudConfig();
    if (cfg.token) {
      setCloudMsg('正在同步云端…');
      void syncSettingsToCloud().then((r) => {
        setCloudMsg(
          r.ok
            ? '已同步云端，其他工程师下次打开页面即生效'
            : r.message === 'nothing'
              ? '已保存（本机）——云端共享未勾选收件人'
              : `已保存（本机），云端同步失败：${r.message}`,
        );
        setTimeout(() => setCloudMsg(''), 6000);
      });
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const email = input.trim();
    if (!email) return;
    if (!isValidEmail(email)) {
      setError('邮箱格式不正确');
      return;
    }
    if (list.some((v) => v.toLowerCase() === email.toLowerCase())) {
      setError('该邮箱已存在');
      return;
    }
    persist([...list, email]);
    setInput('');
    setError('');
  };

  const remove = (email: string) => {
    persist(list.filter((v) => v !== email));
  };

  return (
    <Card title="默认收件人">
      <div className="space-y-3 text-sm text-slate-600">
        <p>
          「报告生成」页点击「发送邮件」时，以下邮箱将自动填入收件人（可在写信窗口中增删）：
        </p>

        {/* 收件人列表 */}
        {list.length > 0 ? (
          <ul className="space-y-2">
            {list.map((email) => (
              <li
                key={email}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2"
              >
                <span className="break-all font-mono text-[13px] text-slate-700">{email}</span>
                <button
                  type="button"
                  onClick={() => remove(email)}
                  className="ml-3 shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
                  title="删除该收件人"
                >
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-center text-[13px] text-slate-400">
            暂无默认收件人，发送时需在写信窗口中手动填写
          </p>
        )}

        {/* 添加表单 */}
        <form onSubmit={add} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError('');
            }}
            placeholder="输入邮箱地址，如 name@example.com"
            className={`min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-[13px] outline-none transition-colors ${
              error ? 'border-red-300 bg-red-50 focus:border-red-400' : 'border-slate-300 focus:border-blue-500'
            }`}
          />
          <Button variant="secondary" type="submit">
            添加
          </Button>
        </form>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {cloudMsg && (
          <p className={`text-xs ${cloudMsg.includes('失败') ? 'text-red-500' : 'text-blue-600'}`}>
            {cloudMsg}
          </p>
        )}

        <p className="text-xs text-slate-400">
          收件人保存在本机浏览器中，仅影响「发送邮件」的默认收件人列表，可随时增删；
          配置云端共享后将随「保存口径 / 增删收件人」同步到云端（见下方「云端共享设置」）。
        </p>
      </div>
    </Card>
  );
}

/* ================= 云端共享设置 ================= */

function CloudSyncCard() {
  const { saveThresholds } = useCriteria();
  const [cfg, setCfg] = useState<CloudConfig>(() => loadCloudConfig());
  const [tokenInput, setTokenInput] = useState('');
  const [syncInfo, setSyncInfo] = useState<CloudSyncInfo | null>(() => loadCloudSyncInfo());
  const [busy, setBusy] = useState<'pull' | 'push' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);

  const fieldCls =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-blue-500';

  const saveCfg = (next: Partial<CloudConfig>) => {
    const merged = { ...cfg, ...next };
    setCfg(merged);
    saveCloudConfig(merged);
  };

  /** 保存 PAT（输入后点击，仅存本机） */
  const saveToken = () => {
    const t = tokenInput.trim();
    if (!t) {
      setMsg({ tone: 'error', text: '请先粘贴 Token' });
      return;
    }
    saveCfg({ token: t });
    setTokenInput('');
    setMsg({ tone: 'success', text: 'Token 已保存（仅存本机浏览器，不进代码与仓库）' });
  };

  const clearToken = () => {
    saveCfg({ token: '' });
    setMsg({ tone: 'info', text: 'Token 已清除，保存设置仅本机生效' });
  };

  /** 立即拉取云端设置并应用（成功后刷新页面以同步各表单显示） */
  const handlePull = async () => {
    setBusy('pull');
    setMsg(null);
    try {
      const cloud = await fetchCloudSettings();
      if (!cloud) {
        setMsg({ tone: 'error', text: '云端暂无共享设置（shared/settings.json 不存在或网络失败）' });
        return;
      }
      const applied = applyCloudSettings(cloud);
      if (cloud.criteria) saveThresholds(cloud.criteria);
      setSyncInfo(loadCloudSyncInfo());
      const parts: string[] = [];
      if (applied.criteria) parts.push('统计口径');
      if (applied.recipients) parts.push('默认收件人');
      setMsg({
        tone: 'success',
        text: `已应用云端设置（${parts.join('、') || '无共享项'}），页面即将刷新…`,
      });
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setMsg({ tone: 'error', text: `拉取失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  /** 手动推送当前设置到云端 */
  const handlePush = async () => {
    setBusy('push');
    setMsg(null);
    try {
      const r = await syncSettingsToCloud();
      if (r.ok) {
        setMsg({ tone: 'success', text: '已推送云端，其他工程师下次打开页面即生效' });
      } else if (r.message === 'not-configured') {
        setMsg({ tone: 'error', text: '尚未配置 Token，请先在上方粘贴并保存' });
      } else if (r.message === 'nothing') {
        setMsg({ tone: 'error', text: '未勾选任何共享项目，无可推送内容' });
      } else {
        setMsg({ tone: 'error', text: `推送失败：${r.message}` });
      }
    } finally {
      setBusy(null);
    }
  };

  const fmtTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
  };

  return (
    <Card title="云端共享设置">
      <div className="space-y-4 text-sm text-slate-600">
        <p>
          保存统计口径 / 收件人时自动<b className="text-slate-800">同步到 GitHub 仓库</b>
          （shared/settings.json），其他工程师打开页面时自动拉取，全团队口径一致。
          无 Token 时保存仅本机生效。
        </p>

        {/* 仓库与 Token 配置 */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">GitHub 用户名</label>
            <input
              type="text"
              value={cfg.owner}
              onChange={(e) => saveCfg({ owner: e.target.value.trim() })}
              className={`${fieldCls} font-mono`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">仓库名</label>
            <input
              type="text"
              value={cfg.repo}
              onChange={(e) => saveCfg({ repo: e.target.value.trim() })}
              className={`${fieldCls} font-mono`}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">
            Personal Access Token（管理员配置，仅存本机）
            {cfg.token && <span className="ml-2 text-emerald-600">● 已配置</span>}
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={cfg.token ? '已保存（粘贴新 Token 可替换）' : 'ghp_ / github_pat_ 开头'}
              className={`${fieldCls} font-mono text-[13px]`}
              autoComplete="off"
            />
            <div className="flex shrink-0 gap-2">
              <Button variant="secondary" onClick={saveToken}>
                保存
              </Button>
              {cfg.token && (
                <Button variant="secondary" onClick={clearToken}>
                  清除
                </Button>
              )}
            </div>
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-slate-400">
            生成：GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token；
            Repository access 选 {cfg.owner}/{cfg.repo}；Permissions → Contents 设为 Read and write。
            注意：推送内容将随公开仓库对外可见。
          </p>
        </div>

        {/* 共享范围 */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-xs font-medium text-slate-500">共享范围：</span>
          <label className="flex items-center gap-1.5 text-[13px]">
            <input
              type="checkbox"
              checked={cfg.shareCriteria}
              onChange={(e) => saveCfg({ shareCriteria: e.target.checked })}
              className="rounded text-blue-600"
            />
            统计口径
          </label>
          <label className="flex items-center gap-1.5 text-[13px]">
            <input
              type="checkbox"
              checked={cfg.shareRecipients}
              onChange={(e) => saveCfg({ shareRecipients: e.target.checked })}
              className="rounded text-blue-600"
            />
            默认收件人
          </label>
        </div>

        {/* 同步状态与操作 */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-500">
              <p>
                最近拉取：
                {syncInfo ? (
                  <>
                    {fmtTime(syncInfo.fetchedAt)}
                    <span className="ml-2 rounded bg-slate-200/70 px-1.5 py-0.5 text-[10px]">
                      {syncInfo.source === 'api' ? '仓库实时' : '部署产物'}
                    </span>
                    {syncInfo.cloudUpdatedAt && (
                      <span className="ml-2">云端更新于 {fmtTime(syncInfo.cloudUpdatedAt)}</span>
                    )}
                  </>
                ) : (
                  '尚未拉取（页面打开时自动进行）'
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={handlePull} disabled={busy !== null}>
                {busy === 'pull' ? '拉取中…' : '立即拉取云端设置'}
              </Button>
              <Button onClick={handlePush} disabled={busy !== null}>
                {busy === 'push' ? '推送中…' : '推送当前设置到云端'}
              </Button>
            </div>
          </div>
        </div>

        {msg && (
          <p
            className={`text-xs ${
              msg.tone === 'success'
                ? 'text-emerald-600'
                : msg.tone === 'error'
                  ? 'text-red-500'
                  : 'text-blue-600'
            }`}
          >
            {msg.text}
          </p>
        )}

        <p className="text-xs leading-5 text-slate-400">
          说明：拉取在每次打开页面时自动进行（云端值优先）；「推送」提交到仓库 main
          分支并触发自动部署。多人同时推送时自动处理冲突重试。Token 是 GitHub
          个人令牌，只在本机浏览器存储，请勿外传。
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

        <MailRecipientsCard />

        <CloudSyncCard />

        <Card title="邮件发送设置">
          <div className="space-y-3 text-sm text-slate-600">
            <p>
              「报告生成」页的「发送邮件」按钮通过系统默认邮件程序（mailto 协议）打开写信窗口。
              如需使用<b className="text-slate-800">飞书邮箱</b>发送，需先完成以下一次性配置：
            </p>
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3.5">
              <p className="text-[13px] font-medium text-slate-700">Windows（推荐：一键脚本）</p>
              <p className="mt-1 text-[13px] leading-6">
                下载
                <a
                  href={`${import.meta.env.BASE_URL}tools/set-feishu-mailto.ps1`}
                  download="set-feishu-mailto.ps1"
                  className="mx-1 font-medium text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
                >
                  set-feishu-mailto.ps1
                </a>
                ，右键 →「使用 PowerShell 运行」。脚本会自动定位飞书、注册 mailto
                协议关联并打开测试邮件（若浏览器未生效，重启浏览器后重试）。
              </p>
            </div>
            <ul className="space-y-1.5 text-[13px]">
              <li>
                <b className="text-slate-700">Windows（手动方式）</b>：删除注册表键
                <code className="mx-0.5 rounded bg-slate-100 px-1 py-0.5 text-xs">
                  HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto\UserChoice
                </code>
                ，再在
                <code className="mx-0.5 rounded bg-slate-100 px-1 py-0.5 text-xs">HKCU\Software\Classes\mailto\shell\open\command</code>
                中将默认值设为
                <code className="mx-0.5 rounded bg-slate-100 px-1 py-0.5 text-xs">"飞书路径\Feishu.exe" -- --open-url="%1"</code>
              </li>
              <li>
                <b className="text-slate-700">Mac</b>：邮件 App → 设置 → 通用 → 默认电子邮件阅读程序 → 选择
                <b className="text-slate-700">飞书</b>
              </li>
            </ul>
            <p className="text-xs text-slate-400">
              注：Windows 设置页的「电子邮箱」列表通常不含飞书（飞书未按系统邮件应用注册），
              请使用上述脚本或手动方式。配置后点击「发送邮件」将直接打开飞书写信界面，
              报告主题与摘要正文自动填充；Excel 报告已同时下载，拖入写信窗口的附件区即可发送。
            </p>
          </div>
        </Card>

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
