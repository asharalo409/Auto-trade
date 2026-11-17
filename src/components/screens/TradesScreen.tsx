import React, { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Layers, ShieldCheck, TrendingUp } from 'lucide-react';
import { SUPPORTED_PAIRS } from '../../data/demoData';
import { Trade, TradeStatus } from '../../types/trading';
import { AnimatedNumber } from '../ui/AnimatedNumber';
import { NeonButton, SkeletonBlock } from '../ui/MotionPrimitives';
import { TerminalPanel } from '../ui/TerminalPanel';

interface TradesScreenProps {
  t: Record<string, string>;
  trades: Trade[];
  zeroLossMode: boolean;
  loading: boolean;
  onCloseTrade: (id: string) => Promise<void>;
}

type DateFilter = 'ALL' | 'TODAY' | '7D' | '30D';

export const TradesScreen: React.FC<TradesScreenProps> = ({
  t,
  trades,
  zeroLossMode,
  loading,
  onCloseTrade,
}) => {
  const reducedMotion = useReducedMotion();
  const [pairFilter, setPairFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | TradeStatus>('ALL');
  const [dateFilter, setDateFilter] = useState<DateFilter>('ALL');

  const openTrades = useMemo(
    () => trades.filter((tr) => tr.status === 'OPEN'),
    [trades]
  );

  const filteredHistory = useMemo(() => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    return trades.filter((tr) => {
      if (pairFilter !== 'ALL' && tr.pair !== pairFilter) return false;
      if (statusFilter !== 'ALL' && tr.status !== statusFilter) return false;
      const ts = new Date(tr.opened_at).getTime();
      if (dateFilter === 'TODAY' && ts < todayStart.getTime()) return false;
      if (dateFilter === '7D' && now - ts > 7 * 86_400_000) return false;
      if (dateFilter === '30D' && now - ts > 30 * 86_400_000) return false;
      return true;
    });
  }, [trades, pairFilter, statusFilter, dateFilter]);

  if (loading) {
    return (
      <div className="space-y-4">
        <SkeletonBlock className="h-44" />
        <SkeletonBlock className="h-72" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <TerminalPanel
        accent="emerald"
        title={t.openPositionsTitle}
        rightSlot={
          <div className="flex items-center gap-3">
            {zeroLossMode && (
              <span className="inline-flex items-center gap-1 font-mono-tech text-[11px] font-semibold text-emerald-400">
                <ShieldCheck className="h-3.5 w-3.5" />
                {t.zeroLossBadge}
              </span>
            )}
            <span className="font-mono-tech text-xs font-semibold text-emerald-300">
              {openTrades.length} ACTIVE
            </span>
          </div>
        }
      >
        {openTrades.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-xs text-slate-400">
            <TrendingUp className="h-6 w-6 text-slate-600" />
            <span>{t.noOpenTrades}</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {openTrades.map((trade, idx) => {
              const isPos = trade.profit_usdt >= 0;
              const tpRange = Math.max(0.0001, trade.take_profit_price - trade.entry_price);
              const progressPct = Math.max(
                4,
                Math.min(100, ((trade.current_price - trade.entry_price) / tpRange) * 100)
              );
              const blockedByZeroLoss = zeroLossMode && trade.profit_usdt < 0;

              return (
                <motion.div
                  key={trade.id}
                  initial={reducedMotion ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, delay: idx * 0.04 }}
                  className="rounded-xl border border-slate-800/90 bg-[#05070d] p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-display text-lg font-bold tracking-wide text-white">
                          {trade.pair}
                        </span>
                        <span className="font-mono-tech text-[11px] text-emerald-400">
                          {trade.side}
                        </span>
                      </div>
                      <div className="mt-0.5 font-mono-tech text-[11px] text-slate-400">
                        {t.invested}: ${trade.invested_usdt} · Qty {trade.quantity}
                      </div>
                    </div>

                    <div className="text-right">
                      <div
                        className={`text-lg font-bold ${
                          isPos ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        <AnimatedNumber
                          value={trade.profit_usdt}
                          prefix="$"
                          decimals={2}
                          showSign
                        />
                      </div>
                      <div
                        className={`font-mono-tech text-xs ${
                          isPos ? 'text-emerald-300' : 'text-rose-300'
                        }`}
                      >
                        {isPos ? '+' : ''}
                        {trade.profit_pct.toFixed(2)}%
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 font-mono-tech text-[11px]">
                    <div>
                      <span className="block text-slate-500">{t.entryPrice}</span>
                      <span className="text-slate-200">${trade.entry_price}</span>
                    </div>
                    <div>
                      <span className="block text-slate-500">{t.currentPrice}</span>
                      <span className="text-cyan-300">${trade.current_price}</span>
                    </div>
                    <div className="text-right">
                      <span className="block text-slate-500">TP TARGET</span>
                      <span className="text-emerald-300">${trade.take_profit_price}</span>
                    </div>
                  </div>

                  <div className="mt-3">
                    <div className="mb-1 flex items-center justify-between font-mono-tech text-[10px] text-slate-400">
                      <span>{t.tpProgress}</span>
                      <span>{progressPct.toFixed(0)}%</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        className={`relative h-full overflow-hidden rounded-full transition-all duration-500 ${
                          isPos
                            ? 'bg-gradient-to-r from-cyan-400 to-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.6)]'
                            : 'bg-rose-500'
                        }`}
                        style={{ width: `${progressPct}%` }}
                      >
                        {!reducedMotion && (
                          <div className="animate-tp-shimmer absolute inset-0 w-1/2 bg-gradient-to-r from-transparent via-white/60 to-transparent" />
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-slate-800/80 pt-2.5">
                    <span className="font-mono-tech text-[10px] text-slate-500">
                      {new Date(trade.opened_at).toLocaleString()}
                    </span>
                    <NeonButton
                      variant={blockedByZeroLoss ? 'ghost' : 'rose'}
                      onClick={() => onCloseTrade(trade.id)}
                      className="min-h-[34px] px-3 py-1 text-[11px]"
                    >
                      {blockedByZeroLoss ? 'SHIELD HOLD' : t.closePosition}
                    </NeonButton>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </TerminalPanel>

      <TerminalPanel
        accent="cyan"
        title={t.tradeHistoryTitle}
        rightSlot={
          <span className="font-mono-tech text-xs text-slate-400">
            {filteredHistory.length} RECORDS
          </span>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            aria-label={t.filterPair}
            value={pairFilter}
            onChange={(e) => setPairFilter(e.target.value)}
            className="min-h-[40px] rounded-lg border border-slate-700/80 bg-[#05060a] px-3 font-mono-tech text-xs text-slate-200 focus:border-cyan-400 focus:outline-none"
          >
            <option value="ALL">{t.filterPair}</option>
            {SUPPORTED_PAIRS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <select
            aria-label={t.filterStatus}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'ALL' | TradeStatus)}
            className="min-h-[40px] rounded-lg border border-slate-700/80 bg-[#05060a] px-3 font-mono-tech text-xs text-slate-200 focus:border-cyan-400 focus:outline-none"
          >
            <option value="ALL">{t.filterStatus}</option>
            <option value="OPEN">OPEN</option>
            <option value="CLOSED">CLOSED</option>
            <option value="CANCELLED">CANCELLED</option>
          </select>

          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#05060a] p-1">
            {(
              [
                ['ALL', t.filterDateAll],
                ['TODAY', t.filterDateToday],
                ['7D', t.filterDate7d],
                ['30D', t.filterDate30d],
              ] as [DateFilter, string][]
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setDateFilter(val)}
                className={`min-h-[32px] rounded px-2.5 py-1 font-mono-tech text-[11px] transition-colors ${
                  dateFilter === val
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filteredHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-xs text-slate-400">
            <Layers className="h-6 w-6 text-slate-600" />
            <span>{t.noHistoryTrades}</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left font-mono-tech text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] tracking-wider text-slate-400 uppercase">
                  <th className="py-2.5 pr-3">PAIR</th>
                  <th className="py-2.5 pr-3">STATUS</th>
                  <th className="py-2.5 pr-3 text-right">{t.entryPrice}</th>
                  <th className="py-2.5 pr-3 text-right">{t.currentPrice}</th>
                  <th className="py-2.5 pr-3 text-right">{t.invested}</th>
                  <th className="py-2.5 pr-3 text-right">{t.pnlLabel}</th>
                  <th className="py-2.5 text-right">TIME</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredHistory.map((tr) => {
                  const isPos = tr.profit_usdt >= 0;
                  return (
                    <tr key={tr.id} className="transition-colors hover:bg-slate-900/45">
                      <td className="py-2.5 pr-3 font-semibold text-slate-100">
                        {tr.pair}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={`font-semibold ${
                            tr.status === 'OPEN'
                              ? 'text-cyan-300'
                              : tr.status === 'CLOSED'
                                ? 'text-emerald-400'
                                : 'text-slate-400'
                          }`}
                        >
                          {tr.status}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-right text-slate-300">
                        ${tr.entry_price}
                      </td>
                      <td className="py-2.5 pr-3 text-right text-slate-300">
                        ${tr.exit_price ?? tr.current_price}
                      </td>
                      <td className="py-2.5 pr-3 text-right text-slate-300">
                        ${tr.invested_usdt}
                      </td>
                      <td
                        className={`py-2.5 pr-3 text-right font-semibold ${
                          isPos ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {isPos ? '+' : ''}${tr.profit_usdt.toFixed(2)} ({isPos ? '+' : ''}
                        {tr.profit_pct.toFixed(2)}%)
                      </td>
                      <td className="py-2.5 text-right text-slate-400">
                        {new Date(tr.opened_at).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </TerminalPanel>
    </div>
  );
};
