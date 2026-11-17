import React from 'react';
import { BellRing, TrendingDown, TrendingUp } from 'lucide-react';
import { audioSynth } from '../../lib/audioSynth';
import { SmartAlert } from '../../types/trading';
import { InfoTip } from '../ui/InfoTip';
import { TerminalPanel } from '../ui/TerminalPanel';

interface SmartTrackerWidgetProps {
  t: Record<string, string>;
  alerts: SmartAlert[];
  selectedSymbol: string;
  onSelectPair: (symbol: string) => void;
}

export const SmartTrackerWidget: React.FC<SmartTrackerWidgetProps> = ({
  t,
  alerts,
  selectedSymbol,
  onSelectPair,
}) => {
  const buildSparkPath = (values: number[]) => {
    if (values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(0.00001, max - min);
    return values
      .map((v, idx) => {
        const x = (idx / (values.length - 1)) * 68;
        const y = 22 - ((v - min) / span) * 18;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  };

  return (
    <TerminalPanel
      accent="amber"
      title={t.smartTrackerTitle}
      subtitle={t.smartTrackerSub}
      rightSlot={
        <div className="flex items-center gap-2">
          <InfoTip text={t.smartTrackerSub} label={t.smartTrackerTitle} />
          <BellRing className="h-4 w-4 text-amber-300" />
        </div>
      }
      delay={0.28}
    >
      <div className="space-y-2.5">
        {alerts.map((alert) => {
          const isPos = alert.deltaPct >= 0;
          const active = alert.pair === selectedSymbol;
          const color = isPos ? '#10b981' : '#f43f5e';
          const path = buildSparkPath(alert.spark);

          return (
            <button
              key={alert.id}
              type="button"
              onClick={() => {
                audioSynth.playClick();
                onSelectPair(alert.pair);
              }}
              className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                active
                  ? 'border-amber-400/60 bg-amber-500/10'
                  : 'border-slate-800/80 bg-[#05070c] hover:border-slate-700'
              }`}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 font-mono-tech text-xs">
                  <span className="font-bold text-slate-100">{alert.pair}</span>
                  <span
                    className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      isPos
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-rose-500/15 text-rose-300'
                    }`}
                  >
                    {isPos ? (
                      <TrendingUp className="h-3 w-3" />
                    ) : (
                      <TrendingDown className="h-3 w-3" />
                    )}
                    {isPos ? '+' : ''}
                    {alert.deltaPct.toFixed(2)}%
                  </span>
                  <span className="text-[10px] text-slate-500">{alert.time}</span>
                </div>
                <div className="font-display text-xs font-semibold tracking-wide text-amber-200 uppercase">
                  {alert.title}
                </div>
                <p className="truncate font-mono-tech text-[10px] text-slate-400">{alert.desc}</p>
              </div>

              <svg viewBox="0 0 68 24" className="h-7 w-16 shrink-0">
                <path d={path} fill="none" stroke={color} strokeWidth="1.8" />
              </svg>
            </button>
          );
        })}
      </div>
    </TerminalPanel>
  );
};
