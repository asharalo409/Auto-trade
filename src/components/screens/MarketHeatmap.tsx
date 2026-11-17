import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowDownRight, ArrowUpRight, X } from 'lucide-react';
import { audioSynth } from '../../lib/audioSynth';
import { CandleStyle, PairMarketData, Trade } from '../../types/trading';
import { CandlestickChart } from '../charts/CandlestickChart';
import { SciFiSwitch } from '../ui/MotionPrimitives';
import { TerminalPanel } from '../ui/TerminalPanel';
import { BinanceOrderBook } from '../widgets/BinanceOrderBook';

interface MarketHeatmapProps {
  t: Record<string, string>;
  pairs: PairMarketData[];
  enabledPairs: string[];
  openTrades: Trade[];
  candleStyle: CandleStyle;
  binanceFeedLive?: boolean;
  defaultLot?: number;
  onChangeCandleStyle: (style: CandleStyle) => void;
  onTogglePair: (symbol: string) => Promise<void>;
  onQuickTrade: (pairSymbol: string, side: 'BUY' | 'SELL', amountUsdt: number) => Promise<void>;
}

export const MarketHeatmap: React.FC<MarketHeatmapProps> = ({
  t,
  pairs,
  enabledPairs,
  openTrades,
  candleStyle,
  binanceFeedLive = false,
  defaultLot = 10,
  onChangeCandleStyle,
  onTogglePair,
  onQuickTrade,
}) => {
  const reducedMotion = useReducedMotion();
  const [selectedSymbol, setSelectedSymbol] = useState<string>('BTCUSDT');

  const selectedPair = useMemo(
    () => pairs.find((p) => p.symbol === selectedSymbol) ?? pairs[0],
    [pairs, selectedSymbol]
  );

  const selectedOpenTrade = useMemo(
    () => openTrades.find((tr) => tr.pair === selectedPair?.symbol && tr.status === 'OPEN'),
    [openTrades, selectedPair]
  );

  const getTileStyle = (change: number, isSelected: boolean) => {
    const intensity = Math.min(1, Math.abs(change) / 6);
    if (change >= 0) {
      const alpha = (0.12 + intensity * 0.24).toFixed(2);
      return {
        backgroundColor: `rgba(16, 185, 129, ${alpha})`,
        borderColor: isSelected ? 'rgba(52, 211, 153, 0.95)' : 'rgba(16, 185, 129, 0.35)',
        boxShadow: isSelected ? '0 0 24px rgba(16, 185, 129, 0.4)' : undefined,
      };
    }
    const alpha = (0.12 + intensity * 0.24).toFixed(2);
    return {
      backgroundColor: `rgba(244, 63, 94, ${alpha})`,
      borderColor: isSelected ? 'rgba(251, 113, 133, 0.95)' : 'rgba(244, 63, 94, 0.35)',
      boxShadow: isSelected ? '0 0 24px rgba(244, 63, 94, 0.4)' : undefined,
    };
  };

  return (
    <div className="space-y-4">
      <TerminalPanel
        accent="cyan"
        title={t.marketHeatmapTitle}
        subtitle={t.marketHeatmapSub}
        rightSlot={
          <span className="font-mono-tech text-xs text-cyan-300">
            {enabledPairs.length}/10 ACTIVE
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-5">
          {pairs.map((pair, idx) => {
            const isPos = pair.change24h >= 0;
            const isSelected = pair.symbol === selectedPair?.symbol;
            const isEnabled = enabledPairs.includes(pair.symbol);
            const hasOpen = openTrades.some((tr) => tr.pair === pair.symbol && tr.status === 'OPEN');
            const lastClosedForPair = openTrades.find(
              (tr) => tr.pair === pair.symbol && tr.status === 'CLOSED'
            );

            return (
              <motion.button
                key={pair.symbol}
                type="button"
                onMouseEnter={() => audioSynth.playHover()}
                onClick={() => {
                  audioSynth.playClick();
                  setSelectedSymbol(pair.symbol);
                }}
                initial={reducedMotion ? false : { opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.25, delay: idx * 0.025 }}
                whileHover={reducedMotion ? undefined : { y: -3, scale: 1.02 }}
                whileTap={reducedMotion ? undefined : { scale: 0.98 }}
                style={getTileStyle(pair.change24h, isSelected)}
                className={`relative flex min-h-[108px] cursor-pointer flex-col justify-between rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-cyan-400 ${
                  !reducedMotion ? 'animate-tile-breathe' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-display text-base font-bold tracking-wide text-slate-100">
                    {pair.base}
                    <span className="text-xs font-normal text-slate-400">/USDT</span>
                  </span>
                  <span
                    className={`font-mono-tech text-[10px] font-bold uppercase ${
                      isEnabled ? 'text-cyan-300' : 'text-slate-500'
                    }`}
                  >
                    {isEnabled ? 'ON' : 'OFF'}
                  </span>
                </div>

                <div>
                  <div className="font-mono-tech text-sm font-semibold text-white">
                    $
                    {pair.price > 10
                      ? pair.price.toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })
                      : pair.price.toFixed(4)}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-1 font-mono-tech text-xs">
                    <span
                      className={`flex items-center gap-0.5 font-semibold ${
                        isPos ? 'text-emerald-300' : 'text-rose-300'
                      }`}
                    >
                      {isPos ? (
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      ) : (
                        <ArrowDownRight className="h-3.5 w-3.5" />
                      )}
                      {isPos ? '+' : ''}
                      {pair.change24h.toFixed(2)}%
                    </span>
                    {hasOpen && (
                      <span className="text-[10px] font-semibold text-amber-300">POS</span>
                    )}
                  </div>
                  {lastClosedForPair && (
                    <div className="mt-1.5 flex items-center justify-between gap-1.5 border-t border-white/10 pt-1 font-mono-tech text-[9px]">
                      <svg viewBox="0 0 42 12" className="h-2.5 w-9 shrink-0 overflow-visible">
                        <line
                          x1="3"
                          y1={lastClosedForPair.profit_usdt >= 0 ? '9' : '3'}
                          x2="39"
                          y2={lastClosedForPair.profit_usdt >= 0 ? '3' : '9'}
                          stroke={lastClosedForPair.profit_usdt >= 0 ? '#10b981' : '#f43f5e'}
                          strokeWidth="1.6"
                          strokeLinecap="round"
                        />
                        <polygon
                          points={`3,${lastClosedForPair.profit_usdt >= 0 ? 6.5 : 0.5} 5.5,${
                            lastClosedForPair.profit_usdt >= 0 ? 9 : 3
                          } 3,${lastClosedForPair.profit_usdt >= 0 ? 11.5 : 5.5} 0.5,${
                            lastClosedForPair.profit_usdt >= 0 ? 9 : 3
                          }`}
                          fill="#05060a"
                          stroke={lastClosedForPair.profit_usdt >= 0 ? '#10b981' : '#f43f5e'}
                          strokeWidth="1.2"
                        />
                        <circle
                          cx="39"
                          cy={lastClosedForPair.profit_usdt >= 0 ? '3' : '9'}
                          r="2.4"
                          fill={lastClosedForPair.profit_usdt >= 0 ? '#10b981' : '#f43f5e'}
                        />
                      </svg>
                      <span
                        className={`font-bold ${
                          lastClosedForPair.profit_usdt >= 0 ? 'text-emerald-300' : 'text-rose-300'
                        }`}
                      >
                        {lastClosedForPair.profit_usdt >= 0 ? '+' : ''}$
                        {lastClosedForPair.profit_usdt.toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>
              </motion.button>
            );
          })}
        </div>
      </TerminalPanel>

      <AnimatePresence mode="wait">
        {selectedPair && (
          <motion.div
            key={selectedPair.symbol}
            initial={reducedMotion ? false : { opacity: 0, y: 14, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? undefined : { opacity: 0, y: -8 }}
            transition={
              reducedMotion
                ? { duration: 0 }
                : { type: 'spring', stiffness: 320, damping: 28 }
            }
          >
            <TerminalPanel
              accent={selectedPair.change24h >= 0 ? 'emerald' : 'crimson'}
              title={`${selectedPair.symbol} // CANDLESTICK & TELEMETRY`}
              subtitle={`24h Vol: $${(selectedPair.volume24h / 1_000_000).toFixed(1)}M`}
              rightSlot={
                <div className="flex items-center gap-3">
                  <span className="font-mono-tech text-xs text-slate-300">
                    {enabledPairs.includes(selectedPair.symbol)
                      ? t.pairEnabled
                      : t.pairDisabled}
                  </span>
                  <SciFiSwitch
                    checked={enabledPairs.includes(selectedPair.symbol)}
                    onChange={() => onTogglePair(selectedPair.symbol)}
                    label={`Toggle ${selectedPair.symbol}`}
                    accent="cyan"
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedSymbol('')}
                    aria-label="Close detail"
                    className="hidden sm:inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-slate-700/80 text-slate-400 hover:text-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              }
            >
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                <div className="lg:col-span-8">
                    <CandlestickChart
                      pairs={pairs}
                      selectedSymbol={selectedPair.symbol}
                      candleStyle={candleStyle}
                      onChangeCandleStyle={onChangeCandleStyle}
                      t={t}
                      compact
                      binanceFeedLive={binanceFeedLive}
                      trades={openTrades}
                    />
                </div>

                <div className="space-y-3 lg:col-span-4">
                  <div className="grid grid-cols-2 gap-2.5 content-start">
                    <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-2.5">
                      <div className="font-display text-[10px] tracking-wider text-slate-400 uppercase">
                        {t.rsiLabel}
                      </div>
                      <div
                        className={`mt-0.5 font-mono-tech text-lg font-bold ${
                          selectedPair.rsi14 > 65
                            ? 'text-amber-300'
                            : selectedPair.rsi14 < 38
                              ? 'text-rose-400'
                              : 'text-cyan-300'
                        }`}
                      >
                        {selectedPair.rsi14.toFixed(1)}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-2.5">
                      <div className="font-display text-[10px] tracking-wider text-slate-400 uppercase">
                        {t.signalLabel}
                      </div>
                      <div
                        className={`mt-0.5 font-mono-tech text-lg font-bold ${
                          selectedPair.signal === 'BUY'
                            ? 'text-emerald-400'
                            : selectedPair.signal === 'SELL'
                              ? 'text-rose-400'
                              : 'text-amber-300'
                        }`}
                      >
                        {selectedPair.signal}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-2.5">
                      <div className="font-display text-[10px] tracking-wider text-slate-400 uppercase">
                        {t.ema20Label}
                      </div>
                      <div className="mt-0.5 font-mono-tech text-xs font-semibold text-slate-200">
                        ${selectedPair.ema20.toLocaleString('en-US')}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-2.5">
                      <div className="font-display text-[10px] tracking-wider text-slate-400 uppercase">
                        {t.ema50Label}
                      </div>
                      <div className="mt-0.5 font-mono-tech text-xs font-semibold text-slate-200">
                        ${selectedPair.ema50.toLocaleString('en-US')}
                      </div>
                    </div>

                    <div className="col-span-2 rounded-xl border border-slate-800/80 bg-[#05070d] p-2.5">
                      <div className="font-display text-[10px] tracking-wider text-slate-400 uppercase">
                        {t.openPositionPnl}
                      </div>
                      {selectedOpenTrade ? (
                        <div className="mt-0.5 flex items-baseline justify-between font-mono-tech">
                          <span
                            className={`text-base font-bold ${
                              selectedOpenTrade.profit_usdt >= 0
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }`}
                          >
                            {selectedOpenTrade.profit_usdt >= 0 ? '+' : ''}$
                            {selectedOpenTrade.profit_usdt.toFixed(2)} (
                            {selectedOpenTrade.profit_pct >= 0 ? '+' : ''}
                            {selectedOpenTrade.profit_pct.toFixed(2)}%)
                          </span>
                          <span className="text-xs text-slate-400">
                            ${selectedOpenTrade.invested_usdt} USDT
                          </span>
                        </div>
                      ) : (
                        <div className="mt-0.5 font-mono-tech text-xs text-slate-500">
                          {t.noOpenPosition}
                        </div>
                      )}
                    </div>
                  </div>

                  <BinanceOrderBook
                    t={t}
                    pair={selectedPair}
                    defaultLot={defaultLot}
                    onQuickTrade={onQuickTrade}
                    compact
                  />
                </div>
              </div>
            </TerminalPanel>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
