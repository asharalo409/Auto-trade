import React, { useMemo, useState } from 'react';
import {
  Activity,
  BadgeCheck,
  Check,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Trophy,
  Users,
  X,
} from 'lucide-react';
import { BDT_PER_USD } from '../../data/demoData';
import { AdminUserRow, ApprovalStatus } from '../../types/trading';
import { NeonButton } from '../ui/MotionPrimitives';
import { TerminalPanel } from '../ui/TerminalPanel';

interface AdminPanelProps {
  users: AdminUserRow[];
  totals: {
    users: number;
    pending: number;
    approved: number;
    rejected: number;
    pnl_usd: number;
    pnl_bdt: number;
  } | null;
  loading: boolean;
  error: string | null;
  currentAdminId: string;
  onRefresh: () => void;
  onReview: (
    userId: string,
    decision: 'approve' | 'reject'
  ) => Promise<{ ok: boolean; detail: string }>;
}

const FILTERS: { id: ApprovalStatus | 'all'; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'all', label: 'All' },
];

const statusChip = (status: ApprovalStatus): string =>
  status === 'approved'
    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
    : status === 'rejected'
      ? 'border-rose-500/50 bg-rose-500/10 text-rose-300'
      : 'border-amber-400/50 bg-amber-500/10 text-amber-300';

/**
 * 🛡️ Admin Panel — approve/reject registrations and watch every trader's PnL.
 * Reads the worker API, which verifies this session owns an `is_admin` account.
 */
