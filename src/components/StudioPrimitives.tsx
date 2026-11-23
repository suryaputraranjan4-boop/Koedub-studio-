import React from 'react';
import { AlertCircle, CheckCircle2, Clock, Info, PauseCircle, XCircle } from 'lucide-react';

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between pb-6 border-b border-slate-200">
      <div className="min-w-0">
        <h1 className="text-2xl sm:text-[26px] font-semibold tracking-tight text-slate-900">
          {title}
        </h1>
        <p className="mt-1 text-sm text-slate-600 max-w-3xl">{subtitle}</p>
      </div>
      {action ? <div className="flex items-center gap-2.5 shrink-0">{action}</div> : null}
    </div>
  );
}

export function Surface({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`bg-white border border-slate-200 rounded-xl p-5 sm:p-6 ${className}`}
    >
      {children}
    </section>
  );
}

export function SectionTitle({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {meta ? <p className="text-xs text-slate-500 mt-0.5">{meta}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export type SemanticTone = 'nominal' | 'warning' | 'error' | 'muted' | 'active';

export function StatusText({
  label,
  tone,
}: {
  label: string;
  tone: SemanticTone;
}) {
  const styles: Record<SemanticTone, { text: string; Icon: React.ComponentType<{ className?: string }> }> = {
    nominal: { text: 'text-emerald-700', Icon: CheckCircle2 },
    warning: { text: 'text-amber-700', Icon: AlertCircle },
    error: { text: 'text-red-700', Icon: XCircle },
    active: { text: 'text-blue-700', Icon: Clock },
    muted: { text: 'text-slate-600', Icon: PauseCircle },
  };

  const { text, Icon } = styles[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${text}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function NoticeBanner({
  tone,
  title,
  description,
}: {
  tone: 'info' | 'warning' | 'error' | 'success';
  title: string;
  description: string;
}) {
  const palette = {
    info: 'bg-slate-50 border-slate-200 text-slate-800',
    warning: 'bg-amber-50/70 border-amber-200 text-amber-950',
    error: 'bg-red-50/80 border-red-200 text-red-950',
    success: 'bg-emerald-50/70 border-emerald-200 text-emerald-950',
  }[tone];

  const Icon =
    tone === 'error'
      ? XCircle
      : tone === 'warning'
      ? AlertCircle
      : tone === 'success'
      ? CheckCircle2
      : Info;

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`border rounded-xl p-4 flex items-start gap-3 ${palette}`}
    >
      <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 text-sm">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-xs opacity-90 leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="border border-dashed border-slate-300 rounded-xl p-8 text-center bg-slate-50/50">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-xs text-slate-600 max-w-md mx-auto leading-relaxed">
        {description}
      </p>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 inline-flex items-center justify-center min-h-[40px] px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function KeyValueList({
  items,
}: {
  items: Array<{ label: string; value: string; mono?: boolean }>;
}) {
  return (
    <dl className="divide-y divide-slate-100">
      {items.map((item) => (
        <div
          key={item.label}
          className="py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-sm"
        >
          <dt className="text-xs text-slate-500">{item.label}</dt>
          <dd
            className={`text-xs font-medium text-slate-900 break-words sm:text-right ${
              item.mono ? 'font-mono tabular-nums' : ''
            }`}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return 'Not recorded';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function mapProjectStatusTone(status: string): SemanticTone {
  switch (status) {
    case 'completed':
      return 'nominal';
    case 'processing':
    case 'analyzing':
    case 'imported':
      return 'active';
    case 'needs_review':
    case 'paused':
    case 'interrupted':
      return 'warning';
    case 'failed':
      return 'error';
    default:
      return 'muted';
  }
}
