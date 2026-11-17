import React, { useEffect, useRef, useState } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { audioSynth } from '../../lib/audioSynth';

interface InfoTipProps {
  text: string;
  label?: string;
}

export const InfoTip: React.FC<InfoTipProps> = ({ text, label = 'Info' }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  if (!text) return null;

  return (
    <div ref={wrapRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          audioSynth.playClick();
          setOpen((v) => !v);
        }}
        aria-label={label}
        aria-expanded={open}
        className={`inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border transition-colors ${
          open
            ? 'border-cyan-400 bg-cyan-500/25 text-cyan-200'
            : 'border-slate-700 bg-slate-900/80 text-slate-400 hover:border-cyan-400/60 hover:text-cyan-300'
        }`}
      >
        <HelpCircle className="h-3 w-3" />
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute top-6 left-0 z-50 w-64 max-w-[82vw] rounded-xl border border-cyan-400/50 bg-[#080d18]/98 p-2.5 text-[11px] leading-relaxed text-slate-200 shadow-[0_8px_28px_rgba(0,0,0,0.75)] sm:left-auto sm:right-0"
        >
          <div className="mb-1 flex items-center justify-between gap-2 border-b border-slate-800 pb-1">
            <span className="font-mono-tech text-[10px] font-bold tracking-wider text-cyan-300 uppercase">
              {label}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="cursor-pointer text-slate-500 hover:text-slate-200"
              aria-label="Close help"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <p className="font-sans text-[11px] text-slate-200">{text}</p>
        </div>
      )}
    </div>
  );
};
