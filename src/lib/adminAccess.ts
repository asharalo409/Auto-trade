/**
 * Single-owner admin policy for Aegis Quant.
 *
 * The ADMIN badge, the ADMIN tab and every approve/reject call belong to exactly
 * one account: the deployment owner. A row can carry `is_admin = true` after a
 * stale promotion, but access is granted only when the email is the owner address.
 * The 24/7 worker enforces the same rule server-side, so the UI is never the only
 * guard.
 */
export const OWNER_ADMIN_EMAIL = 'taseenbillah409@gmail.com';

/** The owner's private Telegram chat: never a valid alert target for another trader. */
export const OWNER_ADMIN_CHAT_ID = '7741119923';

export function normalizeOwnerEmail(email?: string | null): string {
  return String(email ?? '').trim().toLowerCase();
}

export function isOwnerAdminEmail(email?: string | null): boolean {
  return normalizeOwnerEmail(email) === OWNER_ADMIN_EMAIL;
}

/** Admin access requires BOTH the Supabase flag and the owner email. */
export function hasOwnerAdminAccess(
  email?: string | null,
  isAdminFlag?: unknown
): boolean {
  return Boolean(isAdminFlag) && isOwnerAdminEmail(email);
}

export function isReservedAdminChatId(chatId?: string | null): boolean {
  return String(chatId ?? '').trim() === OWNER_ADMIN_CHAT_ID;
}
