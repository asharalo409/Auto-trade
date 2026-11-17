import React, { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  Power,
  Radio,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { audioSynth } from '../../lib/audioSynth';
import { TERMINAL_THEMES } from '../../lib/themes';
import {
  BotSettings,
  BotStatus,
  CandleStyle,
  CoreVisualMode,
  EquityPoint,
  EquityTimeframe,
  LogEntry,
  PairMarketData,
  SmartAlert,
  ThemeId,
  Trade,
  TradingMode,
} from '../../types/trading';
import { CandlestickChart } from '../charts/CandlestickChart';
import { QuantumCore3D } from '../three/QuantumCore3D';
import { AnimatedNumber } from '../ui/AnimatedNumber';
import { InfoTip } from '../ui/InfoTip';
import { SkeletonBlock } from '../ui/MotionPrimitives';
import { TerminalPanel } from '../ui/TerminalPanel';
import { BinanceOrderBook } from '../widgets/BinanceOrderBook';
import { MarketSentimentWidget } from '../widgets/MarketSentimentWidget';
import { SmartTrackerWidget } from '../widgets/SmartTrackerWidget';

interface CommandCenterProps {
  t: Record<string, string>;
  workspace: TradingMode;
  settings: BotSettings;
  effectiveTheme: ThemeId;
  botStatus: BotStatus;
  loading: boolean;
  stats: {
    balance: number;
    todayProfit: number;
    totalProfit: number;
    winRate: number;
    openTradesCount: number;
    totalTradesCount: number;
    lockedCapital: number;
    availableBalance: number;
  };
  trades: Trade[];
  logs: LogEntry[];
  marketPairs: PairMarketData[];
  smartAlerts: SmartAlert[];
  binanceFeedLive: boolean;
  getEquitySeries: (tf: EquityTimeframe) => EquityPoint[];
  onToggleBot: () => Promise<void>;
  onChangeCoreVisual: (mode: CoreVisualMode) => Promise<void>;
  onChangeCandleStyle: (style: CandleStyle) => Promise<void>;
  onQuickTrade: (pairSymbol: string, side: 'BUY' | 'SELL', amountUsdt: number) => Promise<void>;
  onResetVirtual: () => void;
  onNavigateTab: (tab: 'trades' | 'feed' | 'market' | 'settings') => void;
}

const TIMEFRAMES: EquityTimeframe[] = ['1D', '1W', '1M', 'ALL'];

export const CommandCenter: React.FC<CommandCenterProps> = ({
  t,
  workspace,
  settings,
  effectiveTheme,
  botStatus,
  loading,
  stats,
  trades,
  logs,
  marketPairs,
  smartAlerts,
  binanceFeedLive,
  getEquitySeries,
  onToggleBot,
  onChangeCoreVisual,
  onChangeCandleStyle,
  onQuickTrade,
  onResetVirtual,
  onNavigateTab,
}) => {
  const reducedMotion = useReducedMotion();
  const [timeframe, setTimeframe] = useState<EquityTimeframe>('1D');
  const [chartPair, setChartPair] = useState<string>('BTCUSDT');
  const [toggling, setToggling] = useState(false);

  const equityData = getEquitySeries(timeframe);
  const isRunning = botStatus === 'RUNNING';
  const isOffline = botStatus === 'OFFLINE';
  const theme = TERMINAL_THEMES[effectiveTheme];

  const handlePowerClick = async () => {
    setToggling(true);
    await onToggleBot();
    setToggling(false);
  };

  const statusLabel = isOffline
    ? t.statusOffline
    : isRunning
      ? t.statusRunning
      : t.statusStopped;

  const statusHint = isOffline
    ? t.botStatusHintOffline
    : isRunning
      ? t.botStatusHintRunning
      : t.botStatusHintStopped;

  const openTrades = trades.filter((tr) => tr.status === 'OPEN').slice(0, 3);
  const recentLogs = logs.slice(-4).reverse();

  const coreStyles: { id: CoreVisualMode; label: string }[] = [
    { id: 'torus', label: t.coreStyleTorus },
    { id: 'lorenz', label: t.coreStyleLorenz },
    { id: 'vortex', label: t.coreStyleVortex },
    { id: 'depth', label: t.coreStyleDepth },
  ];

  const kpis = [
    {
      label: t.balance,
      value: stats.balance,
      prefix: '$',
      decimals: 2,
      showSign: false,
      colorClass: 'text-cyan-300',
      accent: 'cyan' as const,
    },
    {
      label: t.todayProfit,
      value: stats.todayProfit,
      prefix: '$',
      decimals: 2,
      showSign: true,
      colorClass: stats.todayProfit >= 0 ? 'text-emerald-400' : 'text-rose-400',
      accent: (stats.todayProfit >= 0 ? 'emerald' : 'crimson') as 'emerald' | 'crimson',
    },
    {
      label: t.totalProfit,
      value: stats.totalProfit,
      prefix: '$',
      decimals: 2,
      showSign: true,
      colorClass: stats.totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400',
      accent: (stats.totalProfit >= 0 ? 'emerald' : 'crimson') as 'emerald' | 'crimson',
    },
    {
      label: t.winRate,
      value: stats.winRate,
      suffix: '%',
      decimals: 1,
      showSign: false,
      colorClass: 'text-amber-300',
      accent: 'amber' as const,
    },
    {
      label: t.openTrades,
      value: stats.openTradesCount,
      decimals: 0,
      showSign: false,
      colorClass: 'text-cyan-300',
      accent: 'cyan' as const,
    },
    {
      label: t.totalTrades,
      value: stats.totalTradesCount,
      decimals: 0,
      showSign: false,
      colorClass: 'text-slate-100',
      accent: 'neutral' as const,
    },
  ];

  const renderLatestDot = (props: { cx?: number; cy?: number; index?: number }) => {
    const { cx, cy, index } = props;
    if (cx == null || cy == null || index !== equityData.length - 1)
      return <g key={`dot-${index}`} />;
    return (
      <g key="latest-pulse-dot">
        {!reducedMotion && (
          <circle cx={cx} cy={cy} r={9} fill={theme.secondaryHex} opacity={0.28}>
            <animate
              attributeName="r"
              values="5;13;5"
              dur="2.2s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.45;0;0.45"
              dur="2.2s"
              repeatCount="indefinite"
            />
          </circle>
        )}
        <circle
          cx={cx}
          cy={cy}
          r={4.5}
          fill={theme.primaryHex}
          stroke="#05060a"
          strokeWidth={2}
        />
      </g>
    );
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <SkeletonBlock className="h-72 lg:col-span-5" />
          <SkeletonBlock className="h-72 lg:col-span-7" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Workspace Banner (Virtual vs Live Isolated Pages) */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-2.5 ${
          workspace === 'LIVE'
            ? 'border-rose-500/45 bg-rose-500/10'
            : 'border-cyan-500/30 bg-cyan-500/8'
        }`}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5 font-display text-sm font-bold tracking-wider uppercase">
            <span className={workspace === 'LIVE' ? 'text-rose-300' : 'text-cyan-300'}>
              {workspace === 'LIVE' ? t.liveBannerTitle : t.virtualBannerTitle}
            </span>
            {settings.zero_loss_mode && (
              <span className="inline-flex items-center gap-1 font-mono-tech text-[10px] font-semibold text-emerald-400">
                <ShieldCheck className="h-3.5 w-3.5" />
                {t.zeroLossBadge}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {workspace === 'LIVE' ? t.liveBannerSub : t.virtualBannerSub}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="font-mono-tech text-[11px] text-slate-300">
            LOT: <strong className="text-emerald-300">${settings.amount_per_trade}</strong>
          </span>
          {workspace === 'DEMO' ? (
            <button
              type="button"
              onClick={onResetVirtual}
              className="flex min-h-[34px] cursor-pointer items-center gap-1.5 rounded-lg border border-cyan-400/45 bg-cyan-500/12 px-2.5 py-1 font-mono-tech text-[11px] font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/20"
            >
              <RotateCcw className="h-3 w-3" />
              {t.resetVirtualBtn}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigateTab('settings')}
              className="min-h-[34px] cursor-pointer rounded-lg border border-rose-400/50 bg-rose-500/15 px-2.5 py-1 font-mono-tech text-[11px] font-semibold text-rose-200 transition-colors hover:bg-rose-500/25"
            >
              API & Keys →
            </button>
          )}
        </div>
      </div>

      {workspace === 'LIVE' && !settings.bot_enabled && (
        <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-2.5 font-mono-tech text-xs text-amber-200">
          {t.liveIdleNotice}
        </div>
      )}

      {/* Row 1: Giant Bot Power Button + 3D Quantum Core + Equity Curve */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <TerminalPanel
          accent={isOffline ? 'crimson' : isRunning ? 'emerald' : 'neutral'}
          title={t.quantumCoreTitle}
          subtitle={statusHint}
          rightSlot={
            <div className="flex items-center gap-2">
              <InfoTip text={t.helpQuantumCore} label={t.quantumCoreTitle} />
              <span
                className={`font-mono-tech text-[11px] font-bold tracking-widest uppercase ${
                  isOffline
                    ? 'text-rose-400'
                    : isRunning
                      ? 'text-emerald-400'
                      : 'text-slate-400'
                }`}
              >
                {statusLabel}
              </span>
            </div>
          }
          className="lg:col-span-5"
          delay={0.04}
        >
          <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-2">
            {/* Giant Glowing Circular Bot Power Button */}
            <div className="flex flex-col items-center justify-center py-2">
              <div className="relative flex h-44 w-44 items-center justify-center">
                {isRunning && !reducedMotion && (
                  <>
                    <motion.div
                      animate={{ scale: [1, 1.12, 1], opacity: [0.35, 0.08, 0.35] }}
                      transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
                      className="pointer-events-none absolute inset-0 rounded-full border border-emerald-400/50 shadow-[0_0_40px_rgba(16,185,129,0.4)]"
                    />
                    <div
                      aria-hidden="true"
                      className="animate-orbit-slow pointer-events-none absolute inset-2 rounded-full border border-dashed border-cyan-400/45"
                    />
                    <div
                      aria-hidden="true"
                      className="animate-orbit-fast pointer-events-none absolute inset-4 rounded-full opacity-45"
                      style={{
                        background:
                          'conic-gradient(from 0deg, rgba(16,185,129,0.55) 0deg, transparent 70deg, transparent 360deg)',
                      }}
                    />
                  </>
                )}

                {isOffline && (
                  <div className="pointer-events-none absolute inset-2 rounded-full border border-dashed border-rose-500/50" />
                )}

                <motion.button
                  type="button"
                  disabled={toggling}
                  onClick={handlePowerClick}
                  onMouseEnter={() => audioSynth.playHover()}
                  whileTap={reducedMotion ? undefined : { scale: 0.94 }}
                  whileHover={reducedMotion ? undefined : { scale: 1.03 }}
                  aria-label={settings.bot_enabled ? t.botPowerOff : t.botPowerOn}
                  className={`relative z-10 flex h-32 w-32 cursor-pointer flex-col items-center justify-center rounded-full border-2 transition-all focus-visible:outline-2 focus-visible:outline-cyan-400 ${
                    isRunning
                      ? 'border-emerald-400 bg-gradient-to-b from-emerald-500/25 to-[#050b09] text-emerald-300 shadow-[0_0_35px_rgba(16,185,129,0.5),inset_0_0_20px_rgba(16,185,129,0.25)]'
                      : isOffline
                        ? 'border-rose-500/70 bg-gradient-to-b from-rose-500/15 to-[#0d0608] text-rose-300 shadow-[0_0_24px_rgba(244,63,94,0.3)]'
                        : 'border-slate-700 bg-gradient-to-b from-slate-800/40 to-[#07090f] text-slate-400 hover:border-slate-500 hover:text-slate-200'
                  }`}
                >
                  <Power
                    className={`h-9 w-9 transition-transform duration-300 ${
                      isRunning ? 'drop-shadow-[0_0_10px_rgba(52,211,153,0.9)]' : ''
                    }`}
                  />
                  <span className="mt-1.5 font-display text-sm font-bold tracking-widest uppercase">
                    {settings.bot_enabled ? 'ON' : 'OFF'}
                  </span>
                </motion.button>
              </div>

              <div className="mt-2 flex items-center gap-2 font-mono-tech text-[11px] text-slate-400">
                <Radio
                  className={`h-3.5 w-3.5 ${
                    isOffline
                      ? 'text-rose-400'
                      : isRunning
                        ? 'text-emerald-400'
                        : 'text-slate-500'
                  }`}
                />
                <span>
                  {t.heartbeatLabel}:{' '}
                  {new Date(settings.last_heartbeat).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              </div>
            </div>

            {/* 3D Core Radar Centerpiece + Trade Nodes + Design Switcher */}
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-800/70 bg-[#05070d] p-2">
              <QuantumCore3D
                status={botStatus}
                openTradesCount={stats.openTradesCount}
                visualMode={settings.core_visual}
                themeId={effectiveTheme}
                trades={trades}
                t={t}
              />
              <div className="mt-1.5 flex w-full flex-wrap items-center justify-center gap-1 px-1">
                {coreStyles.map((cs) => (
                  <button
                    key={cs.id}
                    type="button"
                    onClick={() => {
                      audioSynth.playClick();
                      onChangeCoreVisual(cs.id);
                    }}
                    className={`cursor-pointer rounded px-2 py-0.5 font-mono-tech text-[10px] uppercase transition-colors ${
                      settings.core_visual === cs.id
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {cs.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </TerminalPanel>

        {/* Equity Curve Chart */}
        <TerminalPanel
          accent="cyan"
          title={t.equityCurve}
          subtitle={`${workspace} · ${t.availableCapital}: $${stats.availableBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
          rightSlot={
            <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#05060a] p-1">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => {
                    audioSynth.playClick();
                    setTimeframe(tf);
                  }}
                  className={`min-h-[32px] cursor-pointer rounded px-2.5 py-1 font-mono-tech text-[11px] font-semibold transition-colors ${
                    timeframe === tf
                      ? 'bg-cyan-500/20 text-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.25)]'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          }
          className="lg:col-span-7"
          delay={0.1}
        >
          <div className="h-60 w-full sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={equityData} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="equityGlowGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.secondaryHex} stopOpacity={0.45} />
                    <stop offset="55%" stopColor={theme.primaryHex} stopOpacity={0.14} />
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
                  stroke="#64748b"
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
                  domain={['auto', 'auto']}
                  tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
                  fontFamily="JetBrains Mono"
                  width={68}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#090d16',
                    border: `1px solid ${theme.borderGlow}`,
                    borderRadius: '8px',
                    fontFamily: 'JetBrains Mono',
                    fontSize: '12px',
                    color: '#f1f5f9',
                  }}
                  formatter={(value: unknown) => [
                    `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
                    'Equity',
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="equity"
                  stroke={theme.primaryHex}
                  strokeWidth={2.2}
                  fill="url(#equityGlowGrad)"
                  isAnimationActive={!reducedMotion}
                  animationDuration={850}
                  dot={renderLatestDot as never}
                  activeDot={{ r: 5, fill: theme.primaryHex, stroke: '#05060a', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </TerminalPanel>
      </div>

      {/* Row 2: 6 Big Count-Up Stat Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {kpis.map((kpi, idx) => (
          <TerminalPanel
            key={kpi.label}
            accent={kpi.accent}
            delay={0.14 + idx * 0.03}
            sweep={false}
          >
            <div className="space-y-1.5">
              <div className="font-display text-[11px] font-semibold tracking-wider text-slate-400 uppercase truncate">
                {kpi.label}
              </div>
              <div className={`text-xl font-bold sm:text-2xl ${kpi.colorClass}`}>
                <AnimatedNumber
                  value={kpi.value}
                  decimals={kpi.decimals}
                  prefix={kpi.prefix}
                  suffix={kpi.suffix}
                  showSign={kpi.showSign}
                />
              </div>
            </div>
          </TerminalPanel>
        ))}
      </div>

      {/* Row 3: Pro Multi-Mode Candlestick Chart + Live Order Book / Depth / Quick Trade */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <TerminalPanel
          accent="cyan"
          title={t.candlestickTitle}
          subtitle="OHLCV · MA / EMA / BOLL / VWAP · Trade Markers (Buy & Profit/Loss)"
          rightSlot={<InfoTip text={t.helpCandlestick} label={t.candlestickTitle} />}
          className="lg:col-span-8"
        >
          <CandlestickChart
            pairs={marketPairs}
            selectedSymbol={chartPair}
            onSelectSymbol={setChartPair}
            candleStyle={settings.candle_style}
            onChangeCandleStyle={onChangeCandleStyle}
            t={t}
            binanceFeedLive={binanceFeedLive}
            trades={trades}
          />
        </TerminalPanel>

        <div className="lg:col-span-4">
          <BinanceOrderBook
            t={t}
            pair={marketPairs.find((p) => p.symbol === chartPair) ?? marketPairs[0]}
            defaultLot={settings.amount_per_trade}
            onQuickTrade={onQuickTrade}
          />
        </div>
      </div>

      {/* Row 4: Market Sentiment (Fear & Greed Gauge) + Smart Tracker */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <MarketSentimentWidget t={t} />
        </div>
        <div className="lg:col-span-6">
          <SmartTrackerWidget
            t={t}
            alerts={smartAlerts}
            selectedSymbol={chartPair}
            onSelectPair={setChartPair}
          />
        </div>
      </div>

      {/* Row 5: Open Positions + Live Feed Preview */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <TerminalPanel
          accent="emerald"
          title={t.openPositionsTitle}
          rightSlot={
            <button
              type="button"
              onClick={() => onNavigateTab('trades')}
              className="min-h-[36px] cursor-pointer rounded border border-emerald-500/35 px-2.5 py-1 font-mono-tech text-[11px] text-emerald-300 transition-colors hover:bg-emerald-500/15"
            >
              {t.navTrades} →
            </button>
          }
          className="lg:col-span-6"
          delay={0.22}
        >
          {openTrades.length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-xs text-slate-400">
              <TrendingUp className="h-4 w-4 text-slate-500" />
              <span>{t.noOpenTrades}</span>
            </div>
          ) : (
            <div className="space-y-2.5">
              {openTrades.map((trade) => {
                const isPos = trade.profit_usdt >= 0;
                const progress = Math.max(
                  4,
                  Math.min(
                    100,
                    ((trade.current_price - trade.entry_price) /
                      Math.max(0.0001, trade.take_profit_price - trade.entry_price)) *
                      100
                  )
                );
                return (
                  <div
                    key={trade.id}
                    className="rounded-lg border border-slate-800/80 bg-[#05070c] px-3 py-2.5"
                  >
                    <div className="flex items-center justify-between gap-2 font-mono-tech text-xs">
                      <span className="font-semibold text-slate-100">{trade.pair}</span>
                      <span className="text-slate-400">${trade.invested_usdt}</span>
                      <span className={isPos ? 'text-emerald-400' : 'text-rose-400'}>
                        {isPos ? '+' : ''}${trade.profit_usdt.toFixed(2)} ({isPos ? '+' : ''}
                        {trade.profit_pct.toFixed(2)}%)
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        className={`relative h-full overflow-hidden rounded-full transition-all duration-500 ${
                          isPos ? 'bg-emerald-400' : 'bg-rose-500'
                        }`}
                        style={{ width: `${progress}%` }}
                      >
                        {!reducedMotion && (
                          <div className="animate-tp-shimmer absolute inset-0 w-1/2 bg-gradient-to-r from-transparent via-white/50 to-transparent" />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TerminalPanel>

        <TerminalPanel
          accent="cyan"
          title={t.liveFeedTitle}
          rightSlot={
            <button
              type="button"
              onClick={() => onNavigateTab('feed')}
              className="min-h-[36px] cursor-pointer rounded border border-cyan-500/35 px-2.5 py-1 font-mono-tech text-[11px] text-cyan-300 transition-colors hover:bg-cyan-500/15"
            >
              {t.navFeed} →
            </button>
          }
          className="lg:col-span-6"
          delay={0.26}
        >
          <div className="space-y-2 font-mono-tech text-xs">
            {recentLogs.map((log) => {
              const lvlCls =
                log.level === 'TRADE'
                  ? 'text-emerald-400'
                  : log.level === 'WARNING'
                    ? 'text-amber-300'
                    : log.level === 'ERROR'
                      ? 'text-rose-400'
                      : 'text-cyan-300';
              return (
                <div
                  key={log.id}
                  className="flex items-start gap-2 rounded border border-slate-800/70 bg-[#05070c] px-2.5 py-2"
                >
                  <span className={`shrink-0 font-semibold ${lvlCls}`}>[{log.level}]</span>
                  <span className="min-w-0 flex-1 text-slate-300 truncate">
                    {log.pair ? `${log.pair}: ` : ''}
                    {log.message}
                  </span>
                </div>
              );
            })}
            {recentLogs.length === 0 && (
              <div className="flex items-center gap-2 py-4 text-slate-400">
                <Activity className="h-4 w-4" />
                <span>{t.emptyFeed}</span>
              </div>
            )}
          </div>
        </TerminalPanel>
      </div>

      {isOffline && (
        <div className="flex items-center gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-mono-tech text-xs text-rose-200">
          <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
          <span>{t.botStatusHintOffline}</span>
        </div>
      )}
    </div>
  );
};
