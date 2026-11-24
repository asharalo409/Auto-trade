import React, { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, Download, Layers, Share2, ShieldCheck, TrendingUp, X } from 'lucide-react';
import { SUPPORTED_PAIRS } from '../../data/demoData';
import { audioSynth } from '../../lib/audioSynth';
import { downloadCsvFile } from '../../lib/csvExport';
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

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return [hours, minutes, seconds].map((v) => String(v).padStart(2, '0')).join(':');
}

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
  const [csvDone, setCsvDone] = useState(false);
  // Profitable closed trade rendered as the shareable AEGIS QUANT PnL card.
  const [shareTrade, setShareTrade] = useState<Trade | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick every second so each open position shows a live elapsed countdown.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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

  const handleDownloadCsv = () => {
    if (filteredHistory.length === 0) return;
    audioSynth.playClick();

    const headers = [
      'Date',
      'Symbol',
      'Side',
      'Entry',
      'Exit',
      'PnL USD',
      'Mode',
      'Trade ID',
      'Status',
      'Quantity',
      'Entry Price (USDT)',
      'Exit / Current Price (USDT)',
      'Invested (USDT)',
      'Profit / Loss (USDT)',
      'Profit / Loss (%)',
      'Opened At (UTC)',
      'Closed At (UTC)',
    ];

    const rows = filteredHistory.map((tr) => [
      new Date(tr.closed_at ?? tr.opened_at).toISOString(),
      tr.pair,
      tr.side,
      tr.entry_price,
      tr.exit_price ?? tr.current_price,
      tr.profit_usdt.toFixed(2),
      tr.mode ?? 'LIVE',
      tr.id,
      tr.status,
      tr.quantity,
      tr.entry_price,
      tr.exit_price ?? tr.current_price,
      tr.invested_usdt.toFixed(2),
      tr.profit_usdt.toFixed(2),
      tr.profit_pct.toFixed(2),
      new Date(tr.opened_at).toISOString(),
      tr.closed_at ? new Date(tr.closed_at).toISOString() : '',
    ]);

    downloadCsvFile(
      `aegis-trades-tax-report-${new Date().toISOString().slice(0, 10)}.csv`,
      headers,
      rows
    );

    setCsvDone(true);
    window.setTimeout(() => setCsvDone(false), 2200);
  };

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
              const blockedByZeroLoss =
                zeroLossMode && trade.profit_usdt - trade.invested_usdt * 0.002 <= 0;

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
                    <div className="flex flex-col gap-0.5">
                      <span
                        className="inline-flex items-center gap-1 font-mono-tech text-[11px] font-semibold text-cyan-300"
                        title={new Date(trade.opened_at).toLocaleString()}
                      >
                        <span
                          aria-hidden="true"
                          className={`inline-block h-1.5 w-1.5 rounded-full bg-cyan-400 ${
                            reducedMotion ? '' : 'animate-pulse'
                          }`}
                        />
                        {t.openFor} {formatElapsed(nowMs - new Date(trade.opened_at).getTime())}
                      </span>
                      <span className="font-mono-tech text-[10px] text-slate-500">
                        {new Date(trade.opened_at).toLocaleString()}
                      </span>
                    </div>
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
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono-tech text-xs text-slate-400">
              {filteredHistory.length} RECORDS
            </span>
            <NeonButton
              variant={csvDone ? 'emerald' : 'cyan'}
              disabled={filteredHistory.length === 0}
              onClick={handleDownloadCsv}
              className="min-h-[34px] px-3 py-1 text-[11px]"
            >
              {csvDone ? <Check className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
              {csvDone ? t.csvExported : `📥 Export CSV`}
            </NeonButton>
          </div>
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
                  <th className="py-2.5 pr-3">MODE</th>
                  <th className="py-2.5 pr-3">STATUS</th>
                  <th className="py-2.5 pr-3 text-right">{t.entryPrice}</th>
                  <th className="py-2.5 pr-3 text-right">{t.currentPrice}</th>
                  <th className="py-2.5 pr-3 text-right">{t.invested}</th>
                  <th className="py-2.5 pr-3 text-right">{t.pnlLabel}</th>
                  <th className="py-2.5 pr-3 text-right">TIME</th>
                  <th className="py-2.5 text-right">CARD</th>
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
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            (tr.mode ?? 'LIVE') === 'LIVE'
                              ? 'bg-rose-500/15 text-rose-300'
                              : 'bg-cyan-500/15 text-cyan-300'
                          }`}
                        >
                          {tr.mode ?? 'LIVE'}
                        </span>
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
                      <td className="py-2.5 pr-3 text-right text-slate-400">
                        {new Date(tr.opened_at).toLocaleDateString()}
                      </td>
                      <td className="py-2.5 text-right">
                        {tr.status === 'CLOSED' && tr.profit_usdt > 0 ? (
                          <button
                            type="button"
                            onClick={() => {
                              audioSynth.playClick();
                              setShareTrade(tr);
                            }}
                            className="inline-flex min-h-[28px] cursor-pointer items-center gap-1 rounded border border-amber-500/45 bg-amber-500/12 px-2 py-0.5 font-mono-tech text-[10px] font-bold text-amber-200 transition-colors hover:bg-amber-500/22"
                          >
                            <Share2 className="h-3 w-3" />
                            {t.pnlCardBtn}
                          </button>
                        ) : (
                          <span className="text-slate-700">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </TerminalPanel>

      {/* Shareable AEGIS QUANT PnL card (same design the worker sends to Telegram) */}
      {shareTrade && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t.cardAria}
          onClick={() => setShareTrade(null)}
        >
          <motion.div
            initial={reducedMotion ? false : { opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={(event) => event.stopPropagation()}
            className="relative w-full max-w-md overflow-hidden rounded-2xl border-2 border-amber-400/60 bg-[#05080d] p-6 shadow-[0_0_60px_rgba(16,185,129,0.25)]"
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_85%_10%,rgba(16,185,129,0.28),transparent_60%)]" />
            <button
              type="button"
              onClick={() => setShareTrade(null)}
              aria-label={t.cardCloseAria}
              className="absolute top-3 right-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-slate-700 bg-slate-900/70 text-slate-400 hover:text-slate-100"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="relative">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-display text-lg font-black tracking-wider text-amber-300">
                    AEGIS QUANT
                  </p>
                  <p className="font-mono-tech text-[10px] tracking-[0.2em] text-slate-400">
                    {t.cardMarketPro}
                  </p>
                </div>
                <span
                  className={`rounded-full border px-2.5 py-1 font-mono-tech text-[10px] font-bold ${
                    (shareTrade.mode ?? 'LIVE') === 'LIVE'
                      ? 'border-rose-400/50 bg-rose-500/12 text-rose-200'
                      : 'border-cyan-400/50 bg-cyan-500/12 text-cyan-200'
                  }`}
                >
                  {(shareTrade.mode ?? 'LIVE') === 'LIVE' ? t.cardLiveSpot : t.cardDemoEngine}
                </span>
              </div>

              <p className="mt-5 font-display text-4xl font-black tracking-wide text-slate-50">
                {shareTrade.pair}
              </p>
              <p className="font-mono-tech text-xs tracking-widest text-emerald-400">
                {t.cardLongSpot}
              </p>

              <p className="mt-5 font-mono-tech text-[10px] tracking-widest text-slate-500">
                {t.cardRoi}
              </p>
              <p className="font-display text-6xl font-black text-emerald-400">
                +{shareTrade.profit_pct.toFixed(2)}%
              </p>

              <p className="mt-3 font-mono-tech text-[10px] tracking-widest text-slate-500">
                {t.cardNetProfit}
              </p>
              <p className="font-display text-3xl font-black text-emerald-200">
                +${shareTrade.profit_usdt.toFixed(2)} USD
              </p>

              <div className="mt-5 grid grid-cols-2 gap-3 font-mono-tech">
                <div className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-3">
                  <p className="text-[10px] tracking-widest text-slate-500">{t.cardEntry}</p>
                  <p className="text-base font-bold text-slate-200">${shareTrade.entry_price}</p>
                </div>
                <div className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-3">
                  <p className="text-[10px] tracking-widest text-slate-500">{t.cardExit}</p>
                  <p className="text-base font-bold text-slate-200">
                    ${shareTrade.exit_price ?? shareTrade.current_price}
                  </p>
                </div>
              </div>

              <p className="mt-4 font-mono-tech text-[10px] text-slate-500">
                {t.cardClosed}{' '}
                {new Date(shareTrade.closed_at ?? shareTrade.opened_at)
                  .toISOString()
                  .replace('T', ' ')
                  .slice(0, 16)}{' '}
                UTC · auto-trade-qxp7.onrender.com
              </p>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};
