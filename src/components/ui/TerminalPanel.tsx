import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

interface TerminalPanelProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  rightSlot?: React.ReactNode;
  accent?: 'cyan' | 'emerald' | 'crimson' | 'amber' | 'neutral';
  className?: string;
  delay?: number;
  sweep?: boolean;
}

const ACCENT_STYLES: Record<NonNullable<TerminalPanelProps['accent']>, string> = {
  cyan: 'border-cyan-500/25 shadow-[0_0_24px_-12px_rgba(34,211,238,0.35)]',
  emerald: 'border-emerald-500/25 shadow-[0_0_24px_-12px_rgba(16,185,129,0.35)]',
  crimson: 'border-rose-500/30 shadow-[0_0_24px_-12px_rgba(244,63,94,0.35)]',
  amber: 'border-amber-500/25 shadow-[0_0_24px_-12px_rgba(245,158,11,0.35)]',
  neutral: 'border-slate-700/60 shadow-[0_0_24px_-14px_rgba(148,163,184,0.2)]',
};

const BRACKET_COLOR: Record<NonNullable<TerminalPanelProps['accent']>, string> = {
  cyan: 'border-cyan-400/70',
  emerald: 'border-emerald-400/70',
  crimson: 'border-rose-400/75',
  amber: 'border-amber-400/75',
  neutral: 'border-slate-400/50',
};

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  children,
  title,
  subtitle,
  rightSlot,
  accent = 'cyan',
  className = '',
  delay = 0,
  sweep = true,
}) => {
  const reducedMotion = useReducedMotion();
  const bracketCls = BRACKET_COLOR[accent];

  return (
    <motion.section
      initial={reducedMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] }}
      className={`relative rounded-xl border bg-[#090d16]/90 ${ACCENT_STYLES[accent]} ${
        sweep && !reducedMotion ? 'panel-light-sweep' : ''
      } ${className}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-0 left-0 h-2.5 w-2.5 rounded-tl-xl border-t border-l ${bracketCls}`}
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-0 right-0 h-2.5 w-2.5 rounded-tr-xl border-t border-r ${bracketCls}`}
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-0 left-0 h-2.5 w-2.5 rounded-bl-xl border-b border-l ${bracketCls}`}
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-0 right-0 h-2.5 w-2.5 rounded-br-xl border-b border-r ${bracketCls}`}
      />

      {(title || rightSlot) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 className="font-display text-sm font-semibold tracking-wider text-slate-100 uppercase">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-0.5 text-[11px] text-slate-400 truncate">{subtitle}</p>
            )}
          </div>
          {rightSlot && <div className="flex items-center gap-2 shrink-0">{rightSlot}</div>}
        </div>
      )}

      <div className="p-4">{children}</div>
    </motion.section>
  );
};
