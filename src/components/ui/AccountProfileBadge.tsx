import React from 'react';
import { avatarInitials } from '../../lib/avatar';

interface AccountProfileBadgeProps {
  name: string;
  avatarUrl: string | null;
  subtitle: string;
}

/**
 * Signed-in account pill for the top header: circular profile photo (or initials),
 * full name and the 24/7 cloud indicator.
 */
export const AccountProfileBadge: React.FC<AccountProfileBadgeProps> = ({
  name,
  avatarUrl,
  subtitle,
}) => {
  const displayName = String(name || 'Trader').trim() || 'Trader';
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 rounded-full border border-white/10 py-1 pr-2 pl-1 glass-surface"
      title={`${displayName} · ${subtitle}`}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={displayName}
          referrerPolicy="no-referrer"
          className="h-[26px] w-[26px] shrink-0 rounded-full object-cover ring-1 ring-emerald-400/45"
        />
      ) : (
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-300 to-teal-600 font-display text-[11px] font-black text-[#04120c] ring-1 ring-emerald-400/40">
          {avatarInitials(displayName)}
        </span>
      )}

      <span className="hidden max-w-[86px] min-w-0 flex-col leading-none sm:flex">
        <span className="truncate font-mono-tech text-[11px] font-bold text-slate-100">
          {displayName}
        </span>
        <span className="mt-0.5 truncate font-mono-tech text-[8px] tracking-wider text-slate-500 uppercase">
          {subtitle}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-[3px]">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-70" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
        </span>
        <span className="font-mono-tech text-[8px] font-bold tracking-wide whitespace-nowrap text-emerald-300 uppercase">
          24/7<span className="hidden sm:inline"> Cloud Active</span>
        </span>
      </span>
    </div>
  );
};

export default AccountProfileBadge;