export const AdminPanel: React.FC<AdminPanelProps> = ({
  users,
  totals,
  loading,
  error,
  currentAdminId,
  onRefresh,
  onReview,
}) => {
  const [filter, setFilter] = useState<ApprovalStatus | 'all'>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const visible = useMemo(
    () => (filter === 'all' ? users : users.filter((user) => user.approval_status === filter)),
    [filter, users]
  );

  const pendingCount = users.filter((user) => user.approval_status === 'pending').length;

  const handleReview = async (user: AdminUserRow, decision: 'approve' | 'reject') => {
    setBusyId(user.id);
    setFeedback(null);
    const result = await onReview(user.id, decision);
    setBusyId(null);
    setFeedback({ ok: result.ok, text: result.detail });
  };

  return (
    <div className="space-y-4">
      <TerminalPanel
        accent="amber"
        title="🛡️ ADMIN CONTROL CENTER"
        subtitle="Registration approval · user roster · aggregate P&L"
        rightSlot={
          <NeonButton
            type="button"
            variant="amber"
            onClick={onRefresh}
            disabled={loading}
            className="min-h-[34px] px-3 py-1 text-[11px]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'SYNCING...' : 'REFRESH'}
          </NeonButton>
        }
      >
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {[
            { label: 'Traders', value: String(totals?.users ?? users.length), icon: Users, tone: 'text-cyan-300' },
            {
              label: 'Pending',
              value: String(totals?.pending ?? pendingCount),
              icon: Activity,
              tone: 'text-amber-300',
            },
            {
              label: 'Approved',
              value: String(totals?.approved ?? 0),
              icon: BadgeCheck,
              tone: 'text-emerald-300',
            },
            {
              label: 'Community P&L',
              value: `${(totals?.pnl_usd ?? 0) >= 0 ? '+' : '-'}$${Math.abs(
                totals?.pnl_usd ?? 0
              ).toFixed(2)}`,
              icon: Trophy,
              tone: (totals?.pnl_usd ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300',
            },
          ].map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.label}
                className="rounded-xl border border-slate-800 bg-[#05070d] px-3 py-2.5"
              >
                <div className="flex items-center gap-1.5 font-mono-tech text-[9px] tracking-wider text-slate-500 uppercase">
                  <Icon className="h-3 w-3" />
                  {card.label}
                </div>
                <div className={`mt-1 font-display text-lg font-bold ${card.tone}`}>
                  {card.value}
                </div>
              </div>
            );
          })}
        </div>

        {totals && (
          <p className="mt-2 font-mono-tech text-[10px] text-slate-500">
            Community P&L in BDT: ৳{Math.abs(totals.pnl_bdt).toLocaleString('en-US')} · rate ৳
            {BDT_PER_USD}/USD
          </p>
        )}

        {error && (
          <div className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 font-mono-tech text-[11px] text-rose-200">
            {error} — redeploy the worker so /api/admin/users is available.
          </div>
        )}

        {feedback && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 font-mono-tech text-[11px] ${
              feedback.ok
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
            }`}
          >
            {feedback.text}
          </div>
        )}
      </TerminalPanel>

      <TerminalPanel accent="cyan" title="USER ROSTER" subtitle={`${users.length} registered account(s)`}>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {FILTERS.map((item) => {
            const count =
              item.id === 'all'
                ? users.length
                : users.filter((user) => user.approval_status === item.id).length;
            const active = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`min-h-[32px] cursor-pointer rounded-lg border px-2.5 font-mono-tech text-[10px] font-bold tracking-wider uppercase transition-colors ${
                  active
                    ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
                    : 'border-slate-800 text-slate-400 hover:border-slate-600 hover:text-slate-200'
                }`}
              >
                {item.label} · {count}
              </button>
            );
          })}
        </div>

        {visible.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-[#05070d] px-4 py-8 text-center font-mono-tech text-[11px] text-slate-500">
            {loading ? 'Loading registered accounts…' : 'No accounts in this view.'}
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((user) => {
              const isSelf = user.id === currentAdminId;
              const busy = busyId === user.id;
              return (
                <li
                  key={user.id}
                  className="rounded-xl border border-slate-800/90 bg-[#05070d] p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-mono-tech text-[12px] font-bold text-slate-100">
                          {user.full_name || user.email}
                        </span>
                        {user.is_admin && (
                          <span className="flex items-center gap-1 rounded border border-amber-400/50 bg-amber-500/10 px-1 font-mono-tech text-[8px] font-bold tracking-wider text-amber-200 uppercase">
                            <ShieldCheck className="h-2.5 w-2.5" /> admin
                          </span>
                        )}
                        {isSelf && (
                          <span className="rounded border border-slate-600 px-1 font-mono-tech text-[8px] tracking-wider text-slate-400 uppercase">
                            you
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono-tech text-[10px] text-slate-400">
                        {user.email}
                        {user.telegram_username ? ` · @${user.telegram_username}` : ''}
                        {user.telegram_chat_id ? ` · chat ${user.telegram_chat_id}` : ' · no chat id'}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono-tech text-[9px] font-bold tracking-wider uppercase ${statusChip(
                        user.approval_status
                      )}`}
                    >
                      {user.approval_status}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono-tech text-[10px] text-slate-400">
                    <span
                      className={
                        user.trading_mode === 'LIVE' ? 'text-rose-300' : 'text-cyan-300'
                      }
                    >
                      {user.trading_mode}
                    </span>
                    <span>{user.total_trades} trades</span>
                    <span>
                      {user.total_trades > 0
                        ? `${((user.win_trades / user.total_trades) * 100).toFixed(1)}% win`
                        : 'no closed trades'}
                    </span>
                    <span
                      className={
                        user.realized_pnl_usd >= 0 ? 'text-emerald-300' : 'text-rose-300'
                      }
                    >
                      {user.realized_pnl_usd >= 0 ? '+' : '-'}$
                      {Math.abs(user.realized_pnl_usd).toFixed(2)}
                    </span>
                    <span className={user.has_keys ? 'text-emerald-300' : 'text-amber-300'}>
                      {user.has_keys ? 'keys linked' : 'no keys'}
                    </span>
                    {user.bot_running && (
                      <span className="flex items-center gap-1 text-emerald-300">
                        <span className="h-1 w-1 animate-pulse rounded-full bg-emerald-400" />
                        engine live
                      </span>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <NeonButton
                      type="button"
                      variant="emerald"
                      disabled={busy || user.approval_status === 'approved'}
                      onClick={() => void handleReview(user, 'approve')}
                      className="min-h-[32px] px-2.5 text-[10px]"
                    >
                      <Check className="h-3 w-3" />
                      {busy ? '...' : 'Approve'}
                    </NeonButton>
                    <NeonButton
                      type="button"
                      variant="rose"
                      disabled={busy || user.approval_status === 'rejected' || isSelf}
                      onClick={() => void handleReview(user, 'reject')}
                      className="min-h-[32px] px-2.5 text-[10px]"
                    >
                      <X className="h-3 w-3" />
                      Reject
                    </NeonButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-3 flex items-start gap-1.5 font-mono-tech text-[9px] leading-relaxed text-slate-500">
          <ShieldX className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" />
          Approving from here also sends the applicant a Telegram welcome on @TaseenMarketBot. API
          keys and balances are never exposed in this roster.
        </p>
      </TerminalPanel>
    </div>
  );
};

export default AdminPanel;
