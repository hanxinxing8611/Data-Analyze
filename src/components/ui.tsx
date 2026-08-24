import type { ReactNode } from 'react';
import Icon from './layout/Icon';

/** 页面标题栏 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && (
          <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}

/** 卡片容器 */
export function Card({
  title,
  extra,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] ${className}`}
    >
      {(title || extra) && (
        <header className="flex min-h-[52px] items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
          {title && (
            <h2 className="text-[13px] font-semibold tracking-wide text-slate-700">{title}</h2>
          )}
          {extra}
        </header>
      )}
      <div className={bodyClassName || 'px-5 py-4'}>{children}</div>
    </section>
  );
}

/** 统计数字卡片 */
export function StatCard({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-slate-200/80 bg-white px-5 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(15,23,42,0.05),0_16px_32px_-16px_rgba(15,23,42,0.16)]">
      {/* 顶部强调细线：悬停时点亮 */}
      <span className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-blue-500/0 via-blue-500/70 to-cyan-400/0 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="text-xs font-medium tracking-wide text-slate-400">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="font-mono text-[26px] font-semibold leading-none tracking-tight text-slate-900">
          {value}
        </span>
        {unit && <span className="text-sm text-slate-400">{unit}</span>}
      </div>
      {hint && <div className="mt-2 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

/** 空状态 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-dashed border-slate-300 bg-slate-50/60 text-slate-400">
          <Icon name={icon} className="h-6 w-6" />
        </div>
      )}
      <h3 className="text-sm font-medium text-slate-700">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** 加载状态 */
export function Loading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-slate-400">
      <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-slate-200 border-t-blue-600" />
      <p className="mt-3 text-sm">{text}</p>
    </div>
  );
}

/** 徽标 */
export function Badge({
  children,
  tone = 'slate',
}: {
  children: ReactNode;
  tone?: 'slate' | 'blue' | 'green' | 'amber' | 'red';
}) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-50 text-slate-600 ring-slate-200',
    blue: 'bg-blue-50 text-blue-700 ring-blue-200/70',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-200/70',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200/70',
    red: 'bg-red-50 text-red-700 ring-red-200/70',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** 主按钮 */
export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const variants = {
    primary:
      'bg-gradient-to-b from-blue-500 to-blue-600 text-white shadow-sm shadow-blue-600/25 hover:from-blue-500 hover:to-blue-700 hover:shadow-blue-600/35 active:shadow-sm disabled:from-slate-300 disabled:to-slate-300 disabled:shadow-none',
    secondary:
      'border border-slate-300/90 bg-white text-slate-700 shadow-sm hover:border-slate-400 hover:bg-slate-50 hover:text-slate-900 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400 disabled:shadow-none',
    danger:
      'bg-gradient-to-b from-red-500 to-red-600 text-white shadow-sm shadow-red-600/25 hover:to-red-700 disabled:from-slate-300 disabled:to-slate-300 disabled:shadow-none',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex select-none items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 ${variants[variant]}`}
    >
      {children}
    </button>
  );
}
