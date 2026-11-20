import React, { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Activity, Radio, X } from 'lucide-react';
import { audioSynth } from '../../lib/audioSynth';
import { fetchBinanceKlines, openBinanceStream, timeframeToBinanceInterval } from '../../lib/binanceMarket';
import { telegramHaptic } from '../../lib/telegramWebApp';
import { CandlePoint, ChartTimeframe, PairMarketData, Trade } from '../../types/trading';

export type TelemetryTimeframe = '1M' | '5M' | '15M';

interface LiveTelemetryChartProps {
  symbol: string;
  pair?: PairMarketData;
  trades: Trade[];
  onClose: () => void;
}

const TIMEFRAMES: TelemetryTimeframe[] = ['1M', '5M', '15M'];

/** Wilder-style RSI(14) over the supplied closes. */
export function computeRsi14(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return Math.max(0, Math.min(100, 100 - 100 / (1 + rs)));
}

const fmt = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(5);
};

/**
 * Live Telemetry Chart: Binance public klines (1m / 5m / 15m) drawn as candles with
 * the live price line, an entry marker for open positions and an RSI(14) gauge.
 */
export const LiveTelemetryChart: React.FC<LiveTelemetryChartProps> = ({
  symbol,
  pair,
  trades,
  onClose,
}) => {
  const reducedMotion = useReducedMotion();
  const [timeframe, setTimeframe] = useState<TelemetryTimeframe>('5M');
  const [candles, setCandles] = useState<CandlePoint[]>([]);
  const [wsLive, setWsLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setWsLive(false);

    fetchBinanceKlines(symbol, timeframe as ChartTimeframe, 48)
      .then((rows) => {
        if (!active || rows.length === 0) return;
        setCandles(rows);
        setWsLive(true);
      })
      .catch(() => {
        if (active) setCandles([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const closeWs = openBinanceStream(
      `${symbol.toLowerCase()}@kline_${timeframeToBinanceInterval(timeframe as ChartTimeframe)}`,
      (payload) => {
        if (!active || !payload || typeof payload !== 'object') return;
        const k = (payload as { k?: Record<string, unknown> }).k;
        if (!k) return;
        const open = Number(k.o);
        const high = Number(k.h);
        const low = Number(k.l);
        const close = Number(k.c);
        const volume = Math.round(Number(k.v));
        if (!Number.isFinite(close) || close <= 0) return;
        const label = new Date(Number(k.t)).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        setWsLive(true);
        setCandles((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.time === label) {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                open,
                high: Math.max(high, last.high),
                low: Math.min(low, last.low),
                close,
                volume,
              },
            ];
          }
          return [
            ...prev.slice(-47),
            { time: label, open, high, low, close, volume },
          ];
        });
      },
      () => {
        if (active) setWsLive(true);
      }
    );

    return () => {
      active = false;
      closeWs();
    };
  }, [symbol, timeframe]);

  const series = useMemo(() => {
    if (candles.length === 0) return [];
    const livePrice = pair?.price;
    if (!livePrice || livePrice <= 0) return candles;
    const last = candles[candles.length - 1];
    if (Math.abs(last.close - livePrice) < 1e-9) return candles;
    return [
      ...candles.slice(0, -1),
      {
        ...last,
        close: livePrice,
        high: Math.max(last.high, livePrice),
        low: Math.min(last.low, livePrice),
      },
    ];
  }, [candles, pair?.price]);

  const livePrice = pair?.price ?? series[series.length - 1]?.close ?? 0;
  const closes = series.map((c) => c.close);
  const rsi = computeRsi14(closes, 14);
  const rsiTone =
    rsi < 30
      ? { label: 'Oversold', text: 'text-emerald-300', bar: 'from-emerald-400 to-teal-400' }
      : rsi > 70
        ? { label: 'Overbought', text: 'text-rose-300', bar: 'from-rose-400 to-red-500' }
        : { label: 'Neutral', text: 'text-amber-300', bar: 'from-amber-300 to-yellow-400' };

  const openTrade = useMemo(
    () => trades.find((t) => t.status === 'OPEN' && t.pair === symbol) ?? null,
    [trades, symbol]
  );

  // Geometry
  const width = 660;
  const height = 220;
  const padTop = 12;
  const padBottom = 22;
  const padRight = 54;
  const plotW = width - padRight - 4;
  const plotH = height - padTop - padBottom;
  const step = plotW / Math.max(1, series.length);
  const bodyW = Math.max(2.5, Math.min(9, step * 0.6));

  const { min, max } = useMemo(() => {
    if (series.length === 0) return { min: 0, max: 1 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of series) {
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
    }
    const margin = (hi - lo) * 0.12 || Math.max(0.0001, hi * 0.002);
    return { min: lo - margin, max: hi + margin };
  }, [series]);

  const yOf = (price: number) =>
    padTop + plotH * (1 - (price - min) / Math.max(1e-9, max - min));
  const xOf = (index: number) => 4 + index * step + step / 2;

  return (
    <motion.section
      initial={reducedMotion ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={reducedMotion ? undefined : { opacity: 0, height: 0 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="holographic-card overflow-hidden rounded-2xl border"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-cyan-300" />
          <span className="font-display text-sm font-bold tracking-[0.14em] text-slate-100 uppercase">
            Live Telemetry · {symbol.replace('USDT', '')}/USDT
          </span>
          {(wsLive || pair) && (
            <span className="inline-flex items-center gap-1 font-mono-tech text-[9px] tracking-wider text-emerald-400 uppercase">
              <Radio className="h-2.5 w-2.5 animate-pulse" />
              Binance
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-black/40 p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => {
                  telegramHaptic('light');
                  audioSynth.playClick();
                  setTimeframe(tf);
                }}
                className={`min-h-[28px] cursor-pointer rounded px-2 font-mono-tech text-[10px] font-bold transition-colors ${
                  timeframe === tf
                    ? 'bg-cyan-500/25 text-cyan-200'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              telegramHaptic('light');
              onClose();
            }}
            aria-label="Close telemetry chart"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-white/10 text-slate-400 transition-colors hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="space-y-2.5 p-3">
        <div className="flex flex-wrap items-baseline gap-2 font-mono-tech">
          <span className="text-xl font-bold text-white">${fmt(livePrice)}</span>
          {pair && (
            <span
              className={`text-[11px] font-bold ${
                pair.change24h >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {pair.change24h >= 0 ? '+' : ''}
              {pair.change24h.toFixed(2)}% 24h
            </span>
          )}
          {openTrade && (
            <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-200">
              Entry ${fmt(openTrade.entry_price)}
            </span>
          )}
        </div>

        <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-[#04060b]">
          {series.length === 0 ? (
            <div className="flex h-44 items-center justify-center font-mono-tech text-[11px] text-slate-500">
              {loading ? 'Loading Binance klines…' : 'Klines unavailable — retrying on the live feed.'}
            </div>
          ) : (
            <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full select-none sm:h-52">
              {[0, 0.5, 1].map((r) => {
                const y = padTop + plotH * r;
                const price = max - (max - min) * r;
                return (
                  <g key={r}>
                    <line
                      x1={4}
                      x2={width - padRight}
                      y1={y}
                      y2={y}
                      stroke="rgba(51,65,85,0.35)"
                      strokeDasharray="3 3"
                    />
                    <text
                      x={width - padRight + 6}
                      y={y + 3}
                      fill="#64748b"
                      fontSize="9"
                      fontFamily="JetBrains Mono"
                    >
                      {fmt(price)}
                    </text>
                  </g>
                );
              })}

              {series.map((c, index) => {
                const x = xOf(index);
                const up = c.close >= c.open;
                const color = up ? '#10b981' : '#f43f5e';
                const bodyTop = Math.min(yOf(c.open), yOf(c.close));
                const bodyH = Math.max(1.5, Math.abs(yOf(c.open) - yOf(c.close)));
                return (
                  <g key={`${c.time}-${index}`}>
                    <line
                      x1={x}
                      x2={x}
                      y1={yOf(c.high)}
                      y2={yOf(c.low)}
                      stroke={color}
                      strokeWidth={1.1}
                    />
                    <rect
                      x={x - bodyW / 2}
                      y={bodyTop}
                      width={bodyW}
                      height={bodyH}
                      fill={color}
                      rx={0.8}
                    />
                  </g>
                );
              })}

              {/* Current price line */}
              <line
                x1={4}
                x2={width - padRight}
                y1={yOf(livePrice)}
                y2={yOf(livePrice)}
                stroke="rgba(34,211,238,0.75)"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
              <rect
                x={width - padRight + 1}
                y={yOf(livePrice) - 7}
                width={padRight - 2}
                height={14}
                rx={3}
                fill="#0e7490"
              />
              <text
                x={width - padRight / 2}
                y={yOf(livePrice) + 3.5}
                textAnchor="middle"
                fill="#e2f7fd"
                fontSize="8.5"
                fontWeight="700"
                fontFamily="JetBrains Mono"
              >
                {fmt(livePrice)}
              </text>

              {/* Entry marker for an open position */}
              {openTrade && (
                <>
                  <line
                    x1={4}
                    x2={width - padRight}
                    y1={yOf(openTrade.entry_price)}
                    y2={yOf(openTrade.entry_price)}
                    stroke="rgba(16,185,129,0.65)"
                    strokeWidth={1}
                    strokeDasharray="2 3"
                  />
                  <text
                    x={6}
                    y={yOf(openTrade.entry_price) - 3}
                    fill="#34d399"
                    fontSize="8.5"
                    fontFamily="JetBrains Mono"
                  >
                    ENTRY {fmt(openTrade.entry_price)}
                  </text>
                </>
              )}
            </svg>
          )}
        </div>

        {/* RSI (14) gauge */}
        <div className="rounded-xl border border-white/10 bg-black/35 px-3 py-2">
          <div className="flex items-center justify-between font-mono-tech text-[10px] tracking-wider uppercase">
            <span className="text-slate-400">RSI (14)</span>
            <span className={`font-bold ${rsiTone.text}`}>
              {rsi.toFixed(1)} · {rsiTone.label}
            </span>
          </div>
          <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-white/[0.07] ring-1 ring-inset ring-white/5">
            <div className="absolute inset-y-0 left-[30%] w-px bg-emerald-400/40" />
            <div className="absolute inset-y-0 left-[70%] w-px bg-rose-400/40" />
            <motion.div
              initial={reducedMotion ? false : { width: 0 }}
              animate={{ width: `${rsi}%` }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className={`h-full rounded-full bg-gradient-to-r ${rsiTone.bar}`}
            />
          </div>
          <div className="mt-1 flex justify-between font-mono-tech text-[9px] text-slate-500 uppercase">
            <span>0 · oversold</span>
            <span>50</span>
            <span>overbought · 100</span>
          </div>
        </div>
      </div>
    </motion.section>
  );
};
