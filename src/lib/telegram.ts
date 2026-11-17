import { TelegramConfig } from '../types/trading';

export async function dispatchTelegramAlert(
  config: TelegramConfig,
  text: string
): Promise<{ ok: boolean; detail: string }> {
  const token = config.bot_token.trim();
  const chatId = config.chat_id.trim();

  if (!token || !chatId) {
    return { ok: false, detail: 'Missing Telegram Bot Token or Chat ID' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        detail: data.description || `HTTP ${res.status}`,
      };
    }
    return { ok: true, detail: 'Dispatched to Telegram' };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : 'Network error sending Telegram alert',
    };
  }
}
