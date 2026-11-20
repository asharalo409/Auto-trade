import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Calculator,
  RefreshCw,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { audioSynth } from '../../lib/audioSynth';
import { telegramHaptic } from '../../lib/telegramWebApp';
import { PairMarketData, TradingMode } from '../../types/trading';

export interface CoinFlashSignal {
  symbol: string;
  direction: 'up' | 'down';
  id: string;
}

interface PremiumCommandHeroProps {
  workspace: TradingMode;
  balance: number;
  todayProfit: number;
  dailyGoalUsd: number;
  hasBinanceKeys: boolean;
  syncingBalance: boolean;
  botRunning: boolean;
  pairs: PairMarketData[];
  focusedSymbol: string;
  flashSignal?: CoinFlashSignal | null;
  onFocusCoin: (symbol: string) => void;
  onSyncBalance: () => void;
  onOpenCalculator: () => void;
}

interface CoinMeta {
  symbol: string;
  ticker: string;
  name: string;
  ring: string;
  text: string;
}

const COINS: CoinMeta[] = [
  { symbol: 'BTCUSDT', ticker: 'BTC', name: 'Bitcoin', ring: 'from-amber-400/90 to-orange-600/90', text: 'text-amber-300' },
  { symbol: 'ETHUSDT', ticker: 'ETH', name: 'Ethereum', ring: 'from-indigo-400/90 to-violet-600/90', text: 'text-indigo-300' },
  { symbol: 'SOLUSDT', ticker: 'SOL', name: 'Solana', ring: 'from-fuchsia-400/90 to-emerald-500/90', text: 'text-fuchsia-300' },
  { symbol: 'BNBUSDT', ticker: 'BNB', name: 'BNB', ring: 'from-yellow-300/90 to-amber-500/90', text: 'text-yellow-300' },
  { symbol: 'XRPUSDT', ticker: 'XRP', name: 'XRP', ring: 'from-slate-300/90 to-slate-500/90', text: 'text-slate-200' },
  { symbol: 'AVAXUSDT', ticker: 'AVAX', name: 'Avalanche', ring: 'from-rose-400/90 to-red-600/90', text: 'text-rose-300' },
  { symbol: 'DOGEUSDT', ticker: 'DOGE', name: 'Dogecoin', ring: 'from-amber-200/90 to-yellow-600/90', text: 'text-amber-200' },
  { symbol: 'ADAUSDT', ticker: 'ADA', name: 'Cardano', ring: 'from-sky-400/90 to-blue-600/90', text: 'text-sky-300' },
];

const formatUsd = (value: number): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatPrice = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(4);
};

