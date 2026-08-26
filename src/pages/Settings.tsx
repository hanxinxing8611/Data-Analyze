import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useCriteria } from '../store/CriteriaContext';
import { Button, Card, PageHeader } from '../components/ui';
import Icon from '../components/layout/Icon';
import { usePermission, notifyPermissionChanged } from '../utils/permissions';
import { criteriaText, criteriaTextShort, DEFAULT_THRESHOLDS, type CriteriaThresholds } from '../report/reportData';
import {
  isValidEmail,
  loadMailRecipients,
  saveMailRecipients,
} from '../utils/mailRecipients';
import {
  applyCloudSettings,
  fetchCloudSettings,
  loadAdminNames,
  loadCloudConfig,
  loadCloudSyncInfo,
  saveAdminNames,
  saveCloudConfig,
  syncSettingsToCloud,
  loadEngineersConfig,
  saveEngineersConfig,
  type CloudConfig,
  type CloudSyncInfo,
  type EngineerEntry,
} from '../utils/cloudSettings';

/** 系统管理员密码（防误改，非安全加密） */
const SETTINGS_PASSWORD = '000000';
/** 解锁状态会话内有效（关闭标签页后失效），刷新页面不重复输入 */
const UNLOCKED_KEY = 'dv-settings-unlocked';

/* ================= 密码解锁遮罩 ================= */

function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [pwd, setPwd] = useState('');
  const [error, setError] = useState('');
  const [showPwd, setShowPwd] = useState(false);
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
            收件人与云端共享配置会影响全团队，请输入管理员密码
          </p>
        </div>
        <input
          ref={inputRef}
          type={showPwd ? 'text' : 'password'}
          inputMode="numeric"
          autoComplete="off"
          value={pwd}
          onChange={(e) => {
            setPwd(e.target.value);
            setError('');
          }}
          placeholder="请输入管理员密码"
          className={`mt-6 w-full rounded-lg border px-4 py-2.5 text-center font-mono text-lg tracking-[0.5em] outline-none transition-colors ${
            error
              ? 'border-red-300 bg-red-50 focus:border-red-400'
              : 'border-slate-300 focus:border-blue-500'
          }`}
        />
        <button
          type="button"
          onClick={() => setShowPwd(!showPwd)}
          className="mx-auto mt-1.5 text-[11px] text-slate-400 hover:text-slate-600 transition-colors"
        >
          {showPwd ? '隐藏密码' : '显示密码'}
        </button>
        {error && <p className="mt-2 text-center text-xs text-red-500">{error}</p>}
        <button
          type="submit"
          className="mt-5 w-full rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 py-2.5 text-sm font-medium text-white shadow-sm shadow-blue-600/25 transition-all duration-150 hover:to-blue-700 active:scale-[0.99]"
        >
          管理员登录
        </button>
      </form>
    </div>
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
          配置云端共享后将随「保存口径（报告生成页）/ 增删收件人」同步到云端（见下方「云端共享设置」）。
        </p>
      </div>
    </Card>
  );
}

/* ================= 判定标准管理（多套，管理员） ================= */

/** 数值输入框状态 */
interface NumberField {
  value: string;
  error: string;
}

function emptyField(n: number): NumberField {
  return { value: String(n), error: '' };
}

/** 判定规则表单行配置 */
const RULE_ROWS = [
  { key: 'champion', label: 'PCE冠军 Δ≥' },
  { key: 'median', label: 'PCE中位 Δ≥' },
  { key: 'vocff', label: 'VOC*FF平均 Δ≥' },
] as const;

type RuleKey = (typeof RULE_ROWS)[number]['key'];

