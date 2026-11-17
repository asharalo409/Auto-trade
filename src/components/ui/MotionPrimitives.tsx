import React, { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { audioSynth } from '../../lib/audioSynth';

interface SciFiSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  accent?: 'emerald' | 'cyan' | 'rose' | 'amber';
  disabled?: boolean;
}

export const SciFiSwitch: React.FC<SciFiSwitchProps> = ({
  checked,
  onChange,
  label,
  accent = 'emerald',
  disabled = false,
}) => {
  const reducedMotion = useReducedMotion();
  const trackColor = checked
    ? accent === 'rose'
      ? 'bg-rose-500/25 border-rose-400/70 shadow-[0_0_12px_rgba(244,63,94,0.4)]'
      : accent === 'cyan'
        ? 'bg-cyan-500/25 border-cyan-400/70 shadow-[0_0_12px_rgba(34,211,238,0.4)]'
        : accent === 'amber'
          ? 'bg-amber-500/25 border-amber-400/70 shadow-[0_0_12px_rgba(245,158,11,0.4)]'
          : 'bg-emerald-500/25 border-emerald-400/70 shadow-[0_0_12px_rgba(16,185,129,0.4)]'
    : 'bg-slate-900/90 border-slate-700';

  const knobColor = checked
    ? accent === 'rose'
      ? 'bg-rose-400'
      : accent === 'cyan'
        ? 'bg-cyan-300'
        : accent === 'amber'
          ? 'bg-amber-300'
          : 'bg-emerald-400'
    : 'bg-slate-500';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onMouseEnter={() => audioSynth.playHover()}
      onClick={() => {
        audioSynth.playToggle(!checked);
        onChange(!checked);
      }}
      className={`relative inline-flex h-7 w-13 shrink-0 cursor-pointer items-center rounded-full border p-1 transition-colors focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-50 ${trackColor}`}
    >
      <motion.span
        layout
        transition={
          reducedMotion
            ? { duration: 0 }
            : { type: 'spring', stiffness: 520, damping: 30 }
        }
        className={`h-5 w-5 rounded-full shadow-md ${knobColor} ${
          checked ? 'ml-auto' : 'mr-auto'
        }`}
      />
    </button>
  );
};

interface NeonButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'cyan' | 'emerald' | 'rose' | 'amber' | 'ghost';
  children: React.ReactNode;
}

export const NeonButton: React.FC<NeonButtonProps> = ({
  variant = 'cyan',
  children,
  className = '',
  onClick,
  onMouseEnter,
  ...rest
}) => {
  const [rippleKey, setRippleKey] = useState(0);
  const reducedMotion = useReducedMotion();

  const styleMap = {
    cyan: 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 hover:shadow-[0_0_18px_rgba(34,211,238,0.4)]',
    emerald:
      'border-emerald-400/60 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 hover:shadow-[0_0_18px_rgba(16,185,129,0.4)]',
    rose: 'border-rose-400/60 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 hover:shadow-[0_0_18px_rgba(244,63,94,0.4)]',
    amber:
      'border-amber-400/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 hover:shadow-[0_0_18px_rgba(245,158,11,0.4)]',
    ghost: 'border-slate-700 bg-slate-900/70 text-slate-300 hover:border-slate-500 hover:text-white',
  };

  return (
    <motion.button
      whileTap={reducedMotion ? undefined : { scale: 0.97 }}
      onMouseEnter={(e) => {
        audioSynth.playHover();
        onMouseEnter?.(e);
      }}
      onClick={(e) => {
        audioSynth.playClick();
        setRippleKey((k) => k + 1);
        onClick?.(e);
      }}
      className={`relative overflow-hidden min-h-[42px] cursor-pointer rounded-lg border px-4 py-2 font-mono-tech text-xs font-semibold tracking-wider uppercase transition-all whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:opacity-50 ${styleMap[variant]} ${className}`}
      {...(rest as Record<string, unknown>)}
    >
      {rippleKey > 0 && !reducedMotion && (
        <motion.span
          key={rippleKey}
          initial={{ scale: 0, opacity: 0.45 }}
          animate={{ scale: 3.2, opacity: 0 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          className="pointer-events-none absolute inset-0 m-auto h-10 w-10 rounded-full bg-white/30"
        />
      )}
      <span className="relative z-10 flex items-center justify-center gap-2">{children}</span>
    </motion.button>
  );
};

export const SkeletonBlock: React.FC<{ className?: string }> = ({ className = 'h-24 w-full' }) => (
  <div className={`skeleton-shimmer rounded-lg border border-slate-800/80 ${className}`} />
);
