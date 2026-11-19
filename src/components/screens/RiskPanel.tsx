import React, { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BotSettings, Trade } from '../../types/trading';
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
  trades: Trade[];
}

interface DailyPnlPoint {
  dateKey: string;
  label: string;
  fullDate: string;
  realizedPnl: number;
  tradeCount: number;
  cumPnl: number;
}

function toLocalDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const RiskPanel: React.FC<RiskPanelProps> = ({ t, settings, stats, trades }) => {
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

  // Aggregate daily realized PnL across the trailing 30 calendar days
  const { dailySeries, net30d, winDays, lossDays, closedCount30d } = useMemo(() => {
    const byDay = new Map<string, { pnl: number; count: number }>();

    for (const tr of trades) {
      if (tr.status !== 'CLOSED') continue;
      const dt = new Date(tr.closed_at ?? tr.opened_at);
      if (Number.isNaN(dt.getTime())) continue;
      const key = toLocalDateKey(dt);
      const prev = byDay.get(key) ?? { pnl: 0, count: 0 };
      byDay.set(key, {
        pnl: prev.pnl + tr.profit_usdt,
        count: prev.count + 1,
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const points: DailyPnlPoint[] = [];
    let runningCum = 0;
    let wins = 0;
    let losses = 0;
    let closedCount = 0;

    for (let offset = 29; offset >= 0; offset--) {
      const d = new Date(today);
      d.setDate(today.getDate() - offset);
      const key = toLocalDateKey(d);
      const bucket = byDay.get(key);
      const pnl = Number((bucket?.pnl ?? 0).toFixed(2));
      const count = bucket?.count ?? 0;

      runningCum = Number((runningCum + pnl).toFixed(2));
      closedCount += count;
      if (pnl > 0) wins += 1;
      else if (pnl < 0) losses += 1;

      points.push({
        dateKey: key,
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        fullDate: d.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        realizedPnl: pnl,
        tradeCount: count,
        cumPnl: runningCum,
      });
    }

    return {
      dailySeries: points,
      net30d: runningCum,
      winDays: wins,
      lossDays: losses,
      closedCount30d: closedCount,
    };
  }, [trades]);

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

      {/* 30-Day Daily Realized Profit & Loss Bar Chart */}
      <TerminalPanel
        accent={net30d >= 0 ? 'emerald' : 'crimson'}
        title={t.dailyRealizedPnlTitle}
        subtitle={t.dailyRealizedPnlSub}
        rightSlot={
          <div className="flex flex-wrap items-center gap-3 font-mono-tech text-xs">
            <span className="text-slate-400">
              {winDays}W / {lossDays}L · {closedCount30d} TRADES
            </span>
            <span
              className={`font-bold ${
                net30d >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {t.net30dPnlLabel}: {net30d >= 0 ? '+' : ''}${net30d.toFixed(2)}
            </span>
          </div>
        }
      >
        <div className="h-60 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={dailySeries}
              margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                stroke="rgba(51,65,85,0.28)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                stroke="#94a3b8"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                minTickGap={18}
                fontFamily="JetBrains Mono"
              />
              <YAxis
                stroke="#64748b"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v))}`}
                fontFamily="JetBrains Mono"
              />
              <ReferenceLine
                y={0}
                stroke="rgba(148,163,184,0.45)"
                strokeDasharray="3 3"
              />
              <Tooltip
                cursor={{ fill: 'rgba(34,211,238,0.06)' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const pt = payload[0].payload as DailyPnlPoint;
                  const pos = pt.realizedPnl >= 0;
                  return (
                    <div className="rounded-lg border border-cyan-500/40 bg-[#090d16]/95 px-3 py-2 font-mono-tech text-[11px] shadow-xl">
                      <div className="font-bold text-slate-200">{pt.fullDate}</div>
                      <div
                        className={`mt-1 text-xs font-bold ${
                          pt.realizedPnl === 0
                            ? 'text-slate-400'
                            : pos
                              ? 'text-emerald-400'
                              : 'text-rose-400'
                        }`}
                      >
                        Realized: {pos ? '+' : ''}${pt.realizedPnl.toFixed(2)} USDT
                      </div>
                      <div className="mt-0.5 text-slate-400">
                        Closed Trades: {pt.tradeCount}
                      </div>
                      <div className="mt-0.5 text-cyan-300">
                        30D Cumulative: {pt.cumPnl >= 0 ? '+' : ''}${pt.cumPnl.toFixed(2)}
                      </div>
                    </div>
                  );
                }}
              />
              <Bar
                dataKey="realizedPnl"
                radius={[4, 4, 0, 0]}
                isAnimationActive={!reducedMotion}
              >
                {dailySeries.map((day) => (
                  <Cell
                    key={day.dateKey}
                    fill={
                      day.realizedPnl > 0
                        ? '#10b981'
                        : day.realizedPnl < 0
                          ? '#f43f5e'
                          : 'rgba(100,116,139,0.28)'
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </TerminalPanel>

      {/* Cumulative Profit & Loss History Area Chart */}
      <TerminalPanel
        accent={net30d >= 0 ? 'cyan' : 'crimson'}
        title={t.cumPnlChartTitle}
        subtitle={t.cumPnlChartSub}
        rightSlot={
          <span
            className={`font-mono-tech text-xs font-bold ${
              net30d >= 0 ? 'text-cyan-300' : 'text-rose-400'
            }`}
          >
            Trajectory: {net30d >= 0 ? '+' : ''}${net30d.toFixed(2)} USDT
          </span>
        }
      >
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={dailySeries}
              margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="cumPnlGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.42} />
                  <stop offset="65%" stopColor="#10b981" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#05060a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                stroke="rgba(51,65,85,0.28)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                stroke="#94a3b8"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                minTickGap={18}
                fontFamily="JetBrains Mono"
              />
              <YAxis
                stroke="#64748b"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v))}`}
                fontFamily="JetBrains Mono"
              />
              <ReferenceLine y={0} stroke="rgba(148,163,184,0.45)" strokeDasharray="3 3" />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const pt = payload[0].payload as DailyPnlPoint;
                  const pos = pt.cumPnl >= 0;
                  return (
                    <div className="rounded-lg border border-cyan-500/40 bg-[#090d16]/95 px-3 py-2 font-mono-tech text-[11px] shadow-xl">
                      <div className="font-bold text-slate-200">{pt.fullDate}</div>
                      <div
                        className={`mt-1 text-xs font-bold ${
                          pos ? 'text-cyan-300' : 'text-rose-400'
                        }`}
                      >
                        Cumulative PnL: {pos ? '+' : ''}${pt.cumPnl.toFixed(2)} USDT
                      </div>
                      <div className="mt-0.5 text-slate-400">
                        Daily Realized: {pt.realizedPnl >= 0 ? '+' : ''}${pt.realizedPnl.toFixed(2)}
                      </div>
                    </div>
                  );
                }}
              />
              <Area
                type="monotone"
                dataKey="cumPnl"
                stroke="#22d3ee"
                strokeWidth={2.4}
                fill="url(#cumPnlGrad)"
                isAnimationActive={!reducedMotion}
                animationDuration={900}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </TerminalPanel>

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
