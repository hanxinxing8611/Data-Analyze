import { NavLink } from 'react-router-dom';
import Icon from './Icon';
import { useData } from '../../store/DataContext';

const NAV_ITEMS = [
  { to: '/', label: '数据总览', icon: 'dashboard', end: true },
  { to: '/data', label: '数据管理', icon: 'database', end: false },
  { to: '/comparison', label: '对比分析', icon: 'chart', end: false },
  { to: '/report', label: '报告生成', icon: 'file', end: false },
  { to: '/settings', label: '系统设置', icon: 'settings', end: false },
];

export default function Sidebar() {
  const { dbReady } = useData();

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
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* 数据库状态 */}
      <div className="relative border-t border-white/[0.07] px-5 py-4">
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
          <span className="text-xs font-medium text-slate-400">
            {dbReady ? '数据库就绪' : '数据库初始化中…'}
          </span>
        </div>
        <div className="mt-1.5 pl-[18px] text-[10.5px] tracking-wide text-slate-600">
            本地存储 · IndexedDB
        </div>
      </div>
    </aside>
  );
}
