import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  Layers,
  Minus,
  Plus,
  Zap,
} from 'lucide-react';
import { audioSynth } from '../../lib/audioSynth';
import { telegramHaptic } from '../../lib/telegramWebApp';
import { PairMarketData, Trade, TradingMode } from '../../types/trading';
import { TerminalPanel } from './TerminalPanel';

interface ManualExecutionDeckProps {
  workspace: TradingMode;
  symbol: string;
  pairs: PairMarketData[];
  trades: Trade[];
  defaultAmount: number;
  availableUsdt: number;
  hasBinanceKeys: boolean;
  minNotional: number;
  onQuickTrade: (pairSymbol: string, side: 'BUY' | 'SELL', amountUsdt: number) => Promise<void>;
  onCloseAll: () => Promise<{ closed: number; realizedPnl: number }>;
  onSelectSymbol: (symbol: string) => void;
}

const PRESETS = [5, 10, 25, 50];

const formatPx = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(5);
};

export const ManualExecutionDeck: React.FC<ManualExecutionDeckProps> = ({
  workspace,
  symbol,
  pairs,
  trades,
  defaultAmount,
  availableUsdt,
  hasBinanceKeys,
  minNotional,
  onQuickTrade,
  onCloseAll,
  onSelectSymbol,
}) => {
  const reducedMotion = useReducedMotion();
  const [amount, setAmount] = useState<number>(Math.max(minNotional, Math.round(defaultAmount || 10)));
  const [customOpen, setCustomOpen] = useState(false);
  const [pendingSide, setPendingSide] = useState<'BUY' | 'SELL' | null>(null);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [closeResult, setCloseResult] = useState<{ closed: number; realizedPnl: number } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  const pair = useMemo(
    () => pairs.find((p) => p.symbol === symbol) ?? pairs[0],
    [pairs, symbol]
  );
  const openForSymbol = useMemo(
    () => trades.filter((t) => t.status === 'OPEN' && t.pair === pair?.symbol),
    [trades, pair?.symbol]
  );
  const openCount = useMemo(() => trades.filter((t) => t.status === 'OPEN').length, [trades]);

  if (!pair) return null;

  const isLive = workspace === 'LIVE';
  const needsKeys = isLive && !hasBinanceKeys;
  const insufficient = isLive && availableUsdt < Math.max(minNotional, amount);

  const runTrade = async (side: 'BUY' | 'SELL') => {
    telegramHaptic('medium');
    audioSynth.playClick();
    setBlocked(null);
    setCloseResult(null);

    if (needsKeys) {
      setBlocked('Link Binance API keys in Settings before executing a LIVE order.');
      audioSynth.playTradeChime(false);
      return;
    }
    if (amount < minNotional) {
      setBlocked(`Minimum order is $${minNotional.toFixed(2)} USDT.`);
      audioSynth.playTradeChime(false);
      return;
    }
    if (insufficient) {
      setBlocked(
        `Spot USDT available is $${availableUsdt.toFixed(2)} — lower the size or deposit more.`
      );
      audioSynth.playTradeChime(false);
      return;
    }
    if (side === 'SELL' && openForSymbol.length === 0) {
      setBlocked(`No open ${pair.symbol} position to sell in ${workspace}.`);
      audioSynth.playTradeChime(false);
      return;
    }

    setPendingSide(side);
    try {
      await onQuickTrade(pair.symbol, side, amount);
    } finally {
      setPendingSide(null);
    }
  };

  const handleCloseAll = async () => {
    telegramHaptic('heavy');
    audioSynth.playClick();
    if (!confirmCloseAll) {
      setConfirmCloseAll(true);
      setBlocked(null);
      window.setTimeout(() => setConfirmCloseAll(false), 6000);
      return;
    }
    setConfirmCloseAll(false);
    setPendingSide('SELL');
    try {
      const result = await onCloseAll();
      setCloseResult(result);
      telegramHaptic('medium');
    } finally {
      setPendingSide(null);
    }
  };

  return (
    <TerminalPanel
      accent={isLive ? 'crimson' : 'emerald'}
      title="Manual Execution Deck"
      subtitle={`${pair.symbol} · ${isLive ? 'Binance Spot market order' : 'Paper engine fill'} · ${
        isLive ? 'LIVE' : 'VIRTUAL'
      }`}
      className="hud-conic-active"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <select
            value={pair.symbol}
            aria-label="Execution pair"
            onChange={(e) => {
              telegramHaptic('light');
              onSelectSymbol(e.target.value);
            }}
            className="min-h-[38px] rounded-lg border border-slate-700/80 bg-[#05060a] px-2.5 font-mono-tech text-xs font-semibold text-slate-100 focus:border-cyan-400 focus:outline-none"
          >
            {pairs.map((p) => (
              <option key={p.symbol} value={p.symbol}>
                {p.symbol}
              </option>
            ))}
          </select>
          <div className="flex items-baseline gap-2 font-mono-tech">
            <span className="text-lg font-bold text-white">${formatPx(pair.price)}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                pair.change24h >= 0
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-rose-500/15 text-rose-300'
              }`}
            >
              {pair.change24h >= 0 ? '+' : ''}
              {pair.change24h.toFixed(2)}%
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                telegramHaptic('light');
                audioSynth.playClick();
                setAmount(preset);
                setCustomOpen(false);
              }}
              className={`min-h-[38px] cursor-pointer rounded-full border px-3 font-mono-tech text-xs font-bold transition-colors ${
                amount === preset && !customOpen
                  ? 'border-amber-300/70 bg-amber-400/20 text-amber-200'
                  : 'border-slate-700/80 bg-[#090d16] text-slate-300 hover:border-slate-500'
              }`}
            >
              ${preset}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              telegramHaptic('light');
              setCustomOpen((v) => !v);
            }}
            className={`inline-flex min-h-[38px] cursor-pointer items-center gap-1 rounded-full border px-3 font-mono-tech text-xs font-bold transition-colors ${
              customOpen
                ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-200'
                : 'border-slate-700/80 bg-[#090d16] text-slate-300 hover:border-slate-500'
            }`}
          >
            Custom
          </button>
          {customOpen && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Decrease amount"
                onClick={() => setAmount((v) => Math.max(1, Number((v - 5).toFixed(2))))}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-slate-700 bg-[#090d16] text-slate-300"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <input
                type="number"
                min={1}
                step="1"
                value={amount}
                onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
                aria-label="Custom order size in USDT"
                className="min-h-[36px] w-20 rounded-lg border border-cyan-500/50 bg-[#05060a] px-2 text-center font-mono-tech text-xs font-bold text-cyan-200 focus:border-cyan-300 focus:outline-none"
              />
              <button
                type="button"
                aria-label="Increase amount"
                onClick={() => setAmount((v) => Number((v + 5).toFixed(2)))}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-slate-700 bg-[#090d16] text-slate-300"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <motion.button
            type="button"
            whileTap={reducedMotion ? undefined : { scale: 0.97 }}
            disabled={pendingSide !== null}
            onClick={() => void runTrade('BUY')}
            className="tap-target flex min-h-[52px] cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-gradient-to-b from-emerald-400 to-emerald-600 px-3 font-display text-sm font-black tracking-wider text-[#04120c] uppercase shadow-[0_14px_30px_-14px_rgba(16,185,129,0.85)] disabled:cursor-wait disabled:opacity-60"
          >
            <Zap className="h-4 w-4" />
            {pendingSide === 'BUY' ? 'Sending…' : '⚡ Quick Buy'}
          </motion.button>
          <motion.button
            type="button"
            whileTap={reducedMotion ? undefined : { scale: 0.97 }}
            disabled={pendingSide !== null}
            onClick={() => void runTrade('SELL')}
            className="tap-target flex min-h-[52px] cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-gradient-to-b from-rose-400 to-rose-600 px-3 font-display text-sm font-black tracking-wider text-[#170308] uppercase shadow-[0_14px_30px_-14px_rgba(244,63,94,0.85)] disabled:cursor-wait disabled:opacity-60"
          >
            <Zap className="h-4 w-4" />
            {pendingSide === 'SELL' ? 'Sending…' : '🔻 Quick Sell'}
          </motion.button>
        </div>

        <button
          type="button"
          onClick={() => void handleCloseAll()}
          disabled={pendingSide !== null || openCount === 0}
          className={`tap-target flex min-h-[46px] w-full cursor-pointer items-center justify-center gap-2 rounded-xl border font-display text-xs font-black tracking-[0.14em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
            confirmCloseAll
              ? 'border-rose-300 bg-rose-500/35 text-white shadow-[0_0_26px_rgba(244,63,94,0.5)]'
              : 'border-rose-500/50 bg-rose-500/12 text-rose-200 hover:bg-rose-500/20'
          }`}
        >
          {confirmCloseAll ? (
            <>
              <AlertTriangle className="h-4 w-4" />
              Tap again to close {openCount} position{openCount === 1 ? '' : 's'}
            </>
          ) : (
            <>
              <Layers className="h-4 w-4" />
              🛑 Close All Positions
            </>
          )}
        </button>

        <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[10px] tracking-wide text-slate-500 uppercase">
          <span>
            {isLive ? `Tradeable: $${availableUsdt.toFixed(2)} USDT` : `Paper cash: $${availableUsdt.toFixed(2)}`}
          </span>
          <span>
            {openForSymbol.length} open on {pair.base} · {openCount} total
          </span>
        </div>

        <AnimatePresence initial={false}>
          {blocked && (
            <motion.div
              key="blocked"
              initial={reducedMotion ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-start gap-2 rounded-lg border border-amber-500/45 bg-amber-500/10 px-3 py-2 font-mono-tech text-[11px] text-amber-200"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{blocked}</span>
            </motion.div>
          )}
          {closeResult && (
            <motion.div
              key="close-result"
              initial={reducedMotion ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 font-mono-tech text-[11px] ${
                closeResult.realizedPnl >= 0
                  ? 'border-emerald-500/45 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/45 bg-rose-500/10 text-rose-200'
              }`}
            >
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Closed {closeResult.closed} position{closeResult.closed === 1 ? '' : 's'} · Realized PnL{' '}
                {closeResult.realizedPnl >= 0 ? '+' : ''}${closeResult.realizedPnl.toFixed(2)} USDT
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </TerminalPanel>
  );
};
