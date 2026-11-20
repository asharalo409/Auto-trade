import React, { useMemo } from 'react';
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
import { LineChart, Target, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { Trade } from '../../types/trading';
import { AnimatedNumber } from '../ui/AnimatedNumber';
import { TerminalPanel } from '../ui/TerminalPanel';

interface PerformanceScreenProps {
  t: Record<string, string>;
  trades: Trade[];
  stats: {
    balance: number;
    totalProfit: number;
  };
}

interface PerfPoint {
  label: string;
  fullLabel: string;
  pnl: number;
  cumPnl: number;
  equity: number;
}

const round2 = (n: number) => Number(n.toFixed(2));

const fmtAxisUsd = (v: number) => {
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  // Avoid collapsing every tick to the same "10.0k" when the equity range is narrow.
  if (abs >= 100_000) return `${sign}$${(abs / 1000).toFixed(0)}k`;
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
};

const fmtUsd = (v: number) =>
  `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const PerfTooltip: React.FC<{
  active?: boolean;
  label?: string | number;
  payload?: Array<{ payload?: PerfPoint }>;
  t: Record<string, string>;
}> = ({ active, label, payload, t }) => {
  const point = payload && payload[0] ? payload[0].payload : undefined;
  if (!active || !point) return null;
  return (
    <div className="rounded-lg border border-cyan-500/40 bg-[#05070d]/95 px-3 py-2 font-mono-tech text-[11px] text-slate-200 shadow-lg">
      <div className="mb-1 text-[10px] tracking-wider text-slate-400 uppercase">
        {point.fullLabel || label}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-400">{t.pnlLabel}</span>
        <span className={point.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
          {point.pnl >= 0 ? '+' : ''}${point.pnl.toFixed(2)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-400">CUM PnL</span>
        <span className={point.cumPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
          {point.cumPnl >= 0 ? '+' : ''}${point.cumPnl.toFixed(2)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-400">{t.equityCurve}</span>
        <span className="text-cyan-300">${point.equity.toFixed(2)}</span>
      </div>
    </div>
  );
};

export const PerformanceScreen: React.FC<PerformanceScreenProps> = ({ t, trades, stats }) => {
  const { points, metrics } = useMemo(() => {
    const closed = trades
      .filter((tr) => tr.status === 'CLOSED')
      .slice()
      .sort(
        (a, b) =>
          new Date(a.closed_at ?? a.opened_at).getTime() -
          new Date(b.closed_at ?? b.opened_at).getTime()
      );

    const startingEquity = Math.max(0, round2(stats.balance - stats.totalProfit));
    let cum = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let best = 0;
    let worst = 0;
    let volume = 0;

    const all: PerfPoint[] = closed.map((tr, idx) => {
      const pnl = round2(tr.profit_usdt);
      cum = round2(cum + pnl);
      volume += tr.invested_usdt;
      if (pnl > 0) grossProfit += pnl;
      if (pnl < 0) grossLoss += Math.abs(pnl);
      if (pnl > best) best = pnl;
      if (pnl < worst) worst = pnl;
      const at = new Date(tr.closed_at ?? tr.opened_at);
      return {
        label: `#${idx + 1} ${tr.pair.replace('USDT', '')}`,
        fullLabel: `${tr.pair} · ${at.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}`,
        pnl,
        cumPnl: cum,
        equity: round2(startingEquity + cum),
      };
    });

    const wins = closed.filter((tr) => tr.profit_usdt > 0).length;
    const losses = closed.filter((tr) => tr.profit_usdt < 0).length;

    return {
      points: all.length > 60 ? all.slice(-60) : all,
      metrics: {
        startingEquity,
        realizedPnl: round2(grossProfit - grossLoss),
        // No losing trade yet means the ratio is undefined, not the gross profit itself.
        profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : null,
        best: round2(best),
        worst: round2(worst),
        volume: round2(volume),
        wins,
        losses,
        closedCount: closed.length,
        winRate: closed.length > 0 ? round2((wins / closed.length) * 100) : 0,
      },
    };
  }, [trades, stats.balance, stats.totalProfit]);

  const equityData = useMemo(
    () => [
      { label: t.startLabel, fullLabel: t.startLabel, pnl: 0, cumPnl: 0, equity: metrics.startingEquity },
      ...points,
    ],
    [points, metrics.startingEquity, t.startLabel]
  );

  const hasHistory = metrics.closedCount > 0;
  const equityDelta = round2(stats.balance - metrics.startingEquity);

  const kpis: { label: string; value: string; tone: string; icon: React.ReactNode }[] = [
    {
      label: t.portfolioLabel,
      value: fmtUsd(stats.balance),
      tone: 'text-cyan-200',
      icon: <Wallet className="h-4 w-4 text-cyan-400" />,
    },
    {
      label: t.totalProfit,
      value: `${stats.totalProfit >= 0 ? '+' : ''}${fmtUsd(stats.totalProfit)}`,
      tone: stats.totalProfit >= 0 ? 'text-emerald-300' : 'text-rose-300',
      icon:
        stats.totalProfit >= 0 ? (
          <TrendingUp className="h-4 w-4 text-emerald-400" />
        ) : (
          <TrendingDown className="h-4 w-4 text-rose-400" />
        ),
    },
    {
      label: t.winRate,
      value: `${metrics.winRate.toFixed(1)}%`,
      tone: 'text-amber-200',
      icon: <Target className="h-4 w-4 text-amber-300" />,
    },
    {
      label: t.perfProfitFactor,
      value: metrics.profitFactor === null ? '∞' : metrics.profitFactor.toFixed(2),
      tone: 'text-violet-200',
      icon: <LineChart className="h-4 w-4 text-violet-300" />,
    },
  ];

  return (
    <div className="space-y-4">
      <TerminalPanel accent="cyan" title={t.perfTitle} subtitle={t.perfSub}>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {kpis.map((kpi) => (
            <div
              key={kpi.label}
              className="rounded-xl border border-slate-800/90 bg-[#05070d] p-3"
            >
              <div className="flex items-center gap-1.5 font-mono-tech text-[10px] tracking-wider text-slate-400 uppercase">
                {kpi.icon}
                <span className="truncate">{kpi.label}</span>
              </div>
              <div className={`mt-1 font-display text-lg font-bold ${kpi.tone}`}>
                {kpi.value}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5 font-mono-tech text-[11px] sm:grid-cols-4">
          <div className="rounded-lg border border-slate-800/80 bg-[#05070d] px-2.5 py-2">
            <span className="block text-[10px] tracking-wider text-slate-500 uppercase">
              {t.perfRealizedPnl}
            </span>
            <AnimatedNumber value={metrics.realizedPnl} prefix="$" decimals={2} showSign />
          </div>
          <div className="rounded-lg border border-slate-800/80 bg-[#05070d] px-2.5 py-2">
            <span className="block text-[10px] tracking-wider text-slate-500 uppercase">
              {t.perfBestTrade}
            </span>
            <span className="text-emerald-300">+{fmtUsd(metrics.best)}</span>
          </div>
          <div className="rounded-lg border border-slate-800/80 bg-[#05070d] px-2.5 py-2">
            <span className="block text-[10px] tracking-wider text-slate-500 uppercase">
              {t.perfWorstTrade}
            </span>
            <span className="text-rose-300">{fmtUsd(metrics.worst)}</span>
          </div>
          <div className="rounded-lg border border-slate-800/80 bg-[#05070d] px-2.5 py-2">
            <span className="block text-[10px] tracking-wider text-slate-500 uppercase">
              {t.perfTotalVolume}
            </span>
            <span className="text-slate-200">{fmtUsd(metrics.volume)}</span>
          </div>
        </div>
      </TerminalPanel>

      <TerminalPanel
        accent="emerald"
        title={t.equityCurve}
        subtitle={t.perfEquitySub}
        rightSlot={
          <span
            className={`font-mono-tech text-xs font-semibold ${
              equityDelta >= 0 ? 'text-emerald-300' : 'text-rose-300'
            }`}
          >
            {equityDelta >= 0 ? '+' : ''}
            {fmtUsd(equityDelta)}
          </span>
        }
      >
        <div className="h-64 w-full sm:h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={equityData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id="perfEquityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: '#64748b', fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: '#1e293b' }}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={{ fill: '#64748b', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={58}
                domain={['auto', 'auto']}
                tickFormatter={fmtAxisUsd}
              />
              <Tooltip content={<PerfTooltip t={t} />} />
              <Area
                type="monotone"
                dataKey="equity"
                stroke="#22d3ee"
                strokeWidth={2}
                fill="url(#perfEquityFill)"
                dot={false}
                activeDot={{ r: 3, fill: '#22d3ee' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        {!hasHistory && (
          <div className="mt-2 text-center font-mono-tech text-[11px] text-slate-500">
            {t.perfNoData}
          </div>
        )}
      </TerminalPanel>

      <TerminalPanel
        accent="crimson"
        title={t.pnlHistoryTitle}
        subtitle={t.pnlHistorySub}
        rightSlot={
          <span className="font-mono-tech text-xs text-slate-400">
            {metrics.closedCount} {t.perfClosedTrades} · {metrics.wins}W / {metrics.losses}L
          </span>
        }
      >
        {hasHistory ? (
          <div className="h-60 w-full sm:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={points} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: '#1e293b' }}
                  interval="preserveStartEnd"
                  minTickGap={20}
                />
                <YAxis
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={54}
                  tickFormatter={fmtAxisUsd}
                />
                <Tooltip content={<PerfTooltip t={t} />} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
                <ReferenceLine y={0} stroke="#475569" />
                <Bar dataKey="pnl" radius={[3, 3, 0, 0]} maxBarSize={26}>
                  {points.map((p) => (
                    <Cell key={p.fullLabel} fill={p.pnl >= 0 ? '#34d399' : '#fb7185'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center font-mono-tech text-xs text-slate-400">
            <LineChart className="h-6 w-6 text-slate-600" />
            <span>{t.perfNoData}</span>
          </div>
        )}
      </TerminalPanel>
    </div>
  );
};
