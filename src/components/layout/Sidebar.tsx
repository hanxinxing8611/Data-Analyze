import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import Icon from './Icon';
import { useData } from '../../store/DataContext';
import {
  setCurrentEngineer,
  usePermission,
} from '../../utils/permissions';
import { loadEngineersConfig, type EngineerEntry } from '../../utils/cloudSettings';

const NAV_ITEMS = [
  { to: '/', label: '数据总览', icon: 'dashboard', end: true },
  { to: '/data', label: '数据管理', icon: 'database', end: false },
  { to: '/schedule', label: '验证计划', icon: 'calendar', end: false },
  { to: '/stats', label: '任务统计', icon: 'barchart', end: false },
  { to: '/comparison', label: '对比分析', icon: 'chart', end: false },
  { to: '/report', label: '报告生成', icon: 'file', end: false },
  { to: '/settings', label: '系统设置', icon: 'settings', end: false },
];

export default function Sidebar() {
  const { dbReady } = useData();
  const { canWrite, engineerName, engineerEmail } = usePermission();
  /** 点击下拉框时重新读取名录（云端拉取完成后可刷新选项） */
  const [engineerList, setEngineerList] = useState<EngineerEntry[]>(() =>
    loadEngineersConfig(),
  );

  return (
    <aside
      className="relative flex w-60 shrink-0 flex-col text-slate-300"
      style={{
        background:
          'linear-gradient(180deg, #0e1628 0%, #0a1020 55%, #080d1a 100%)',
      }}
    >
      {/* 顶部柔光：钴蓝→青色，仪器面板的呼吸灯 */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-64 opacity-60"
        style={{
          background:
            'radial-gradient(320px 140px at 24px -20px, rgba(59,130,246,0.28), transparent 70%), radial-gradient(260px 120px at 180px 0px, rgba(34,211,238,0.10), transparent 70%)',
        }}
      />

      {/* 品牌区 */}
      <div className="relative flex h-16 items-center gap-3 border-b border-white/[0.07] px-5">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-white shadow-lg shadow-blue-900/40"
          style={{
            background: 'linear-gradient(135deg, #3b82f6 0%, #22d3ee 130%)',
          }}
        >
          <Icon name="zap" className="h-[18px] w-[18px]" strokeWidth={2.2} />
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-tight text-white">
            器件验证
          </div>
          <div className="mt-0.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-slate-500">
            Data Analysis
          </div>
        </div>
      </div>

      {/* 导航 */}
      <nav className="relative flex-1 space-y-1 px-3 py-4">
        <div className="px-3 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-600">
          功能
        </div>
        {NAV_ITEMS.map((item, i) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            style={{ animationDelay: `${60 + i * 45}ms` }}
            className={({ isActive }) =>
              `group animate-nav-in relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150 ${
                isActive
                  ? 'bg-blue-600/90 font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_4px_12px_-4px_rgba(37,99,235,0.45)]'
                  : 'text-slate-400 hover:translate-x-0.5 hover:bg-white/[0.06] hover:text-slate-100'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {/* 激活指示条 */}
                <span
                  className={`absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-cyan-300 transition-opacity ${
                    isActive ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                <Icon
                  name={item.icon}
                  className={`h-[18px] w-[18px] transition-colors ${
                    isActive ? 'text-blue-100' : 'text-slate-500 group-hover:text-slate-300'
                  }`}
                />
                <span>{item.label}</span>
                {item.to === '/settings' && (
                  <span className="ml-auto flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/20 text-[10px] text-amber-400" title="系统设置已锁定，需管理员密码解锁">
                    <Icon name="lock" className="h-2.5 w-2.5" />
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* 当前用户身份（可切换，决定管理员/工程师权限） */}
      <div className="relative border-t border-white/[0.07] px-5 py-3">
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-xs font-bold text-slate-300">
            {engineerName ? engineerName.charAt(0) : '?'}
          </div>
          <div className="min-w-0 w-full text-center">
            <select
              value={engineerEmail}
              onClick={() => setEngineerList(loadEngineersConfig())}
              onChange={(e) => {
                const email = e.target.value;
                const eng = loadEngineersConfig().find((en) => en.email === email);
                setCurrentEngineer(eng ? eng.name : '');
              }}
              title="切换当前身份（需与系统设置中配置的邮箱一致）"
              className="w-full cursor-pointer appearance-none truncate rounded-md border border-white/10 bg-slate-700/60 px-2 py-1 text-xs font-medium text-slate-100 outline-none transition-colors hover:border-white/20 focus:border-blue-500/60"
            >
              <option value="" className="bg-slate-700 text-slate-100">选择邮箱…</option>
              {engineerList.map((en) => (
                <option
                  key={en.email || en.name}
                  value={en.email}
                  className="bg-slate-700 text-slate-100"
                >
                  {en.email ? en.email : `${en.name}（未配置邮箱）`}
                </option>
              ))}
            </select>
            {engineerName && (
              <div className="mt-0.5 truncate text-[10px] text-slate-400" title={engineerName}>
                {engineerName}
              </div>
            )}
            <div
              className={`mt-1 text-[10px] font-medium ${
                canWrite ? 'text-blue-400' : 'text-slate-500'
              }`}
            >
              {canWrite ? '管理员 · 拥有全部权限' : '工程师 · 仅可查看'}
            </div>
          </div>
        </div>
      </div>

      {/* 数据库状态 */}
      <div className="relative border-t border-white/[0.07] px-5 py-4">
        <div className="flex flex-col items-start gap-1.5">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              {dbReady && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
              )}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  dbReady ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
              />
            </span>
            <span className="text-sm font-medium text-slate-400">
              {dbReady ? '数据库就绪' : '数据库初始化中…'}
            </span>
          </div>
          <div className="text-[12.5px] tracking-wide text-slate-600">
            本地存储 · IndexedDB
          </div>
        </div>
      </div>
    </aside>
  );
}