function CriteriaManagerCard() {
  const { canWrite } = usePermission();
  const { criteriaSets, activeName, saveCriteriaSet, deleteCriteriaSet } = useCriteria();

  /* 正在编辑的套名（默认进入当前生效套） */
  const [editing, setEditing] = useState<string>(activeName);
  const current = criteriaSets[editing];

  const [pceMin, setPceMin] = useState<NumberField>(() => emptyField(current?.pceMin ?? DEFAULT_THRESHOLDS.pceMin));
  const [ffMin, setFfMin] = useState<NumberField>(() => emptyField(current?.ffMin ?? DEFAULT_THRESHOLDS.ffMin));
  const [resistanceMin, setResistanceMin] = useState<NumberField>(
    () => emptyField(current?.resistanceMin ?? DEFAULT_THRESHOLDS.resistanceMin),
  );
  const [ruleOn, setRuleOn] = useState<Record<RuleKey, boolean>>({
    champion: current?.championRule.enabled ?? true,
    median: current?.medianRule.enabled ?? true,
    vocff: current?.vocffRule.enabled ?? false,
  });
  const [ruleTh, setRuleTh] = useState<Record<RuleKey, NumberField>>({
    champion: emptyField(current?.championRule.threshold ?? 0),
    median: emptyField(current?.medianRule.threshold ?? 0),
    vocff: emptyField(current?.vocffRule.threshold ?? 0),
  });
  const [ruleError, setRuleError] = useState('');
  const [newName, setNewName] = useState('');
  const [nameError, setNameError] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);

  /* 切换编辑套时重置表单 */
  useEffect(() => {
    const t = criteriaSets[editing] ?? DEFAULT_THRESHOLDS;
    setPceMin(emptyField(t.pceMin));
    setFfMin(emptyField(t.ffMin));
    setResistanceMin(emptyField(t.resistanceMin));
    setRuleOn({ champion: t.championRule.enabled, median: t.medianRule.enabled, vocff: t.vocffRule.enabled });
    setRuleTh({
      champion: emptyField(t.championRule.threshold),
      median: emptyField(t.medianRule.threshold),
      vocff: emptyField(t.vocffRule.threshold),
    });
    setRuleError('');
  }, [editing, criteriaSets]);

  const dirty =
    !!current &&
    (pceMin.value !== String(current.pceMin) ||
      ffMin.value !== String(current.ffMin) ||
      resistanceMin.value !== String(current.resistanceMin) ||
      RULE_ROWS.some(
        (r) =>
          ruleOn[r.key] !== current[`${r.key}Rule`].enabled ||
          ruleTh[r.key].value !== String(current[`${r.key}Rule`].threshold),
      ));

  const validate = (f: NumberField, min: number, max: number, label: string): NumberField => {
    const n = parseFloat(f.value);
    if (f.value.trim() === '' || isNaN(n)) return { ...f, error: `${label}须为数值` };
    if (n < min || n > max) return { ...f, error: `取值范围 ${min} ~ ${max}` };
    return { value: f.value, error: '' };
  };

  /** 保存当前编辑套（含云端同步） */
  const handleSave = () => {
    if (!current) return;
    const pc = validate(pceMin, 0, 100, 'PCE 下限');
    const ff = validate(ffMin, 0, 1, 'FF 下限');
    const rs = validate(resistanceMin, 0, 1e9, '电阻下限');
    setPceMin(pc);
    setFfMin(ff);
    setResistanceMin(rs);
    const ths = { ...ruleTh };
    for (const r of RULE_ROWS) ths[r.key] = validate(ruleTh[r.key], -100, 100, 'Δ 阈值');
    setRuleTh(ths);
    if (pc.error || ff.error || rs.error || RULE_ROWS.some((r) => ths[r.key].error)) return;
    if (!RULE_ROWS.some((r) => ruleOn[r.key])) {
      setRuleError('优秀判定至少启用一项条件（可单选或多选）');
      return;
    }
    setRuleError('');

    const next: CriteriaThresholds = {
      championRule: { enabled: ruleOn.champion, threshold: parseFloat(ths.champion.value) },
      medianRule: { enabled: ruleOn.median, threshold: parseFloat(ths.median.value) },
      vocffRule: { enabled: ruleOn.vocff, threshold: parseFloat(ths.vocff.value) },
      pceMin: parseFloat(pc.value),
      ffMin: parseFloat(ff.value),
      resistanceMin: parseFloat(rs.value),
    };
    saveCriteriaSet(editing, next);

    const cfg = loadCloudConfig();
    if (cfg.token) {
      setMsg({ tone: 'info', text: '正在同步云端…' });
      void syncSettingsToCloud().then((r) => {
        setMsg(
          r.ok
            ? { tone: 'success', text: '已保存并同步云端，其他工程师下次打开页面即生效' }
            : r.message === 'nothing'
              ? { tone: 'info', text: '已保存（本机）——云端共享未勾选判定标准' }
              : { tone: 'error', text: `已保存（本机），云端同步失败：${r.message}` },
        );
        setTimeout(() => setMsg(null), 6000);
      });
    } else {
      setMsg({ tone: 'success', text: '已保存（本机）' });
      setTimeout(() => setMsg(null), 2500);
    }
  };

  /** 新增一套判定标准 */
  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) { setNameError('请输入名称'); return; }
    if (criteriaSets[name]) { setNameError(`“${name}”已存在`); return; }
    saveCriteriaSet(name, { ...DEFAULT_THRESHOLDS });
    setNewName('');
    setNameError('');
    setEditing(name);
    setMsg({ tone: 'success', text: `已新增判定标准“${name}”，请配置参数后保存` });
    setTimeout(() => setMsg(null), 3000);
  };

  /** 删除一套（至少保留一套） */
  const handleDelete = (name: string) => {
    if (Object.keys(criteriaSets).length <= 1) {
      setMsg({ tone: 'error', text: '至少保留一套判定标准' });
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    deleteCriteriaSet(name);
    if (editing === name) setEditing(Object.keys(criteriaSets).find((n) => n !== name) ?? '');
    setMsg({ tone: 'info', text: `已删除“${name}”（本机）。如需同步云端，请点击「推送当前设置到云端」` });
    setTimeout(() => setMsg(null), 5000);
  };

  const fieldCls = (err: string) =>
    `w-20 rounded-lg border px-2.5 py-1.5 text-right font-mono text-sm outline-none transition-colors ${
      err ? 'border-red-300 bg-red-50 focus:border-red-400' : 'border-slate-300 focus:border-blue-500'
    }`;

  /* 工程师：只读展示 */
  if (!canWrite) {
    return (
      <Card title="判定标准（统计口径与优秀判定）">
        <div className="space-y-3 text-sm text-slate-600">
          <div className="flex items-center gap-2 rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2 text-xs text-amber-700">
            <Icon name="lock" className="h-3.5 w-3.5 shrink-0" />
            判定标准由管理员维护，您仅有查看权限；如需调整请联系管理员。
          </div>
          {Object.entries(criteriaSets).map(([name, t]) => (
            <div key={name} className="rounded-lg border border-slate-100 bg-slate-50/60 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-700">{name}</span>
                {name === activeName && (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-600">当前使用</span>
                )}
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">{criteriaText(t)}</p>
            </div>
          ))}
        </div>
      </Card>
    );
  }

  /* 管理员：完整编辑 */
  return (
    <Card title="判定标准（统计口径与优秀判定）">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          维护多套判定标准（如 微晶 / 盐 / 其他）。工程师在「报告生成」页选择对应标准后，
          报告统计与优秀判定将自动按所选标准计算。
        </p>

        {/* 套切换 + 管理 */}
        <div className="flex flex-wrap items-center gap-2">
          {Object.keys(criteriaSets).map((name) => (
            <div key={name} className="flex items-center">
              <button
                type="button"
                onClick={() => setEditing(name)}
                className={`rounded-lg border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  editing === name
                    ? 'border-blue-500 bg-blue-50 text-blue-600'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700'
                }`}
              >
                {name}
                {name === activeName && <span className="ml-1.5 text-[10px] text-blue-400">使用中</span>}
              </button>
              <button
                type="button"
                onClick={() => handleDelete(name)}
                title={`删除“${name}”`}
                className="-ml-px rounded-r-lg border border-l-0 border-slate-200 px-2 py-1.5 text-sm leading-none text-slate-300 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-400"
              >
                ×
              </button>
            </div>
          ))}
          <form onSubmit={handleAdd} className="flex items-center gap-1.5">
            <input
              type="text"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setNameError(''); }}
              placeholder="新增标准名称"
              className="w-28 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-blue-500"
            />
            <Button variant="secondary" type="submit">新增</Button>
          </form>
        </div>
        {nameError && <p className="text-xs text-red-500">{nameError}</p>}

        {current ? (
          <>
            {/* 有效测试记录判定阈值 */}
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-4 py-3">
              <div className="mb-2 text-sm font-medium text-slate-700">
                「{editing}」有效测试记录判定
              </div>
              <p className="mb-3 text-[11px] leading-4 text-slate-400">
                反扫记录需同时满足以下条件才算有效测试记录
              </p>
              <div className="grid grid-cols-1 gap-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-36 shrink-0 text-xs text-slate-500">PCE 下限（%）</span>
                  <input
                    type="number"
                    step="any"
                    value={pceMin.value}
                    onChange={(e) => setPceMin({ value: e.target.value, error: '' })}
                    className={`${fieldCls(pceMin.error)} flex-1`}
                  />
                  {pceMin.error && <span className="text-xs text-red-500">{pceMin.error}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-36 shrink-0 text-xs text-slate-500">FF 下限</span>
                  <input
                    type="number"
                    step="any"
                    value={ffMin.value}
                    onChange={(e) => setFfMin({ value: e.target.value, error: '' })}
                    className={`${fieldCls(ffMin.error)} flex-1`}
                  />
                  {ffMin.error && <span className="text-xs text-red-500">{ffMin.error}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-36 shrink-0 text-xs text-slate-500">电阻下限（Ω，Rs/Rsh &gt;）</span>
                  <input
                    type="number"
                    step="any"
                    value={resistanceMin.value}
                    onChange={(e) => setResistanceMin({ value: e.target.value, error: '' })}
                    className={`${fieldCls(resistanceMin.error)} flex-1`}
                  />
                  {resistanceMin.error && (
                    <span className="text-xs text-red-500">{resistanceMin.error}</span>
                  )}
                </div>
              </div>
            </div>

            {/* 优秀批次判定规则 */}
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-4 py-3">
              <div className="mb-2 text-sm font-medium text-slate-700">「{editing}」优秀批次判定</div>
              <p className="mb-3 text-[11px] leading-4 text-slate-400">
                对比批次相对 Baseline 的差值 Δ 满足全部启用条件即「优秀」，否则「不合格」；可单选或多选
              </p>
              <div className="space-y-2.5">
                {RULE_ROWS.map((r) => (
                  <div key={r.key} className="flex items-center gap-2">
                    <label className="flex flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={ruleOn[r.key]}
                        onChange={(e) => {
                          setRuleOn({ ...ruleOn, [r.key]: e.target.checked });
                          setRuleError('');
                        }}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                      />
                      <span className="text-xs text-slate-600">{r.label}</span>
                    </label>
                    <input
                      type="number"
                      step="any"
                      disabled={!ruleOn[r.key]}
                      value={ruleTh[r.key].value}
                      onChange={(e) =>
                        setRuleTh({ ...ruleTh, [r.key]: { value: e.target.value, error: '' } })
                      }
                      className={`${fieldCls(ruleTh[r.key].error)} w-20 ${
                        ruleOn[r.key] ? '' : 'cursor-not-allowed bg-slate-100 text-slate-400'
                      }`}
                    />
                    {ruleTh[r.key].error && (
                      <span className="text-xs text-red-500">{ruleTh[r.key].error}</span>
                    )}
                  </div>
                ))}
              </div>
              {ruleError && <p className="mt-2 text-xs text-red-500">{ruleError}</p>}
            </div>

            <div className="flex items-center justify-between border-t border-slate-100 pt-3">
              <div className="min-w-0">
                <p className="truncate text-xs text-slate-400" title={criteriaText(current)}>
                  {dirty ? (
                    <span className="text-amber-600">「{editing}」有未保存的修改</span>
                  ) : (
                    criteriaTextShort(current)
                  )}
                </p>
                {msg && (
                  <p
                    className={`mt-0.5 text-xs ${
                      msg.tone === 'error' ? 'text-red-500' : msg.tone === 'success' ? 'text-emerald-600' : 'text-blue-600'
                    }`}
                  >
                    {msg.text}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button onClick={handleSave}>保存「{editing}」</Button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-400">请先新增一套判定标准</p>
        )}
      </div>
    </Card>
  );
}

/* ================= 云端共享设置 ================= */

function CloudSyncCard() {
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
      // 判定标准（多套/旧版单套）已由 applyCloudSettings 写入 localStorage，页面刷新后生效
      setSyncInfo(loadCloudSyncInfo());
      const parts: string[] = [];
      if (applied.criteria) parts.push('统计口径');
      if (applied.recipients) parts.push('默认收件人');
      if (applied.roles) parts.push('权限管理');
      if (applied.engineers) parts.push('工程师名录');
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
          保存统计口径（报告生成页）/ 收件人 / 权限配置时自动<b className="text-slate-800">同步到 GitHub 仓库</b>
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
          <label className="flex items-center gap-1.5 text-[13px]">
            <input
              type="checkbox"
              checked={cfg.shareRoles}
              onChange={(e) => saveCfg({ shareRoles: e.target.checked })}
              className="rounded text-blue-600"
            />
            权限管理
          </label>
          <label className="flex items-center gap-1.5 text-[13px]">
            <input
              type="checkbox"
              checked={cfg.shareEngineers}
              onChange={(e) => saveCfg({ shareEngineers: e.target.checked })}
              className="rounded text-blue-600"
            />
            工程师名录
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

/* ================= 工程师名录管理 ================= */

function EngineerManagerCard() {
  const [list, setList] = useState<EngineerEntry[]>(() => loadEngineersConfig());
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null);

  const persist = (next: EngineerEntry[]) => {
    setList(next);
    saveEngineersConfig(next);
    notifyPermissionChanged(); // 通知侧边栏刷新身份选择器
    const cfg = loadCloudConfig();
    if (cfg.token && cfg.shareEngineers) {
      setMsg({ tone: 'info', text: '正在同步云端…' });
      void syncSettingsToCloud().then((r) => {
        setMsg(
          r.ok
            ? { tone: 'success', text: '已同步云端，其他工程师下次打开页面即生效' }
            : r.message === 'nothing'
              ? { tone: 'info', text: '已保存（本机）——云端共享未勾选工程师名录' }
              : { tone: 'error', text: `已保存（本机），云端同步失败：${r.message}` },
        );
        setTimeout(() => setMsg(null), 6000);
      });
    } else {
      setMsg({ tone: 'success', text: '已保存（本机）' });
      setTimeout(() => setMsg(null), 2000);
    }
  };

  const addOrUpdate = (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    const email = newEmail.trim();
    if (!name) { setError('请输入工程师姓名'); return; }
    if (email && !isValidEmail(email)) { setError('邮箱格式不正确'); return; }
    const dup = list.find((en) => en.name === name);
    if (editIdx !== null) {
      // 编辑模式
      const next = [...list];
      next[editIdx] = { name, email };
      persist(next);
      setEditIdx(null);
    } else if (dup) {
      setError(`"${name}" 已在名录中`);
      return;
    } else {
      persist([...list, { name, email }]);
    }
    setNewName('');
    setNewEmail('');
    setError('');
  };

  const startEdit = (idx: number) => {
    setEditIdx(idx);
    setNewName(list[idx].name);
    setNewEmail(list[idx].email);
    setError('');
  };

  const cancelEdit = () => {
    setEditIdx(null);
    setNewName('');
    setNewEmail('');
    setError('');
  };

  const remove = (idx: number) => {
    const name = list[idx].name;
    const next = list.filter((_, i) => i !== idx);
    persist(next);
    setMsg({ tone: 'info', text: `已移除 "${name}"` });
    setTimeout(() => setMsg(null), 2000);
  };

  return (
    <Card title="工程师名录">
      <div className="space-y-4 text-sm text-slate-600">
        <p>
          在此配置所有工程师的<b className="text-slate-800">姓名和邮箱</b>。
          配置后，侧边栏「身份选择器」将自动显示所有工程师，选择身份后邮箱自动带入验证计划、报告生成等页面。
        </p>

        {/* 工程师列表 */}
        {list.length > 0 ? (
          <div className="max-h-[260px] overflow-auto rounded-lg border border-slate-200">
            <table className="w-full">
              <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">姓名</th>
                  <th className="px-3 py-2 text-left font-medium">邮箱</th>
                  <th className="px-3 py-2 text-center font-medium w-24">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.map((en, i) => (
                  <tr key={en.name} className="hover:bg-slate-50/50">
                    <td className="px-3 py-2 text-[13px] font-medium text-slate-800">{en.name}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[13px] ${en.email ? 'font-mono text-slate-600' : 'text-slate-400'}`}>
                        {en.email || '（未填写）'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(i)}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(i)}
                          className="text-xs text-red-500 hover:underline"
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-center text-[13px] text-slate-400">
            暂无工程师名录，请添加工程师姓名和邮箱
          </p>
        )}

        {/* 添加/编辑表单 */}
        <form onSubmit={addOrUpdate} className="space-y-2">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-slate-500">姓名</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => { setNewName(e.target.value); setError(''); }}
                placeholder="工程师姓名"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-blue-500"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-slate-500">邮箱</label>
              <input
                type="text"
                value={newEmail}
                onChange={(e) => { setNewEmail(e.target.value); setError(''); }}
                placeholder="name@example.com"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm outline-none transition-colors focus:border-blue-500"
              />
            </div>
            <Button type="submit" variant="secondary">
              {editIdx !== null ? '更新' : '添加'}
            </Button>
            {editIdx !== null && (
              <Button variant="secondary" onClick={cancelEdit}>
                取消
              </Button>
            )}
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </form>

        {msg && (
          <p className={`text-xs ${msg.tone === 'error' ? 'text-red-500' : msg.tone === 'success' ? 'text-emerald-600' : 'text-blue-600'}`}>
            {msg.text}
          </p>
        )}

        <p className="text-xs text-slate-400">
          工程师名录在「系统设置」中管理，配置后自动同步到云端供全团队使用。
          管理员可在下方「权限管理」中将名录中的工程师设为管理员。
        </p>
      </div>
    </Card>
  );
}

/* ================= 权限管理 ================= */

function RoleManagerCard() {
  const [names, setNames] = useState<string[]>(() => loadAdminNames());
  const [newName, setNewName] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);

  /** 可快速添加的工程师（已录入但还不是管理员） */
  const candidates = loadEngineersConfig()
    .map((e) => e.name.trim())
    .filter((n) => n && !names.includes(n));

  const addName = (n: string) => {
    const name = n.trim();
    if (!name) return;
    if (names.includes(name)) {
      setMsg({ tone: 'error', text: `"${name}" 已在管理员列表中` });
      return;
    }
    const next = [...names, name];
    setNames(next);
    saveAdminNames(next);
    notifyPermissionChanged();
    setNewName('');
    setMsg({ tone: 'success', text: `已添加管理员 "${name}"` });
    setTimeout(() => setMsg(null), 2000);
  };

  const removeName = (n: string) => {
    const next = names.filter((x) => x !== n);
    setNames(next);
    saveAdminNames(next);
    notifyPermissionChanged();
    setMsg({ tone: 'info', text: `已移除管理员 "${n}"` });
    setTimeout(() => setMsg(null), 2000);
  };

  return (
    <Card title="权限管理">
      <div className="space-y-4 text-sm text-slate-600">
        <p>
          管理员拥有<b className="text-slate-800">全部权限</b>（增删改验证计划、修改系统设置）；<br />
          工程师仅可<b className="text-slate-800">查看</b>验证计划、任务统计与数据概览，无增删改和系统设置权限。<br />
          <span className="text-xs text-slate-400">管理员列表为空时，全员拥有管理员权限（向后兼容）。</span>
        </p>

        {/* 当前管理员列表 */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-500">当前管理员</label>
          {names.length === 0 ? (
            <p className="text-xs text-slate-400">（空 = 全员管理员，无权限限制）</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {names.map((n) => (
                <span
                  key={n}
                  className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700"
                >
                  {n}
                  <button
                    type="button"
                    onClick={() => removeName(n)}
                    className="ml-0.5 text-blue-400 hover:text-red-500"
                    title="移除"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 从已录入工程师中快速添加（避免姓名不一致） */}
        {candidates.length > 0 && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-500">
              快速添加（点击已录入的工程师）
            </label>
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => addName(n)}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                  title="添加为管理员"
                >
                  ＋ {n}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 手动添加管理员 */}
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addName(newName)}
            placeholder="输入工程师姓名"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-blue-500"
          />
          <Button variant="secondary" onClick={() => addName(newName)}>
            添加
          </Button>
        </div>
        <p className="text-xs text-slate-400">
          管理员姓名需与验证计划中录入的工程师姓名完全一致；
          添加/移除后，请在左侧边栏「身份选择」中确认当前身份已匹配。
        </p>

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
      </div>
    </Card>
  );
}

/* ================= 设置页主体 ================= */

export default function Settings() {
  const [unlocked, setUnlocked] = useState(false);
  const { canWrite, engineerName } = usePermission();

  useEffect(() => {
    try {
      if (sessionStorage.getItem(UNLOCKED_KEY) === '1') setUnlocked(true);
    } catch {
      // sessionStorage 不可用时保持锁定
    }
  }, []);

  /* 密码门在前：000000 即系统管理员凭证（防止身份识别异常时管理员被锁死） */
  if (!unlocked) {
    return (
      <div>
        <PageHeader
          title="系统设置"
          description="默认收件人与云端共享配置（需系统管理员权限）"
        />
        <PasswordGate onUnlock={() => setUnlocked(true)} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="系统设置"
        description="默认收件人与云端共享配置（需系统管理员权限）；统计口径已移至「报告生成」页"
      />

      <div className="space-y-6">
        {/* 非管理员身份软提示（密码已验证，但当前身份不在管理员列表中） */}
        {!canWrite && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800">
            <span className="mt-0.5 text-base">⚠️</span>
            <span>
              当前身份「{engineerName || '未选择'}」<b>不在管理员列表</b>中，验证计划仅可查看。
              若您是管理员，请在下方「权限管理」中添加该姓名，并在左侧边栏选择对应身份。
            </span>
          </div>
        )}

        <CriteriaManagerCard />

        <MailRecipientsCard />

        <CloudSyncCard />

        <EngineerManagerCard />

        <RoleManagerCard />

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
