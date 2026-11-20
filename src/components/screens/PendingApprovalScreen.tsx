import React, { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2, Clock3, LogOut, RefreshCw, ShieldX, Send } from 'lucide-react';
import { AccountProfile } from '../../types/trading';
import { NeonButton } from '../ui/MotionPrimitives';

interface PendingApprovalScreenProps {
  account: AccountProfile;
  onRefresh: () => Promise<void> | void;
  onSignOut: () => void;
}

/**
 * Gate shown after registration while the admin has not decided yet (or after a
 * rejection). It keeps the workspace locked: nothing is provisioned or fetched
 * until `approval_status === 'approved'`.
 */
export const PendingApprovalScreen: React.FC<PendingApprovalScreenProps> = ({
  account,
  onRefresh,
  onSignOut,
}) => {
  const reducedMotion = useReducedMotion();
  const [checking, setChecking] = useState(false);
  const rejected = account.approval_status === 'rejected';

  const handleCheck = async () => {
    setChecking(true);
    try {
      await onRefresh();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="relative flex min-h-[calc(100vh-120px)] items-center justify-center px-4 py-10">
      <motion.div
        initial={reducedMotion ? false : { opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className={`relative w-full max-w-md rounded-2xl border bg-[#090d16]/95 p-6 shadow-[0_0_50px_-15px_rgba(0,0,0,0.6)] sm:p-8 ${
          rejected ? 'border-rose-500/45' : 'border-amber-400/40'
        }`}
      >
        <span
          className={`pointer-events-none absolute top-0 left-0 h-3 w-3 rounded-tl-2xl border-t-2 border-l-2 ${
            rejected ? 'border-rose-400' : 'border-amber-400'
          }`}
        />
        <span
          className={`pointer-events-none absolute bottom-0 right-0 h-3 w-3 rounded-br-2xl border-b-2 border-r-2 ${
            rejected ? 'border-rose-400' : 'border-amber-400'
          }`}
        />

        <div className="flex items-start gap-3">
          <span
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${
              rejected
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                : 'border-amber-400/40 bg-amber-500/10 text-amber-300'
            }`}
          >
            {rejected ? <ShieldX className="h-5 w-5" /> : <Clock3 className="h-5 w-5 animate-pulse" />}
          </span>
          <div>
            <div className="font-mono-tech text-[10px] tracking-widest text-slate-400 uppercase">
              AEGIS QUANT // ACCESS CONTROL
            </div>
            <h1 className="mt-1 font-display text-xl font-bold tracking-wide text-slate-100 uppercase">
              {rejected ? 'Account Not Approved' : 'Account Pending Admin Approval'}
            </h1>
          </div>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-slate-300">
          {rejected
            ? 'The administrator declined this registration. If you believe this is a mistake, contact the admin with your email below and register again once cleared.'
            : 'Your registration was submitted successfully. The administrator has been notified on Telegram and will approve it shortly — this page unlocks automatically once approved.'}
        </p>

        <div className="mt-5 space-y-2 rounded-xl border border-slate-800 bg-[#05070d] p-3 font-mono-tech text-[11px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500 uppercase">Full name</span>
            <span className="truncate text-slate-100">{account.full_name || '—'}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500 uppercase">Email</span>
            <span className="truncate text-slate-100">{account.email}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500 uppercase">Telegram chat</span>
            <span className="truncate text-amber-200">{account.telegram_chat_id || 'not linked'}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500 uppercase">Status</span>
            <span
              className={`rounded border px-1.5 py-0.5 font-bold uppercase ${
                rejected
                  ? 'border-rose-500/50 bg-rose-500/10 text-rose-300'
                  : 'border-amber-400/50 bg-amber-500/10 text-amber-300'
              }`}
            >
              {account.approval_status}
            </span>
          </div>
        </div>

        {!account.telegram_chat_id && !rejected && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            <Send className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              No Telegram chat linked, so alerts cannot be delivered. Open @TaseenMarketBot, send
              /start, then add the chat id it returns in Settings once approved.
            </span>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-2">
          <NeonButton
            type="button"
            variant="amber"
            disabled={checking}
            onClick={() => void handleCheck()}
            className="w-full"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
            {checking ? 'CHECKING STATUS...' : 'CHECK APPROVAL STATUS'}
          </NeonButton>
          <NeonButton type="button" variant="ghost" onClick={onSignOut} className="w-full">
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </NeonButton>
        </div>

        <p className="mt-4 flex items-center justify-center gap-1.5 font-mono-tech text-[10px] text-slate-500">
          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          Session stays active — approval is detected on refresh.
        </p>
      </motion.div>
    </div>
  );
};

export default PendingApprovalScreen;
