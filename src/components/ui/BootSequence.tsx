import React, { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ShieldCheck, Terminal } from 'lucide-react';

interface BootSequenceProps {
  onComplete: () => void;
  skipLabel: string;
}

const BOOT_STEPS = [
  { text: 'INITIALIZING ENGINE...', color: 'text-cyan-300', delay: 220 },
  { text: 'CONNECTING BINANCE...', color: 'text-amber-300', delay: 620 },
  { text: 'SYNCING DATABASE...', color: 'text-cyan-300', delay: 1050 },
  { text: 'ONLINE', color: 'text-emerald-400', delay: 1480 },
];

export const BootSequence: React.FC<BootSequenceProps> = ({ onComplete, skipLabel }) => {
  const reducedMotion = useReducedMotion();
  const [visibleCount, setVisibleCount] = useState<number>(reducedMotion ? 4 : 0);
  const [progress, setProgress] = useState<number>(reducedMotion ? 100 : 8);

  useEffect(() => {
    if (reducedMotion) {
      const t = window.setTimeout(onComplete, 350);
      return () => window.clearTimeout(t);
    }

    const timers: number[] = [];
    BOOT_STEPS.forEach((step, idx) => {
      timers.push(
        window.setTimeout(() => {
          setVisibleCount(idx + 1);
          setProgress(Math.round(((idx + 1) / BOOT_STEPS.length) * 100));
        }, step.delay)
      );
    });

    timers.push(window.setTimeout(onComplete, 2050));

    return () => {
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [onComplete, reducedMotion]);

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.99 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#05060a] px-4"
    >
      <div className="terminal-grid-bg pointer-events-none absolute inset-0 opacity-50" />
      <div className="scanline-overlay pointer-events-none absolute inset-0 opacity-45" />

      <div className="relative w-full max-w-lg rounded-xl border border-cyan-500/35 bg-[#090d16]/95 p-6 shadow-[0_0_60px_-15px_rgba(34,211,238,0.4)]">
        <span className="pointer-events-none absolute top-0 left-0 h-3 w-3 rounded-tl-xl border-t-2 border-l-2 border-cyan-400" />
        <span className="pointer-events-none absolute top-0 right-0 h-3 w-3 rounded-tr-xl border-t-2 border-r-2 border-cyan-400" />
        <span className="pointer-events-none absolute bottom-0 left-0 h-3 w-3 rounded-bl-xl border-b-2 border-l-2 border-cyan-400" />
        <span className="pointer-events-none absolute bottom-0 right-0 h-3 w-3 rounded-br-xl border-b-2 border-r-2 border-cyan-400" />

        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <Terminal className="h-4 w-4 text-cyan-400" />
            <span className="font-display text-sm font-semibold tracking-widest text-slate-100 uppercase">
              AEGIS QUANT // KERNEL BOOT
            </span>
          </div>
          <button
            type="button"
            onClick={onComplete}
            className="min-h-[36px] rounded border border-slate-700/80 px-3 py-1 font-mono-tech text-xs text-slate-300 transition-colors hover:border-cyan-400/60 hover:text-cyan-300"
          >
            {skipLabel}
          </button>
        </div>

        <div className="my-5 space-y-2.5 font-mono-tech text-xs sm:text-sm">
          {BOOT_STEPS.slice(0, visibleCount).map((step, i) => {
            const isLast = i === visibleCount - 1;
            const isOnline = step.text === 'ONLINE';
            return (
              <motion.div
                key={step.text}
                initial={reducedMotion ? false : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.22 }}
                className="flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-slate-500">[{`0${i + 1}`}]</span>
                  <span className={`${step.color} font-medium tracking-wider`}>
                    {step.text}
                  </span>
                  {isLast && !isOnline && (
                    <span className="inline-block h-3.5 w-1.5 animate-pulse bg-cyan-400" />
                  )}
                </div>
                {isOnline ? (
                  <span className="flex items-center gap-1 text-emerald-400">
                    <ShieldCheck className="h-4 w-4" />
                    READY
                  </span>
                ) : (
                  <span className="text-[11px] text-emerald-400/80">OK</span>
                )}
              </motion.div>
            );
          })}
        </div>

        <div className="space-y-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <motion.div
              className="h-full bg-gradient-to-r from-cyan-400 via-emerald-400 to-cyan-300"
              initial={{ width: '8%' }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
          <div className="flex justify-between font-mono-tech text-[10px] text-slate-400">
            <span>NEURAL EXECUTION MATRIX</span>
            <span>{progress}%</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
};
