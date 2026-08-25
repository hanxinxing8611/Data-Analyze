import { useEffect, useState, useCallback } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';

const NAV_QUICK = [
  { to: '/', label: '数据总览', keyword: '总览' },
  { to: '/data', label: '数据管理', keyword: '数据' },
  { to: '/schedule', label: '验证计划', keyword: '计划' },
  { to: '/stats', label: '任务统计', keyword: '统计' },
  { to: '/comparison', label: '对比分析', keyword: '对比' },
  { to: '/report', label: '报告生成', keyword: '报告' },
  { to: '/settings', label: '系统设置', keyword: '设置' },
];

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');

  const filtered = NAV_QUICK.filter(
    (n) =>
      n.label.includes(paletteQuery) ||
      n.keyword.includes(paletteQuery) ||
      n.to.slice(1).includes(paletteQuery),
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        setPaletteQuery('');
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    },
    [],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div key={location.pathname} className="animate-page-in mx-auto max-w-7xl px-8 py-8">
          <Outlet />
        </div>
      </main>

      {/* 命令面板 Ctrl+K */}
      {paletteOpen && (
        <div className="fixed inset-0 z-[60]">
          <div className="absolute inset-0 bg-black/30" onClick={() => setPaletteOpen(false)} />
          <div className="absolute left-1/2 top-[20%] mx-auto w-full max-w-md -translate-x-1/2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input
                autoFocus
                value={paletteQuery}
                onChange={(e) => setPaletteQuery(e.target.value)}
                placeholder="搜索页面…"
                className="flex-1 border-none bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
              />
              <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-400">ESC</kbd>
            </div>
            <div className="max-h-64 overflow-auto py-1">
              {filtered.map((n) => (
                <button
                  key={n.to}
                  onClick={() => {
                    navigate(n.to);
                    setPaletteOpen(false);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-600 transition-colors hover:bg-blue-50"
                >
                  <span className="text-slate-400">{n.keyword.charAt(0)}</span>
                  <span>{n.label}</span>
                  <span className="ml-auto text-[11px] text-slate-400">{n.to === '/' ? '/' : n.to.slice(1)}</span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-slate-400">无匹配页面</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
