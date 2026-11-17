import React, { useMemo, useState } from 'react';
import { audioSynth } from '../../lib/audioSynth';
import { PairMarketData } from '../../types/trading';
import { InfoTip } from '../ui/InfoTip';
import { NeonButton } from '../ui/MotionPrimitives';
import { TerminalPanel } from '../ui/TerminalPanel';

interface BinanceOrderBookProps {
  t: Record<string, string>;
  pair: PairMarketData;
  defaultLot?: number;
  onQuickTrade: (pairSymbol: string, side: 'BUY' | 'SELL', amountUsdt: number) => Promise<void>;
  compact?: boolean;
}

type BookTab = 'BOOK' | 'DEPTH' | 'FLOW';

export const BinanceOrderBook: React.FC<BinanceOrderBookProps> = ({
  t,
  pair,
  defaultLot = 10,
  onQuickTrade,
  compact = false,
}) => {
  const [tab, setTab] = useState<BookTab>('BOOK');
  const [lotAmount, setLotAmount] = useState<number>(Math.max(1, defaultLot));
  const [submitting, setSubmitting] = useState(false);

  const decimals = pair.price > 50 ? 2 : pair.price > 5 ? 3 : 4;
  const qtyDecimals = pair.price > 500 ? 3 : pair.price > 10 ? 2 : 0;

  // Synthesize crisp 7-level orderbook ladder seeded deterministically around live pair price
  const { asks, bids, bidPct, askPct } = useMemo(() => {
    const step = pair.price * 0.00035;
    const seed = pair.symbol.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
    const askRows = Array.from({ length: compact ? 5 : 7 }, (_, i) => {
      const idx = (compact ? 5 : 7) - i;
      const px = pair.price + step * idx;
      const size = Number(
        ((0.4 + Math.abs(Math.sin(seed + idx * 1.7 + pair.price * 0.01)) * 4.2) *
          (pair.price > 1000 ? 1 : pair.price > 50 ? 18 : 850)).toFixed(qtyDecimals)
      );
      return { px, size };
    });

    const bidRows = Array.from({ length: compact ? 5 : 7 }, (_, i) => {
      const idx = i + 1;
      const px = Math.max(0.0001, pair.price - step * idx);
      const size = Number(
        ((0.45 + Math.abs(Math.cos(seed + idx * 1.4 + pair.price * 0.01)) * 4.4) *
          (pair.price > 1000 ? 1 : pair.price > 50 ? 18 : 850)).toFixed(qtyDecimals)
      );
      return { px, size };
    });

    const bidP = Number(Math.max(20, Math.min(80, pair.inflowPct)).toFixed(2));
    const askP = Number((100 - bidP).toFixed(2));
    return { asks: askRows, bids: bidRows, bidPct: bidP, askPct: askP };
  }, [pair.price, pair.symbol, pair.inflowPct, compact, qtyDecimals]);

  const maxOrderSize = useMemo(
    () => Math.max(1, ...asks.map((a) => a.size), ...bids.map((b) => b.size)),
    [asks, bids]
  );

  // Cumulative depth SVG paths
  const depthSvg = useMemo(() => {
    const w = 320;
    const h = 140;
    const sortedAsks = [...asks].reverse();
    let cumBid = 0;
    const bidPts = bids.map((b, i) => {
      cumBid += b.size;
      return { x: w / 2 - ((i + 1) / bids.length) * (w / 2 - 8), yVal: cumBid };
    });
    let cumAsk = 0;
    const askPts = sortedAsks.map((a, i) => {
      cumAsk += a.size;
      return { x: w / 2 + ((i + 1) / sortedAsks.length) * (w / 2 - 8), yVal: cumAsk };
    });
    const maxCum = Math.max(1, cumBid, cumAsk);
    const toY = (v: number) => h - 14 - (v / maxCum) * (h - 28);

    const bidPath = [
      `M ${w / 2} ${h - 14}`,
      ...bidPts.map((pt) => `L ${pt.x.toFixed(1)} ${toY(pt.yVal).toFixed(1)}`),
      `L 8 ${h - 14} Z`,
    ].join(' ');

    const askPath = [
      `M ${w / 2} ${h - 14}`,
      ...askPts.map((pt) => `L ${pt.x.toFixed(1)} ${toY(pt.yVal).toFixed(1)}`),
      `L ${w - 8} ${h - 14} Z`,
    ].join(' ');

    return { w, h, bidPath, askPath };
  }, [asks, bids]);

  const handleExec = async (side: 'BUY' | 'SELL') => {
    setSubmitting(true);
    await onQuickTrade(pair.symbol, side, Math.max(1, lotAmount));
    setSubmitting(false);
  };

  const tabs: { id: BookTab; label: string }[] = [
    { id: 'BOOK', label: t.tabOrderBook },
    { id: 'DEPTH', label: t.tabDepth },
    { id: 'FLOW', label: t.tabInflow },
  ];

  const inflowP = pair.inflowPct;
  const outflowP = Number((100 - inflowP).toFixed(1));

  return (
    <TerminalPanel
      accent="cyan"
      title={t.orderBookTitle}
      subtitle={`${pair.symbol} · L2 Liquidity`}
      rightSlot={<InfoTip text={t.helpOrderBook} label={t.orderBookTitle} />}
      className="h-full"
    >
      <div className="flex h-full flex-col justify-between gap-3">
        <div>
          {/* Top Tabs */}
          <div className="mb-2.5 flex items-center gap-1 rounded-lg border border-slate-800 bg-[#05060a] p-0.5">
            {tabs.map((tb) => (
              <button
                key={tb.id}
                type="button"
                onClick={() => {
                  audioSynth.playClick();
                  setTab(tb.id);
                }}
                className={`min-h-[30px] flex-1 cursor-pointer rounded px-2 py-1 font-mono-tech text-[10px] font-semibold uppercase transition-colors ${
                  tab === tb.id
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tb.label}
              </button>
            ))}
          </div>

          {/* Pressure Bar (Binance 41.39% vs 58.61% style) */}
          <div className="mb-2.5 space-y-1 font-mono-tech text-[10px]">
            <div className="flex items-center justify-between">
              <span className="font-bold text-emerald-400">
                {t.bidLabel} {bidPct.toFixed(2)}%
              </span>
              <span className="font-bold text-rose-400">
                {askPct.toFixed(2)}% {t.askLabel}
              </span>
            </div>
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-emerald-400 transition-all duration-300"
                style={{ width: `${bidPct}%` }}
              />
              <div
                className="h-full bg-rose-500 transition-all duration-300"
                style={{ width: `${askPct}%` }}
              />
            </div>
          </div>

          {/* Tab 1: L2 Order Book Ladder */}
          {tab === 'BOOK' && (
            <div className="space-y-1 font-mono-tech text-[11px]">
              <div className="grid grid-cols-3 text-[9px] text-slate-500 uppercase">
                <span>Price</span>
                <span className="text-right">Size({pair.base})</span>
                <span className="text-right">Total($)</span>
              </div>

              {/* Asks */}
              <div className="space-y-0.5">
                {asks.map((row, idx) => {
                  const pct = Math.min(100, (row.size / maxOrderSize) * 100);
                  return (
                    <div
                      key={`ask-${idx}`}
                      className="relative grid grid-cols-3 items-center rounded px-1.5 py-0.5"
                    >
                      <div
                        className="pointer-events-none absolute top-0 right-0 bottom-0 rounded bg-rose-500/14"
                        style={{ width: `${pct}%` }}
                      />
                      <span className="relative z-10 font-semibold text-rose-400">
                        {row.px.toFixed(decimals)}
                      </span>
                      <span className="relative z-10 text-right text-slate-300">{row.size}</span>
                      <span className="relative z-10 text-right text-slate-400">
                        {Math.round(row.px * row.size).toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Mid Market Spread Price */}
              <div className="my-1.5 flex items-center justify-between rounded border border-slate-800 bg-[#05070d] px-2 py-1">
                <span
                  className={`text-sm font-bold ${
                    pair.change24h >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  ${pair.price.toFixed(decimals)}
                </span>
                <span className="text-[10px] text-slate-500">SPREAD 0.01%</span>
              </div>

              {/* Bids */}
              <div className="space-y-0.5">
                {bids.map((row, idx) => {
                  const pct = Math.min(100, (row.size / maxOrderSize) * 100);
                  return (
                    <div
                      key={`bid-${idx}`}
                      className="relative grid grid-cols-3 items-center rounded px-1.5 py-0.5"
                    >
                      <div
                        className="pointer-events-none absolute top-0 right-0 bottom-0 rounded bg-emerald-500/14"
                        style={{ width: `${pct}%` }}
                      />
                      <span className="relative z-10 font-semibold text-emerald-400">
                        {row.px.toFixed(decimals)}
                      </span>
                      <span className="relative z-10 text-right text-slate-300">{row.size}</span>
                      <span className="relative z-10 text-right text-slate-400">
                        {Math.round(row.px * row.size).toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tab 2: Cumulative Market Depth Chart */}
          {tab === 'DEPTH' && (
            <div className="rounded-xl border border-slate-800/80 bg-[#04060b] p-2">
              <svg viewBox={`0 0 ${depthSvg.w} ${depthSvg.h}`} className="h-44 w-full">
                <path
                  d={depthSvg.bidPath}
                  fill="rgba(16,185,129,0.28)"
                  stroke="#10b981"
                  strokeWidth="1.6"
                />
                <path
                  d={depthSvg.askPath}
                  fill="rgba(244,63,94,0.28)"
                  stroke="#f43f5e"
                  strokeWidth="1.6"
                />
                <line
                  x1={depthSvg.w / 2}
                  x2={depthSvg.w / 2}
                  y1={8}
                  y2={depthSvg.h - 14}
                  stroke="#64748b"
                  strokeDasharray="3 3"
                />
                <text
                  x={depthSvg.w / 2}
                  y={depthSvg.h - 2}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="9"
                  fontFamily="JetBrains Mono"
                >
                  MID ${pair.price.toFixed(decimals)}
                </text>
              </svg>
            </div>
          )}

          {/* Tab 3: Money Flow (Inflow vs Outflow) */}
          {tab === 'FLOW' && (
            <div className="space-y-3 rounded-xl border border-slate-800/80 bg-[#05070d] p-3 font-mono-tech text-xs">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-slate-400 uppercase">{t.inflowLabel}</div>
                  <div className="text-base font-bold text-emerald-400">{inflowP.toFixed(1)}%</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-400 uppercase">{t.outflowLabel}</div>
                  <div className="text-base font-bold text-rose-400">{outflowP.toFixed(1)}%</div>
                </div>
              </div>

              <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-800">
                <div className="h-full bg-emerald-400" style={{ width: `${inflowP}%` }} />
                <div className="h-full bg-rose-500" style={{ width: `${outflowP}%` }} />
              </div>

              {[
                { label: 'Whale Orders (>$50k)', inV: inflowP + 3.2 },
                { label: 'Mid Orders ($5k-$50k)', inV: inflowP - 1.4 },
                { label: 'Micro Spot ($1-$5k)', inV: inflowP + 0.8 },
              ].map((tier) => {
                const clampedIn = Math.max(15, Math.min(85, tier.inV));
                return (
                  <div key={tier.label} className="space-y-1">
                    <div className="flex justify-between text-[10px] text-slate-400">
                      <span>{tier.label}</span>
                      <span className="text-slate-200">{clampedIn.toFixed(1)}% Buy</span>
                    </div>
                    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                      <div className="bg-emerald-400" style={{ width: `${clampedIn}%` }} />
                      <div className="bg-rose-500" style={{ width: `${100 - clampedIn}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Quick Spot Execution ($1+ minimum) */}
        <div className="space-y-2 border-t border-slate-800/80 pt-2.5">
          <div className="flex items-center justify-between gap-2 font-mono-tech text-[10px]">
            <span className="font-bold tracking-wider text-slate-400 uppercase">
              {t.quickOrderTitle}
            </span>
            <input
              type="number"
              min={1}
              step={1}
              aria-label="Quick Spot Amount USDT"
              value={lotAmount}
              onChange={(e) => setLotAmount(Math.max(1, Number(e.target.value)))}
              className="w-20 rounded border border-slate-700 bg-[#04060b] px-2 py-0.5 text-right text-xs font-bold text-cyan-300 focus:border-cyan-400 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-5 gap-1">
            {[1, 5, 10, 25, 100].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  audioSynth.playClick();
                  setLotAmount(v);
                }}
                className={`min-h-[26px] cursor-pointer rounded border font-mono-tech text-[10px] font-semibold transition-colors ${
                  lotAmount === v
                    ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-200'
                    : 'border-slate-800 bg-[#05070d] text-slate-400 hover:text-slate-200'
                }`}
              >
                ${v}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <NeonButton
              variant="emerald"
              disabled={submitting}
              onClick={() => handleExec('BUY')}
              className="w-full"
            >
              {t.buyLongBtn}
            </NeonButton>
            <NeonButton
              variant="rose"
              disabled={submitting}
              onClick={() => handleExec('SELL')}
              className="w-full"
            >
              {t.sellShortBtn}
            </NeonButton>
          </div>
        </div>
      </div>
    </TerminalPanel>
  );
};
