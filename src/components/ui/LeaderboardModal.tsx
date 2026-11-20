import React from 'react';
import { Crown, RefreshCw, Trophy, X } from 'lucide-react';
import { BDT_PER_USD } from '../../data/demoData';
import { LeaderboardEntry } from '../../types/trading';
import { NeonButton } from './MotionPrimitives';

interface LeaderboardModalProps {
  open: boolean;
  onClose: () => void;
  entries: LeaderboardEntry[];
  loading: boolean;
  currentUserId: string;
  onRefresh: () => void;
}

const MEDALS = ['🥇', '🥈', '🥉'];

function signedUsd(value: number): string {
  return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;
}

/**
 * Live community P&L board. It renders the worker's aggregated payload only —
 * names, mode, win rate and net PnL — never balances or API keys.
 */
export const LeaderboardModal: React.FC<LeaderboardModalProps> = ({
  open,
  onClose,
  entries,
  loading,
  currentUserId,
  onRefresh,
}) => {
  if (!open) return null;

  const totalProfit = entries.reduce((sum, entry) => sum + entry.pnl_usd, 0);
  const mine = entries.findIndex((entry) => entry.telegram_user_id === currentUserId);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/85 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Community leaderboard"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-amber-400/40 bg-[#080a0f] shadow-[0_-10px_60px_rgba(245,158,11,0.18)] sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-amber-500/20 bg-gradient-to-r from-amber-500/12 via-transparent to-emerald-500/12 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-400/40 bg-amber-500/10">
              <Trophy className="h-4.5 w-4.5 text-amber-300" />
            </span>
            <div>
              <h3 className="font-display text-sm font-bold tracking-widest text-amber-200 uppercase">
                Community Leaderboard
              </h3>
              <p className="font-mono-tech text-[10px] text-slate-400">
                Net realized P&L · all traders on @TaseenMarketBot
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Refresh leaderboard"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-slate-700 text-slate-300 hover:border-amber-400/60 hover:text-amber-300"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close leaderboard"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-slate-700 text-slate-300 hover:border-rose-400/60 hover:text-rose-300"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 border-b border-slate-800/80 px-4 py-2.5 font-mono-tech text-[10px]">
          <div>
            <div className="text-slate-500 uppercase">Traders</div>
            <div className="text-sm font-bold text-slate-100">{entries.length}</div>
          </div>
          <div>
            <div className="text-slate-500 uppercase">Community P&L</div>
            <div
              className={`text-sm font-bold ${
                totalProfit >= 0 ? 'text-emerald-300' : 'text-rose-300'
              }`}
            >
              {signedUsd(totalProfit)}
            </div>
          </div>
          <div>
            <div className="text-slate-500 uppercase">Your Rank</div>
            <div className="text-sm font-bold text-amber-300">
              {mine >= 0 ? `#${mine + 1}` : '—'}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {entries.length === 0 ? (
            <div className="px-4 py-10 text-center font-mono-tech text-[11px] text-slate-400">
              No closed trades yet. Start the engine and the first settled trade puts you on the
              board.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {entries.map((entry, index) => {
                const isYou = entry.telegram_user_id === currentUserId;
                const positive = entry.pnl_usd >= 0;
                return (
                  <li
                    key={entry.telegram_user_id}
                    className={`flex items-center gap-3 rounded-xl border px-2.5 py-2 ${
                      isYou
                        ? 'border-amber-400/55 bg-amber-500/10'
                        : 'border-slate-800/80 bg-[#05070d]'
                    }`}
                  >
                    <span className="w-6 shrink-0 text-center font-mono-tech text-[12px] font-bold text-slate-300">
                      {MEDALS[index] ?? index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-mono-tech text-[12px] font-bold text-slate-100">
                          {entry.name}
                        </span>
                        {index === 0 && positive && (
                          <Crown className="h-3 w-3 shrink-0 text-amber-300" />
                        )}
                        {isYou && (
                          <span className="shrink-0 rounded bg-amber-500/20 px-1 font-mono-tech text-[8px] font-bold tracking-wider text-amber-200 uppercase">
                            you
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono-tech text-[9px] text-slate-400">
                        <span
                          className={`rounded border px-1 font-bold ${
                            entry.mode === 'LIVE'
                              ? 'border-rose-500/50 text-rose-300'
                              : 'border-cyan-500/40 text-cyan-300'
                          }`}
                        >
                          {entry.mode}
                        </span>
                        <span>{entry.win_rate.toFixed(1)}% win</span>
                        <span>·</span>
                        <span>{entry.trades} trades</span>
                        {entry.running && (
                          <span className="flex items-center gap-1 text-emerald-300">
                            <span className="h-1 w-1 animate-pulse rounded-full bg-emerald-400" />
                            live
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right font-mono-tech">
                      <div
                        className={`text-[12px] font-bold ${
                          positive ? 'text-emerald-300' : 'text-rose-300'
                        }`}
                      >
                        {signedUsd(entry.pnl_usd)}
                      </div>
                      <div className="text-[9px] text-slate-500">
                        ৳{Math.abs(entry.pnl_bdt).toLocaleString('en-US')}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-slate-800/80 bg-[#05070d] px-4 py-2.5">
          <p className="font-mono-tech text-[9px] leading-relaxed text-slate-500">
            Only aggregated P&L is shared (USD · ৳{BDT_PER_USD}/USD). API keys, balances and
            individual trades stay private to each trader's workspace.
          </p>
          <div className="mt-2 flex justify-end">
            <NeonButton type="button" variant="amber" onClick={onClose} className="min-h-[32px] px-3 text-[11px]">
              Close
            </NeonButton>
          </div>
        </div>
      </div>
    </div>
  );
};