/** Lightweight inline SVG price sparkline — no chart library, no canvas. */
const CoinSparkline: React.FC<{ points: number[]; positive: boolean }> = ({ points, positive }) => {
  const rawId = useId();
  const gradientId = `spark-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const width = 100;
  const height = 26;
  const series = points.length >= 2 ? points : [0, 0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const step = width / (series.length - 1);
  const coords = series.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / span) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${coords.join(' L')}`;
  const area = `${line} L${width},${height} L0,${height} Z`;
  const color = positive ? '#34d399' : '#fb7185';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-6 w-full"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.4" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

export const PremiumCommandHero: React.FC<PremiumCommandHeroProps> = ({
  workspace,
  balance,
  todayProfit,
  dailyGoalUsd,
  hasBinanceKeys,
  syncingBalance,
  botRunning,
  pairs,
  focusedSymbol,
  flashSignal,
  onFocusCoin,
  onSyncBalance,
  onOpenCalculator,
}) => {
  const reducedMotion = useReducedMotion();
  const isLive = workspace === 'LIVE';
  const previousPricesRef = useRef<Record<string, number>>({});
  const [pulses, setPulses] = useState<Record<string, 'up' | 'down'>>({});

  const dailyPct = useMemo(() => {
    const opening = balance - todayProfit;
    if (!Number.isFinite(opening) || opening <= 0) return 0;
    return (todayProfit / opening) * 100;
  }, [balance, todayProfit]);

  const dailyUp = todayProfit >= 0;
  const goal = Math.max(1, dailyGoalUsd);
  const goalPct = Math.max(0, Math.min(100, (todayProfit / goal) * 100));

  const coinRows = COINS.map((coin) => {
    const pair = pairs.find((p) => p.symbol === coin.symbol);
    return {
      ...coin,
      change: pair?.change24h ?? 0,
      price: pair?.price ?? 0,
      series: pair?.sparkline?.map((point) => point.p) ?? [],
    };
  });

  // Brief green/red highlight whenever a live tick changes a coin's price.
  useEffect(() => {
    if (reducedMotion) return;
    const next: Record<string, 'up' | 'down'> = {};
    for (const pair of pairs) {
      const previous = previousPricesRef.current[pair.symbol];
      if (previous !== undefined && pair.price > 0 && pair.price !== previous) {
        next[pair.symbol] = pair.price > previous ? 'up' : 'down';
      }
      if (pair.price > 0) previousPricesRef.current[pair.symbol] = pair.price;
    }
    if (Object.keys(next).length === 0) return;
    setPulses(next);
    const timer = window.setTimeout(() => setPulses({}), 950);
    return () => window.clearTimeout(timer);
  }, [pairs, reducedMotion]);

  // Stronger pulse on a trade opening/closing.
  useEffect(() => {
    if (!flashSignal || reducedMotion) return;
    setPulses({ [flashSignal.symbol]: flashSignal.direction });
    const timer = window.setTimeout(() => setPulses({}), 1000);
    return () => window.clearTimeout(timer);
  }, [flashSignal, reducedMotion]);

  const handleSync = () => {
    telegramHaptic('light');
    audioSynth.playClick();
    onSyncBalance();
  };

  const handleCalculator = () => {
    telegramHaptic('light');
    audioSynth.playClick();
    onOpenCalculator();
  };

  const handleCoin = (symbol: string) => {
    telegramHaptic('light');
    audioSynth.playClick();
    onFocusCoin(symbol);
  };

  return (
    <div className="space-y-3">
      {/* Digital Balance Hero */}
      <section className="premium-hero relative overflow-hidden rounded-[26px] border border-white/10 p-4 sm:p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-16 h-56 w-56 rounded-full bg-emerald-500/20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 -left-16 h-56 w-56 rounded-full bg-amber-400/12 blur-3xl"
        />

        <div className="relative flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-mono-tech text-[10px] font-semibold tracking-[0.18em] text-slate-400 uppercase">
              <span className={`h-1.5 w-1.5 rounded-full ${botRunning ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
              {isLive ? 'LIVE SPOT BALANCE' : 'VIRTUAL DEMO BALANCE'}
            </div>
            <div className="mt-1.5 flex items-end gap-1 font-mono-tech font-bold text-white">
              <span className="pb-1.5 text-lg text-slate-400">$</span>
              <span className="text-[34px] leading-none tracking-tight sm:text-[42px]">
                {formatUsd(balance)}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono-tech text-[11px] font-bold ${
                  dailyUp
                    ? 'border-emerald-400/50 bg-emerald-500/12 text-emerald-300 shadow-[0_0_14px_rgba(16,185,129,0.35)]'
                    : 'border-rose-400/50 bg-rose-500/12 text-rose-300 shadow-[0_0_14px_rgba(244,63,94,0.35)]'
                }`}
              >
                {dailyUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {dailyUp ? '+' : ''}
                {dailyPct.toFixed(2)}% daily
              </span>
              <span className="font-mono-tech text-[10px] tracking-wider text-slate-500">
                SOLO {isLive ? 'BINANCE SPOT' : 'PAPER ENGINE'}
              </span>
            </div>
          </div>

          <span
            className={`shrink-0 rounded-full border px-2.5 py-1 font-mono-tech text-[10px] font-bold tracking-widest uppercase ${
              isLive
                ? 'border-rose-400/45 bg-rose-500/12 text-rose-200'
                : 'border-cyan-400/45 bg-cyan-500/12 text-cyan-200'
            }`}
          >
            {isLive ? 'LIVE' : 'VIRTUAL'}
          </span>
        </div>

        {/* Primary pill actions */}
        <div className="relative mt-4 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={handleSync}
            disabled={syncingBalance}
            className="tap-target flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500 px-3 py-2 font-mono-tech text-[11px] font-extrabold tracking-wide text-[#1b1206] uppercase shadow-[0_10px_26px_-8px_rgba(251,191,36,0.65)] transition-transform active:scale-[0.97] disabled:cursor-wait disabled:opacity-70"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncingBalance ? 'animate-spin' : ''}`} />
            {syncingBalance ? 'Syncing…' : 'Sync Balance'}
          </button>
          <button
            type="button"
            onClick={handleCalculator}
            className="tap-target flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-full border border-white/15 bg-white/[0.05] px-3 py-2 font-mono-tech text-[11px] font-bold tracking-wide text-slate-100 uppercase backdrop-blur-md transition-colors hover:border-white/25 hover:bg-white/[0.09] active:scale-[0.97]"
          >
            <Calculator className="h-3.5 w-3.5 text-amber-300" />
            Profit Calculator
          </button>
        </div>

        {/* Target Goal progress */}
        <div className="relative mt-4">
          <div className="flex items-center justify-between font-mono-tech text-[10px] tracking-wider uppercase">
            <span className="flex items-center gap-1.5 text-slate-400">
              <Target className="h-3 w-3 text-emerald-400" />
              Target Goal
            </span>
            <span className="text-slate-300">
              <strong className={dailyUp ? 'text-emerald-300' : 'text-rose-300'}>
                ${formatUsd(Math.max(0, todayProfit))}
              </strong>
              <span className="text-slate-500"> / ${formatUsd(goal)}</span>
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/[0.07] ring-1 ring-inset ring-white/5">
            <motion.div
              initial={reducedMotion ? false : { width: 0 }}
              animate={{ width: `${goalPct}%` }}
              transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
              className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-amber-300 shadow-[0_0_16px_rgba(52,211,153,0.55)]"
            />
          </div>
          <div className="mt-1 flex items-center justify-between font-mono-tech text-[9px] tracking-wider text-slate-500 uppercase">
            <span>{goalPct.toFixed(0)}% of daily target</span>
            <span>{isLive && !hasBinanceKeys ? 'Keys not linked' : botRunning ? 'Engine running' : 'Engine idle'}</span>
          </div>
        </div>
      </section>

      {/* Latest Trades coin grid */}
      <section className="glass-surface rounded-[22px] border p-3">
        <div className="mb-2.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-display text-xs font-bold tracking-[0.16em] text-slate-100 uppercase">
            <Sparkles className="h-3.5 w-3.5 text-amber-300" />
            Latest Trades
          </div>
          <span className="flex items-center gap-1 font-mono-tech text-[9px] tracking-widest text-emerald-300/90 uppercase">
            <span className="h-1 w-1 animate-pulse rounded-full bg-emerald-400" />
            8 Markets
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {coinRows.map((coin) => {
            const up = coin.change >= 0;
            const focused = focusedSymbol === coin.symbol;
            const pulse = pulses[coin.symbol];
            return (
              <button
                key={coin.symbol}
                type="button"
                onClick={() => handleCoin(coin.symbol)}
                aria-pressed={focused}
                className={`coin-tile tap-target flex cursor-pointer flex-col gap-1 rounded-2xl border px-2.5 py-2 text-left transition-colors active:scale-[0.97] sm:px-2 sm:py-2 ${
                  up
                    ? 'border-emerald-500/35 shadow-[0_0_14px_-4px_rgba(16,185,129,0.5)]'
                    : 'border-rose-500/35 shadow-[0_0_14px_-4px_rgba(244,63,94,0.5)]'
                } ${focused ? 'ring-1 ring-amber-300/70' : ''} ${
                  pulse === 'up' ? 'coin-pulse-up' : pulse === 'down' ? 'coin-pulse-down' : ''
                }`}
              >
                <span className="flex w-full items-center justify-between gap-1.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[9px] font-black text-black/85 ${coin.ring}`}
                    >
                      {coin.ticker.slice(0, 1)}
                    </span>
                    <span className="truncate font-mono-tech text-[11px] font-bold tracking-wide text-slate-100 sm:text-[10px]">
                      {coin.ticker}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-[1px] font-mono-tech text-[10px] font-bold sm:text-[9px] ${
                      up ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
                    }`}
                  >
                    {up ? '+' : ''}
                    {coin.change.toFixed(2)}%
                  </span>
                </span>

                <span className="w-full font-mono-tech text-[13px] leading-none font-bold text-white sm:text-[11px]">
                  ${formatPrice(coin.price)}
                </span>

                <span className="w-full pt-0.5">
                  <CoinSparkline points={coin.series} positive={up} />
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
};
