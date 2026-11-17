import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Radio } from 'lucide-react';
import { BDT_PER_USD, generateCandlesForPair, toHeikinAshi } from '../../data/demoData';
import { audioSynth } from '../../lib/audioSynth';
import {
  attachCandleIndicators,
  fetchBinanceKlines,
  openBinanceStream,
  timeframeToBinanceInterval,
} from '../../lib/binanceMarket';
import {
  CandlePoint,
  CandleStyle,
  ChartIndicator,
  ChartTimeframe,
  PairMarketData,
  Trade,
} from '../../types/trading';

interface CandlestickChartProps {
  pairs: PairMarketData[];
  selectedSymbol: string;
  onSelectSymbol?: (sym: string) => void;
  candleStyle: CandleStyle;
  onChangeCandleStyle: (style: CandleStyle) => void;
  t: Record<string, string>;
  compact?: boolean;
  binanceFeedLive?: boolean;
  trades?: Trade[];
}

const TIMEFRAMES: ChartTimeframe[] = ['1M', '5M', '15M', '1H', '4H'];
const INDICATORS: ChartIndicator[] = ['MA', 'EMA', 'BOLL', 'VWAP'];

function formatCompactNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

export const CandlestickChart: React.FC<CandlestickChartProps> = ({
  pairs,
  selectedSymbol,
  onSelectSymbol,
  candleStyle,
  onChangeCandleStyle,
  t,
  compact = false,
  binanceFeedLive = false,
  trades = [],
}) => {
  const [timeframe, setTimeframe] = useState<ChartTimeframe>('15M');
  const [activeIndicators, setActiveIndicators] = useState<ChartIndicator[]>(['MA', 'EMA']);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [liveKlines, setLiveKlines] = useState<CandlePoint[] | null>(null);
  const [klineWsLive, setKlineWsLive] = useState(false);

  const pair = useMemo(
    () => pairs.find((p) => p.symbol === selectedSymbol) ?? pairs[0],
    [pairs, selectedSymbol]
  );

  const barCount = compact ? 32 : 44;
  const latestPairRef = useRef(pair);
  useEffect(() => {
    latestPairRef.current = pair;
  }, [pair]);

  // Fetch initial Binance klines & subscribe to live @kline_<interval> WebSocket ticks
  useEffect(() => {
    let active = true;
    const symbol = pair.symbol;
    const interval = timeframeToBinanceInterval(timeframe);
    setLiveKlines(null);
    setKlineWsLive(false);

    fetchBinanceKlines(symbol, timeframe, barCount)
      .then((klines) => {
        if (!active || !klines.length) return;
        setLiveKlines(klines);
        setKlineWsLive(true);
      })
      .catch(() => {
        // Silent fallback to generated candles synced to live pair.price
      });

    const closeWs = openBinanceStream(
      `${symbol.toLowerCase()}@kline_${interval}`,
      (payload) => {
        if (!active || !payload || typeof payload !== 'object') return;
        const k = (payload as { k?: Record<string, unknown> }).k;
        if (!k) return;
        const openTime = Number(k.t);
        const o = Number(k.o);
        const h = Number(k.h);
        const l = Number(k.l);
        const c = Number(k.c);
        const v = Math.round(Number(k.v));
        if (!Number.isFinite(c) || c <= 0) return;

        const barTime = new Date(openTime).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });

        setKlineWsLive(true);
        setLiveKlines((prev) => {
          const base =
            prev && prev.length > 0
              ? prev
              : generateCandlesForPair(latestPairRef.current, timeframe, barCount);
          const last = base[base.length - 1];
          let nextRaw: CandlePoint[];
          if (last && last.time === barTime) {
            nextRaw = [
              ...base.slice(0, -1),
              {
                time: barTime,
                open: o,
                high: Math.max(h, last.high),
                low: Math.min(l, last.low),
                close: c,
                volume: v,
              },
            ];
          } else {
            nextRaw = [
              ...base.slice(-(barCount - 1)),
              {
                time: barTime,
                open: o,
                high: h,
                low: l,
                close: c,
                volume: v,
              },
            ];
          }
          return attachCandleIndicators(nextRaw);
        });
      },
      () => {
        if (active) setKlineWsLive(true);
      }
    );

    return () => {
      active = false;
      closeWs();
    };
  }, [pair.symbol, timeframe, barCount]);

  const pairTrades = useMemo(
    () => trades.filter((tr) => tr.pair === pair.symbol),
    [trades, pair.symbol]
  );

  const openPairTrades = useMemo(
    () => pairTrades.filter((tr) => tr.status === 'OPEN'),
    [pairTrades]
  );

  const closedPairTrades = useMemo(
    () => pairTrades.filter((tr) => tr.status === 'CLOSED').slice(0, 5),
    [pairTrades]
  );

  const rawCandles = useMemo(() => {
    const base =
      liveKlines && liveKlines.length > 0
        ? liveKlines
        : generateCandlesForPair(pair, timeframe, barCount);
    if (!base.length) return base;
    const last = base[base.length - 1];
    if (last.close === pair.price) return base;
    const updatedLast: CandlePoint = {
      ...last,
      close: pair.price,
      high: Math.max(last.high, pair.price),
      low: Math.min(last.low, pair.price),
    };
    return attachCandleIndicators([...base.slice(0, -1), updatedLast]);
  }, [liveKlines, pair, timeframe, barCount]);

  const displayCandles: CandlePoint[] = useMemo(() => {
    if (candleStyle === 'heikin_ashi') return toHeikinAshi(rawCandles);
    return rawCandles;
  }, [candleStyle, rawCandles]);

  const activeCandle =
    hoverIdx !== null && displayCandles[hoverIdx]
      ? displayCandles[hoverIdx]
      : displayCandles[displayCandles.length - 1];

  const showMa = activeIndicators.includes('MA');
  const showEma = activeIndicators.includes('EMA');
  const showBoll = activeIndicators.includes('BOLL');
  const showVwap = activeIndicators.includes('VWAP');

  const toggleIndicator = (ind: ChartIndicator) => {
    const nextActive = !activeIndicators.includes(ind);
    audioSynth.playToggle(nextActive);
    setActiveIndicators((prev) =>
      prev.includes(ind) ? prev.filter((item) => item !== ind) : [...prev, ind]
    );
  };

  // SVG Chart Geometry
  const svgW = 760;
  const svgH = compact ? 225 : 275;
  const padTop = 16;
  const padBot = 36;
  const padLeft = 8;
  const padRight = 64;
  const plotW = svgW - padLeft - padRight;
  const plotH = svgH - padTop - padBot;
  const volHeight = 32;
  const pricePlotH = plotH - volHeight - 8;

  const { minPrice, maxPrice, maxVol } = useMemo(() => {
    let minP = Infinity;
    let maxP = -Infinity;
    let maxV = 1;
    displayCandles.forEach((c) => {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
      if (showMa) {
        if (c.ma7) {
          minP = Math.min(minP, c.ma7);
          maxP = Math.max(maxP, c.ma7);
        }
        if (c.ma25) {
          minP = Math.min(minP, c.ma25);
          maxP = Math.max(maxP, c.ma25);
        }
      }
      if (showEma) {
        if (c.ema20) {
          minP = Math.min(minP, c.ema20);
          maxP = Math.max(maxP, c.ema20);
        }
        if (c.ema50) {
          minP = Math.min(minP, c.ema50);
          maxP = Math.max(maxP, c.ema50);
        }
      }
      if (showBoll) {
        if (c.bbLower) minP = Math.min(minP, c.bbLower);
        if (c.bbUpper) maxP = Math.max(maxP, c.bbUpper);
      }
      if (showVwap && c.vwap) {
        minP = Math.min(minP, c.vwap);
        maxP = Math.max(maxP, c.vwap);
      }
      if (c.volume > maxV) maxV = c.volume;
    });
    const margin = (maxP - minP) * 0.08 || 1;
    return { minPrice: minP - margin, maxPrice: maxP + margin, maxVol: maxV };
  }, [displayCandles, showMa, showEma, showBoll, showVwap]);

  const priceToY = (p: number) => {
    const ratio = (p - minPrice) / Math.max(0.00001, maxPrice - minPrice);
    const clampedRatio = Math.max(-0.04, Math.min(1.04, ratio));
    return padTop + pricePlotH * (1 - clampedRatio);
  };

  const stepX = plotW / Math.max(1, displayCandles.length);
  const candleW = Math.max(4, Math.min(12, stepX * 0.62));

  const buildPath = (getter: (c: CandlePoint) => number) =>
    displayCandles
      .map((c, i) => {
        const x = padLeft + i * stepX + stepX / 2;
        const y = priceToY(getter(c));
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');

  const ma7Path = useMemo(
    () => (showMa ? buildPath((c) => c.ma7 ?? c.close) : ''),
    [displayCandles, showMa, stepX, minPrice, maxPrice]
  );
  const ma25Path = useMemo(
    () => (showMa ? buildPath((c) => c.ma25 ?? c.close) : ''),
    [displayCandles, showMa, stepX, minPrice, maxPrice]
  );
  const ema20Path = useMemo(
    () => (showEma ? buildPath((c) => c.ema20 ?? c.close) : ''),
    [displayCandles, showEma, stepX, minPrice, maxPrice]
  );
  const ema50Path = useMemo(
    () => (showEma ? buildPath((c) => c.ema50 ?? c.close) : ''),
    [displayCandles, showEma, stepX, minPrice, maxPrice]
  );
  const bbUpperPath = useMemo(
    () => (showBoll ? buildPath((c) => c.bbUpper ?? c.close) : ''),
    [displayCandles, showBoll, stepX, minPrice, maxPrice]
  );
  const bbMidPath = useMemo(
    () => (showBoll ? buildPath((c) => c.bbMid ?? c.close) : ''),
    [displayCandles, showBoll, stepX, minPrice, maxPrice]
  );
  const bbLowerPath = useMemo(
    () => (showBoll ? buildPath((c) => c.bbLower ?? c.close) : ''),
    [displayCandles, showBoll, stepX, minPrice, maxPrice]
  );
  const bbAreaPath = useMemo(() => {
    if (!showBoll || displayCandles.length === 0) return '';
    const topPts = displayCandles.map((c, i) => {
      const x = padLeft + i * stepX + stepX / 2;
      const y = priceToY(c.bbUpper ?? c.close);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const botPts = [...displayCandles]
      .reverse()
      .map((c, rIdx) => {
        const i = displayCandles.length - 1 - rIdx;
        const x = padLeft + i * stepX + stepX / 2;
        const y = priceToY(c.bbLower ?? c.close);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
    return `M ${topPts.join(' L ')} L ${botPts.join(' L ')} Z`;
  }, [displayCandles, showBoll, stepX, minPrice, maxPrice]);

  const vwapPath = useMemo(
    () => (showVwap ? buildPath((c) => c.vwap ?? c.close) : ''),
    [displayCandles, showVwap, stepX, minPrice, maxPrice]
  );
  const ribbonPath = useMemo(
    () => buildPath((c) => c.close),
    [displayCandles, stepX, minPrice, maxPrice]
  );

  // Map open & historical closed trades onto geometric Entry -> Exit connectors + B / S markers
  const { tradeChartMarkers, tradeConnectors } = useMemo(() => {
    if (displayCandles.length === 0) {
      return {
        tradeChartMarkers: [] as {
          id: string;
          idx: number;
          y: number;
          kind: 'BUY' | 'SELL';
          pnl: number;
          entryPrice: number;
        }[],
        tradeConnectors: [] as {
          id: string;
          x1: number;
          y1: number;
          x2: number;
          y2: number;
          isProfit: boolean;
          isHistorical: boolean;
          pnl: number;
          pct: number;
          pair: string;
        }[],
      };
    }

    const items: {
      id: string;
      idx: number;
      y: number;
      kind: 'BUY' | 'SELL';
      pnl: number;
      entryPrice: number;
    }[] = [];

    const connectors: {
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      isProfit: boolean;
      isHistorical: boolean;
      pnl: number;
      pct: number;
      pair: string;
    }[] = [];

    const clampY = (y: number) => Math.max(padTop + 6, Math.min(padTop + pricePlotH - 6, y));
    const idxToX = (idx: number) => padLeft + idx * stepX + stepX / 2;

    const findBestIdxInRange = (
      targetPrice: number,
      minIdx: number,
      maxIdx: number,
      fallbackIdx: number
    ) => {
      const lo = Math.max(0, minIdx);
      const hi = Math.min(displayCandles.length - 1, maxIdx);
      if (lo > hi) return Math.max(0, Math.min(displayCandles.length - 1, fallbackIdx));
      let bestI = fallbackIdx;
      let minDiff = Infinity;
      for (let i = lo; i <= hi; i++) {
        const c = displayCandles[i];
        const d = Math.abs(c.close - targetPrice);
        if (d < minDiff) {
          minDiff = d;
          bestI = i;
        }
      }
      return bestI;
    };

    const lastIdx = displayCandles.length - 1;
    const xLive = idxToX(lastIdx);
    const yLive = clampY(priceToY(pair.price));

    openPairTrades.slice(0, 4).forEach((tr, k) => {
      const fallbackIdx = Math.max(2, lastIdx - (5 + k * 5));
      const idx = findBestIdxInRange(tr.entry_price, 1, Math.max(1, lastIdx - 2), fallbackIdx);
      const xEntry = idxToX(idx);
      const yEntry = clampY(priceToY(tr.entry_price));

      items.push({
        id: `open-${tr.id}`,
        idx,
        y: yEntry,
        kind: 'BUY',
        pnl: tr.profit_usdt,
        entryPrice: tr.entry_price,
      });

      connectors.push({
        id: `conn-open-${tr.id}`,
        x1: xEntry,
        y1: yEntry,
        x2: xLive,
        y2: yLive,
        isProfit: tr.profit_usdt >= 0,
        isHistorical: false,
        pnl: tr.profit_usdt,
        pct: tr.profit_pct,
        pair: tr.pair,
      });
    });

    closedPairTrades.slice(0, 5).forEach((tr, k) => {
      const exitPx = tr.exit_price ?? tr.current_price;
      const maxExitIdx = Math.max(4, lastIdx - 1 - k * 4);
      const minExitIdx = Math.max(3, maxExitIdx - 6);
      const exitIdx = findBestIdxInRange(exitPx, minExitIdx, maxExitIdx, maxExitIdx);

      const minEntryIdx = Math.max(0, exitIdx - 10);
      const maxEntryIdx = Math.max(0, exitIdx - 3);
      const entryIdx = findBestIdxInRange(
        tr.entry_price,
        minEntryIdx,
        maxEntryIdx,
        Math.max(0, exitIdx - 5)
      );

      const x1 = idxToX(entryIdx);
      const y1 = clampY(priceToY(tr.entry_price));
      const x2 = idxToX(exitIdx);
      const y2 = clampY(priceToY(exitPx));

      connectors.push({
        id: `conn-hist-${tr.id}`,
        x1,
        y1,
        x2,
        y2,
        isProfit: tr.profit_usdt >= 0,
        isHistorical: true,
        pnl: tr.profit_usdt,
        pct: tr.profit_pct,
        pair: tr.pair,
      });

      items.push({
        id: `hist-buy-${tr.id}`,
        idx: entryIdx,
        y: y1,
        kind: 'BUY',
        pnl: tr.profit_usdt,
        entryPrice: tr.entry_price,
      });

      items.push({
        id: `closed-${tr.id}`,
        idx: exitIdx,
        y: y2,
        kind: 'SELL',
        pnl: tr.profit_usdt,
        entryPrice: exitPx,
      });
    });

    return { tradeChartMarkers: items, tradeConnectors: connectors };
  }, [closedPairTrades, displayCandles, openPairTrades, minPrice, maxPrice, pair.price, pricePlotH, stepX]);

  const decimals = pair.price > 50 ? 2 : pair.price > 5 ? 3 : 4;
  const bdtPrice = pair.price * BDT_PER_USD;
  const isPairPos = pair.change24h >= 0;

  const candleStyles: { id: CandleStyle; label: string }[] = [
    { id: 'japanese', label: t.candleJapanese },
    { id: 'heikin_ashi', label: t.candleHeikin },
    { id: 'hollow', label: t.candleHollow },
    { id: 'momentum_ribbon', label: t.candleRibbon },
  ];

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => {
    const val = minPrice + (maxPrice - minPrice) * r;
    return { y: priceToY(val), label: val.toFixed(decimals) };
  });

  const perfItems = [
    { label: t.perfToday, val: pair.perf.today },
    { label: t.perf7d, val: pair.perf.d7 },
    { label: t.perf30d, val: pair.perf.d30 },
    { label: t.perf90d, val: pair.perf.d90 },
  ];

  return (
    <div className="space-y-2.5">
      {/* Binance-Inspired 24h Market Header + BDT Conversion */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-[#05070d] px-3 py-2.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display text-sm font-bold tracking-wider text-slate-200">
                {pair.base}/{pair.quote}
              </span>
              <span className="rounded bg-slate-800/90 px-1.5 py-0.5 font-mono-tech text-[9px] font-semibold text-amber-300 uppercase">
                Spot
              </span>
              {(binanceFeedLive || klineWsLive) && (
                <span className="inline-flex items-center gap-1 font-mono-tech text-[9px] text-emerald-400 uppercase">
                  <Radio className="h-2.5 w-2.5 animate-pulse" />
                  Binance Live
                </span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-2 font-mono-tech">
              <span
                className={`text-xl font-bold sm:text-2xl ${
                  isPairPos ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                $
                {pair.price > 10
                  ? pair.price.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })
                  : pair.price.toFixed(4)}
              </span>
              <span className="text-xs text-slate-400">
                ৳
                {bdtPrice.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                  isPairPos
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-rose-500/15 text-rose-300'
                }`}
              >
                {isPairPos ? '+' : ''}
                {pair.change24h.toFixed(2)}%
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-5 gap-y-1 font-mono-tech text-[11px] sm:grid-cols-4">
          <div>
            <div className="text-[9px] text-slate-500 uppercase">{t.high24h}</div>
            <div className="font-semibold text-slate-200">{pair.high24h.toFixed(decimals)}</div>
          </div>
          <div>
            <div className="text-[9px] text-slate-500 uppercase">{t.low24h}</div>
            <div className="font-semibold text-slate-200">{pair.low24h.toFixed(decimals)}</div>
          </div>
          <div>
            <div className="text-[9px] text-slate-500 uppercase">
              {t.volBase}({pair.base})
            </div>
            <div className="font-semibold text-slate-200">
              {formatCompactNum(pair.baseVolume24h)}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-slate-500 uppercase">{t.volUsdt}</div>
            <div className="font-semibold text-cyan-300">{formatCompactNum(pair.volume24h)}</div>
          </div>
        </div>
      </div>

      {/* Toolbar: Pair + Candle Style + Timeframe */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {onSelectSymbol && (
            <select
              value={pair.symbol}
              aria-label="Chart Pair"
              onChange={(e) => {
                audioSynth.playClick();
                onSelectSymbol(e.target.value);
              }}
              className="min-h-[34px] rounded-lg border border-slate-700/80 bg-[#05060a] px-2.5 font-mono-tech text-xs font-semibold text-slate-100 focus:border-cyan-400 focus:outline-none"
            >
              {pairs.map((p) => (
                <option key={p.symbol} value={p.symbol}>
                  {p.symbol}
                </option>
              ))}
            </select>
          )}

          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-[#05060a] p-0.5">
            {candleStyles.map((cs) => (
              <button
                key={cs.id}
                type="button"
                onClick={() => {
                  audioSynth.playClick();
                  onChangeCandleStyle(cs.id);
                }}
                className={`min-h-[30px] cursor-pointer rounded px-2 py-1 font-mono-tech text-[10px] font-semibold uppercase transition-colors ${
                  candleStyle === cs.id
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {cs.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-0.5 rounded-lg border border-slate-800 bg-[#05060a] p-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => {
                audioSynth.playClick();
                setTimeframe(tf);
              }}
              className={`min-h-[30px] cursor-pointer rounded px-2 py-1 font-mono-tech text-[10px] font-semibold transition-colors ${
                timeframe === tf
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Live OHLCV + Active Indicator Values Readout */}
      {activeCandle && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800/80 bg-[#05070d] px-3 py-1.5 font-mono-tech text-[11px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="font-bold text-slate-200">{activeCandle.time}</span>
            <span>
              O <span className="text-slate-200">{activeCandle.open.toFixed(decimals)}</span>
            </span>
            <span>
              H <span className="text-emerald-400">{activeCandle.high.toFixed(decimals)}</span>
            </span>
            <span>
              L <span className="text-rose-400">{activeCandle.low.toFixed(decimals)}</span>
            </span>
            <span>
              C{' '}
              <span
                className={
                  activeCandle.close >= activeCandle.open ? 'text-emerald-400' : 'text-rose-400'
                }
              >
                {activeCandle.close.toFixed(decimals)}
              </span>
            </span>
            <span className="text-slate-400">
              VOL <span className="text-cyan-300">{formatCompactNum(activeCandle.volume)}</span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 text-[10px]">
            {showMa && activeCandle.ma7 !== undefined && (
              <span className="text-amber-300">MA(7): {activeCandle.ma7.toFixed(decimals)}</span>
            )}
            {showMa && activeCandle.ma25 !== undefined && (
              <span className="text-purple-300">MA(25): {activeCandle.ma25.toFixed(decimals)}</span>
            )}
            {showBoll && activeCandle.bbUpper !== undefined && (
              <span className="text-sky-300">
                BOLL: {activeCandle.bbUpper.toFixed(decimals)} /{' '}
                {activeCandle.bbLower?.toFixed(decimals)}
              </span>
            )}
            {showVwap && activeCandle.vwap !== undefined && (
              <span className="text-pink-300">VWAP: {activeCandle.vwap.toFixed(decimals)}</span>
            )}
          </div>
        </div>
      )}

      {/* SVG Interactive Candlestick Canvas + Entry/Exit Trade Markers */}
      <div className="relative w-full overflow-hidden rounded-xl border border-slate-800/90 bg-[#04060b] p-2">
        <svg
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="h-56 w-full select-none sm:h-64"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* Horizontal grid + right Y-axis labels */}
          {yTicks.map((tk, idx) => (
            <g key={idx}>
              <line
                x1={padLeft}
                x2={svgW - padRight}
                y1={tk.y}
                y2={tk.y}
                stroke="rgba(51,65,85,0.32)"
                strokeDasharray="3 3"
              />
              <text
                x={svgW - padRight + 6}
                y={tk.y + 3}
                fill="#64748b"
                fontSize="9.5"
                fontFamily="JetBrains Mono"
              >
                {tk.label}
              </text>
            </g>
          ))}

          {/* Bollinger Channel Shaded Fill */}
          {showBoll && bbAreaPath && (
            <>
              <path d={bbAreaPath} fill="rgba(56,189,248,0.08)" />
              <path d={bbUpperPath} fill="none" stroke="#38bdf8" strokeWidth="1" opacity="0.7" />
              <path
                d={bbMidPath}
                fill="none"
                stroke="#38bdf8"
                strokeWidth="0.9"
                strokeDasharray="2 2"
                opacity="0.55"
              />
              <path d={bbLowerPath} fill="none" stroke="#38bdf8" strokeWidth="1" opacity="0.7" />
            </>
          )}

          {/* Momentum Ribbon Area Mode */}
          {candleStyle === 'momentum_ribbon' && (
            <>
              <defs>
                <linearGradient id="ribbonAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.38" />
                  <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path
                d={`${ribbonPath} L ${padLeft + (displayCandles.length - 1) * stepX + stepX / 2} ${
                  padTop + pricePlotH
                } L ${padLeft + stepX / 2} ${padTop + pricePlotH} Z`}
                fill="url(#ribbonAreaGrad)"
              />
              <path d={ribbonPath} fill="none" stroke="#22d3ee" strokeWidth="2.2" />
            </>
          )}

          {/* Candles + Volume Bars */}
          {displayCandles.map((c, i) => {
            const xCenter = padLeft + i * stepX + stepX / 2;
            const prevClose = i > 0 ? displayCandles[i - 1].close : c.open;
            const isUp =
              candleStyle === 'hollow' ? c.close >= prevClose : c.close >= c.open;
            const color = isUp ? '#10b981' : '#f43f5e';

            const yHigh = priceToY(c.high);
            const yLow = priceToY(c.low);
            const yOpen = priceToY(c.open);
            const yClose = priceToY(c.close);
            const bodyTop = Math.min(yOpen, yClose);
            const bodyH = Math.max(2, Math.abs(yClose - yOpen));

            const volBarH = Math.max(2, (c.volume / maxVol) * volHeight);
            const volY = svgH - 18 - volBarH;

            return (
              <g
                key={`${c.time}-${i}`}
                onMouseEnter={() => setHoverIdx(i)}
                className="cursor-crosshair"
              >
                <rect
                  x={xCenter - stepX / 2}
                  y={padTop}
                  width={stepX}
                  height={plotH}
                  fill="transparent"
                />
                <rect
                  x={xCenter - candleW / 2}
                  y={volY}
                  width={candleW}
                  height={volBarH}
                  fill={color}
                  opacity={0.32}
                  rx={1}
                />
                {candleStyle !== 'momentum_ribbon' && (
                  <>
                    <line
                      x1={xCenter}
                      x2={xCenter}
                      y1={yHigh}
                      y2={yLow}
                      stroke={color}
                      strokeWidth={1.35}
                    />
                    <rect
                      x={xCenter - candleW / 2}
                      y={bodyTop}
                      width={candleW}
                      height={bodyH}
                      fill={candleStyle === 'hollow' && isUp ? '#04060b' : color}
                      stroke={color}
                      strokeWidth={candleStyle === 'hollow' && isUp ? 1.5 : 0.8}
                      rx={1}
                    />
                  </>
                )}
                {i % 7 === 0 && (
                  <text
                    x={xCenter}
                    y={svgH - 4}
                    textAnchor="middle"
                    fill="#64748b"
                    fontSize="9.5"
                    fontFamily="JetBrains Mono"
                  >
                    {c.time}
                  </text>
                )}
              </g>
            );
          })}

          {/* MA / EMA / VWAP Overlays */}
          {showMa && (
            <>
              <path d={ma7Path} fill="none" stroke="#fbbf24" strokeWidth="1.35" opacity="0.92" />
              <path d={ma25Path} fill="none" stroke="#c084fc" strokeWidth="1.35" opacity="0.88" />
            </>
          )}
          {showEma && (
            <>
              <path d={ema20Path} fill="none" stroke="#22d3ee" strokeWidth="1.3" opacity="0.9" />
              <path
                d={ema50Path}
                fill="none"
                stroke="#38bdf8"
                strokeWidth="1.2"
                strokeDasharray="4 3"
                opacity="0.75"
              />
            </>
          )}
          {showVwap && (
            <path
              d={vwapPath}
              fill="none"
              stroke="#f472b6"
              strokeWidth="1.3"
              strokeDasharray="3 2"
              opacity="0.9"
            />
          )}

          {/* Geometric Entry -> Exit Connectors (Green = Profit, Red = Loss) */}
          {tradeConnectors.map((conn) => {
            const stroke = conn.isProfit ? '#10b981' : '#f43f5e';
            const glowStroke = conn.isProfit
              ? 'rgba(16,185,129,0.22)'
              : 'rgba(244,63,94,0.22)';
            const fillPoly = conn.isProfit
              ? 'rgba(16,185,129,0.10)'
              : 'rgba(244,63,94,0.10)';
            const midX = (conn.x1 + conn.x2) / 2;
            const midY = (conn.y1 + conn.y2) / 2;

            return (
              <g key={conn.id}>
                {/* Geometric shaded Delta triangle between entry baseline and exit */}
                {conn.isHistorical && (
                  <polygon
                    points={`${conn.x1},${conn.y1} ${conn.x2},${conn.y2} ${conn.x2},${conn.y1}`}
                    fill={fillPoly}
                    stroke={glowStroke}
                    strokeWidth="0.8"
                  />
                )}
                {/* Soft outer halo beam */}
                <line
                  x1={conn.x1}
                  y1={conn.y1}
                  x2={conn.x2}
                  y2={conn.y2}
                  stroke={glowStroke}
                  strokeWidth={conn.isHistorical ? 5 : 3.5}
                  strokeLinecap="round"
                />
                {/* Crisp geometric Entry -> Exit line */}
                <line
                  x1={conn.x1}
                  y1={conn.y1}
                  x2={conn.x2}
                  y2={conn.y2}
                  stroke={stroke}
                  strokeWidth={conn.isHistorical ? 1.9 : 1.35}
                  strokeDasharray={conn.isHistorical ? undefined : '4 3'}
                  strokeLinecap="round"
                />
                {/* Entry Diamond Anchor */}
                <polygon
                  points={`${conn.x1},${conn.y1 - 4.5} ${conn.x1 + 4.5},${conn.y1} ${conn.x1},${conn.y1 + 4.5} ${conn.x1 - 4.5},${conn.y1}`}
                  fill="#04060b"
                  stroke={stroke}
                  strokeWidth="1.6"
                />
                {/* Exit Circle Anchor (for closed historical trades) */}
                {conn.isHistorical && (
                  <>
                    <circle
                      cx={conn.x2}
                      cy={conn.y2}
                      r={4}
                      fill={stroke}
                      stroke="#04060b"
                      strokeWidth="1.2"
                    />
                    {/* Midpoint PnL % tag along vector */}
                    <rect
                      x={midX - 19}
                      y={midY - 7}
                      width={38}
                      height={13}
                      rx={3}
                      fill="#04060b"
                      stroke={stroke}
                      strokeWidth="0.9"
                      opacity="0.94"
                    />
                    <text
                      x={midX}
                      y={midY + 2.5}
                      textAnchor="middle"
                      fill={conn.isProfit ? '#34d399' : '#fb7185'}
                      fontSize="8"
                      fontWeight="700"
                      fontFamily="JetBrains Mono"
                    >
                      {conn.pct >= 0 ? '+' : ''}
                      {conn.pct.toFixed(1)}%
                    </text>
                  </>
                )}
              </g>
            );
          })}

          {/* Open Trade Dashed Entry Lines + B / S Markers on Candles */}
          {tradeChartMarkers.map((mk) => {
            const x = padLeft + mk.idx * stepX + stepX / 2;
            const isBuy = mk.kind === 'BUY';
            const badgeColor = isBuy
              ? mk.id.startsWith('hist-')
                ? mk.pnl >= 0
                  ? '#059669'
                  : '#e11d48'
                : '#10b981'
              : mk.pnl >= 0
                ? '#34d399'
                : '#f43f5e';
            const badgeText = isBuy
              ? 'B'
              : `S ${mk.pnl >= 0 ? '+' : ''}$${mk.pnl.toFixed(1)}`;
            const pillW = isBuy ? 16 : Math.max(46, badgeText.length * 6.5);
            const yPos = isBuy ? mk.y - 18 : mk.y - 19;

            return (
              <g key={mk.id}>
                {mk.id.startsWith('open-') && (
                  <line
                    x1={padLeft}
                    x2={svgW - padRight}
                    y1={mk.y}
                    y2={mk.y}
                    stroke="rgba(16,185,129,0.38)"
                    strokeDasharray="4 4"
                  />
                )}
                <rect
                  x={x - pillW / 2}
                  y={Math.max(padTop + 2, Math.min(padTop + pricePlotH - 16, yPos))}
                  width={pillW}
                  height={14}
                  rx={4}
                  fill={badgeColor}
                />
                <text
                  x={x}
                  y={Math.max(padTop + 11.5, Math.min(padTop + pricePlotH - 6.5, yPos + 10))}
                  textAnchor="middle"
                  fill="#04060b"
                  fontSize="8.5"
                  fontWeight="800"
                  fontFamily="JetBrains Mono"
                >
                  {badgeText}
                </text>
              </g>
            );
          })}

          {/* Last Price Tag on Right Axis */}
          {displayCandles.length > 0 && (
            <g>
              <line
                x1={padLeft}
                x2={svgW - padRight}
                y1={priceToY(pair.price)}
                y2={priceToY(pair.price)}
                stroke={isPairPos ? 'rgba(16,185,129,0.5)' : 'rgba(244,63,94,0.5)'}
                strokeDasharray="2 2"
              />
              <rect
                x={svgW - padRight + 2}
                y={priceToY(pair.price) - 8}
                width={padRight - 4}
                height={16}
                rx={3}
                fill={isPairPos ? '#10b981' : '#f43f5e'}
              />
              <text
                x={svgW - padRight + 5}
                y={priceToY(pair.price) + 3.5}
                fill="#04060b"
                fontSize="9"
                fontWeight="700"
                fontFamily="JetBrains Mono"
              >
                {pair.price.toFixed(decimals)}
              </text>
            </g>
          )}

          {hoverIdx !== null && displayCandles[hoverIdx] && (
            <line
              x1={padLeft + hoverIdx * stepX + stepX / 2}
              x2={padLeft + hoverIdx * stepX + stepX / 2}
              y1={padTop}
              y2={svgH - 18}
              stroke="rgba(34,211,238,0.45)"
              strokeDasharray="3 3"
            />
          )}
        </svg>
      </div>

      {/* Pair Trade Entry & Exit Realized PnL Summary */}
      {(openPairTrades.length > 0 || closedPairTrades.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800/80 bg-[#05070d] px-3 py-1.5 font-mono-tech text-[10px]">
          <span className="font-bold text-slate-400 uppercase">{t.tradeMarkersTitle}:</span>
          {openPairTrades.map((tr) => (
            <span
              key={tr.id}
              className="rounded border border-emerald-500/40 bg-emerald-500/12 px-2 py-0.5 text-emerald-300"
            >
              BUY @ ${tr.entry_price.toFixed(decimals)} ({tr.profit_usdt >= 0 ? '+' : ''}$
              {tr.profit_usdt.toFixed(2)})
            </span>
          ))}
          {closedPairTrades.map((tr) => (
            <span
              key={tr.id}
              className={`rounded border px-2 py-0.5 ${
                tr.profit_usdt >= 0
                  ? 'border-cyan-500/40 bg-cyan-500/12 text-cyan-300'
                  : 'border-rose-500/40 bg-rose-500/12 text-rose-300'
              }`}
            >
              SOLD @ ${(tr.exit_price ?? tr.current_price).toFixed(decimals)} ({tr.profit_usdt >= 0 ? '+' : ''}$
              {tr.profit_usdt.toFixed(2)})
            </span>
          ))}
        </div>
      )}

      {/* Bottom Indicator Pills + Performance Return Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800/80 bg-[#05070d] px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {INDICATORS.map((ind) => {
            const active = activeIndicators.includes(ind);
            return (
              <button
                key={ind}
                type="button"
                onClick={() => toggleIndicator(ind)}
                className={`min-h-[28px] cursor-pointer rounded border px-2 py-0.5 font-mono-tech text-[10px] font-bold tracking-wider uppercase transition-colors ${
                  active
                    ? 'border-cyan-400/60 bg-cyan-500/18 text-cyan-200'
                    : 'border-slate-800 bg-[#04060b] text-slate-500 hover:text-slate-300'
                }`}
              >
                {ind}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-4 gap-3 font-mono-tech text-[11px]">
          {perfItems.map((item) => {
            const pos = item.val >= 0;
            return (
              <div key={item.label} className="text-right">
                <div className="text-[9px] text-slate-500 uppercase">{item.label}</div>
                <div className={`font-bold ${pos ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {pos ? '+' : ''}
                  {item.val.toFixed(2)}%
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
