import { getTelegramUser, getTelegramWebApp } from './telegramWebApp';

/**
 * The identity that owns a trading workspace.
 *
 * Inside Telegram we trust `initDataUnsafe.user` for display and use the Telegram
 * id as the Supabase workspace key. A normal browser tab has no Telegram session,
 * so it falls back to a single stable `guest:owner` workspace instead of creating
 * a throwaway account on every device.
 */
export interface WorkspaceIdentity {
  /** Supabase `settings.telegram_user_id` value. */
  telegramUserId: string;
  telegramId: number | null;
  displayName: string;
  username: string | null;
  /** Private chat id used by the worker for alerts (the user id in DM). */
  chatId: string | null;
  /** Raw signed payload; the worker verifies it before trusting the id. */
  initData: string;
  isTelegram: boolean;
}

export const GUEST_WORKSPACE_ID = 'guest:owner';

export function resolveWorkspaceIdentity(): WorkspaceIdentity {
  const user = getTelegramUser();
  const initData = (() => {
    try {
      return String(getTelegramWebApp()?.initData || '');
    } catch {
      return '';
    }
  })();

  const id = Number(user?.id);
  if (Number.isFinite(id) && id > 0) {
    const name =
      [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() ||
      (user?.username ? `@${user.username}` : `Trader ${id}`);
    return {
      telegramUserId: String(id),
      telegramId: id,
      displayName: name,
      username: user?.username ?? null,
      chatId: String(id),
      initData,
      isTelegram: true,
    };
  }

  return {
    telegramUserId: GUEST_WORKSPACE_ID,
    telegramId: null,
    displayName: 'Web Guest',
    username: null,
    chatId: null,
    initData,
    isTelegram: false,
  };
}
