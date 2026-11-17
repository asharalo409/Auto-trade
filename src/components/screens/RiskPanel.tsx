import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BotSettings } from '../../types/trading';
import { AnimatedNumber } from '../ui/AnimatedNumber';
import { TerminalPanel } from '../ui/TerminalPanel';

interface RiskPanelProps {
  t: Record<string, string>;
  settings: BotSettings;
  stats: {
    balance: number;
    lockedCapital: number;
    availableBalance: number;
    todayLoss: number;
    exposurePerPair: { pair: string; fullPair: string; amount: number }[];
  };
}

export const RiskPanel: React.FC<RiskPanelProps> = ({ t, settings, stats }) => {
  const reducedMotion = useReducedMotion();
  const limit = Math.max(1, settings.daily_loss_limit);
  const lossRatio = Math.min(1, stats.todayLoss / limit);
  const lossPct = Math.round(lossRatio * 100);

  const utilizationPct =
    stats.balance > 0 ? Math.min(100, (stats.lockedCapital / stats.balance) * 100) : 0;

  const radius = 78;
  const circumference = Math.PI * radius;
  const dashOffset = circumference * (1 - lossRatio);

  const gaugeColor =
    lossRatio >= 0.8 ? '#f43f5e' : lossRatio >= 0.45 ? '#f59e0b' : '#10b981';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <TerminalPanel
          accent={lossRatio >= 0.8 ? 'crimson' : 'amber'}
          title={t.dailyLossGauge}
          subtitle={`${t.dailyLimitCap}: $${settings.daily_loss_limit.toFixed(2)} USDT`}
          className="lg:col-span-5"
        >
          <div className="flex flex-col items-center justify-center py-2">
            <div className="relative flex h-44 w-64 items-end justify-center">
              <svg viewBox="0 0 200 115" className="h-full w-full overflow-visible">
                <path
                  d="M 22 100 A 78 78 0 0 1 178 100"
                  fill="none"
                  stroke="#1e293b"
                  strokeWidth="14"
                  strokeLinecap="round"
                />
                <motion.path
                  d="M 22 100 A 78 78 0 0 1 178 100"
                  fill="none"
                  stroke={gaugeColor}
                  strokeWidth="14"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  initial={reducedMotion ? false : { strokeDashoffset: circumference }}
                  animate={{ strokeDashoffset: dashOffset }}
                  transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                  style={{
                    filter: `drop-shadow(0 0 8px ${gaugeColor})`,
                  }}
                />
              </svg>
              <div className="absolute bottom-2 text-center">
                <div className="font-mono-tech text-2xl font-bold text-white">
                  {lossPct}%
                </div>
                <div className="font-mono-tech text-[11px] text-slate-400">
                  ${stats.todayLoss.toFixed(2)} / ${settings.daily_loss_limit.toFixed(2)}
                </div>
              </div>
            </div>

            <div className="mt-4 grid w-full grid-cols-2 gap-3 border-t border-slate-800 pt-3 font-mono-tech text-xs">
              <div>
                <span className="block text-[10px] text-slate-400 uppercase">
                  {t.dailyLossUsed}
                </span>
                <span className="text-sm font-bold text-rose-400">
                  -${stats.todayLoss.toFixed(2)}
                </span>
              </div>
              <div className="text-right">
                <span className="block text-[10px] text-slate-400 uppercase">
                  {t.dailyLimitCap}
                </span>
                <span className="text-sm font-bold text-amber-300">
                  ${settings.daily_loss_limit.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </TerminalPanel>

        <TerminalPanel
          accent="cyan"
          title={t.exposurePerPair}
          subtitle={`Max Per Pair: $${settings.max_amount_per_pair} USDT`}
          className="lg:col-span-7"
        >
          {stats.exposurePerPair.length === 0 ? (
            <div className="flex h-56 items-center justify-center font-mono-tech text-xs text-slate-500">
              {t.noOpenTrades}
            </div>
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.exposurePerPair}
                  margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
                >
                  <CartesianGrid
                    stroke="rgba(51,65,85,0.28)"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="pair"
                    stroke="#94a3b8"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    fontFamily="JetBrains Mono"
                  />
                  <YAxis
                    stroke="#64748b"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${v}`}
                    fontFamily="JetBrains Mono"
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#090d16',
                      border: '1px solid rgba(34,211,238,0.4)',
                      borderRadius: '8px',
                      fontFamily: 'JetBrains Mono',
                      fontSize: '12px',
                    }}
                    formatter={(val: unknown) => [`$${Number(val).toFixed(2)} USDT`, 'Exposure']}
                  />
                  <Bar
                    dataKey="amount"
                    radius={[6, 6, 0, 0]}
                    isAnimationActive={!reducedMotion}
                  >
                    {stats.exposurePerPair.map((entry) => (
                      <Cell
                        key={entry.pair}
                        fill={
                          entry.amount >= settings.max_amount_per_pair * 0.8
                            ? '#f59e0b'
                            : '#22d3ee'
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </TerminalPanel>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TerminalPanel accent="amber" sweep={false}>
          <div className="font-display text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            {t.lockedCapital}
          </div>
          <div className="mt-1 text-2xl font-bold text-amber-300">
            <AnimatedNumber value={stats.lockedCapital} prefix="$" decimals={2} />
          </div>
        </TerminalPanel>

        <TerminalPanel accent="emerald" sweep={false}>
          <div className="font-display text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            {t.availableCapital}
          </div>
          <div className="mt-1 text-2xl font-bold text-emerald-400">
            <AnimatedNumber value={stats.availableBalance} prefix="$" decimals={2} />
          </div>
        </TerminalPanel>

        <TerminalPanel accent="cyan" sweep={false}>
          <div className="font-display text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            {t.utilizationRate}
          </div>
          <div className="mt-1 text-2xl font-bold text-cyan-300">
            <AnimatedNumber value={utilizationPct} suffix="%" decimals={1} />
          </div>
        </TerminalPanel>
      </div>
    </div>
  );
};
