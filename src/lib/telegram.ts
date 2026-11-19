import { TelegramConfig } from '../types/trading';

export interface TelegramDispatchResult {
  ok: boolean;
  detail: string;
  endpoint?: string;
  errorCode?: number | null;
  messageId?: number | null;
}

export async function dispatchTelegramAlert(
  config: TelegramConfig,
  text: string
): Promise<TelegramDispatchResult> {
  const token = config.bot_token.trim().replace(/^["']|["']$/g, '').replace(/^bot/i, '').trim();
  const chatId = config.chat_id.trim().replace(/^["']|["']$/g, '');
  const maskedToken =
    token.length > 10 ? `${token.slice(0, 6)}...${token.slice(-4)}` : '(empty/invalid)';

  if (!token || !chatId) {
    const detail = !token
      ? 'Missing Telegram Bot Token'
      : 'Missing Telegram Chat ID';
    console.error('[Telegram] Dispatch aborted — incomplete configuration:', {
      hasToken: Boolean(token),
      hasChatId: Boolean(chatId),
    });
    return { ok: false, detail };
  }

  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    console.warn('[Telegram] Bot token format looks unusual (expected <bot_id>:<secret>):', {
      maskedToken,
      length: token.length,
    });
  }

  const proxyEndpoint = '/api/telegram/send';
  console.info('[Telegram] Sending payload via proxy:', {
    endpoint: proxyEndpoint,
    maskedToken,
    chatId,
    textLength: text.length,
  });

  // Prefer server-side proxy so browser ISP/CORS/network blocks never break Telegram alerts
  try {
    const proxyRes = await fetch(proxyEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botToken: token,
        chatId,
        text,
      }),
    });

    const contentType = proxyRes.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const proxyData = (await proxyRes.json()) as {
        ok?: boolean;
        detail?: string;
        errorCode?: number | null;
        messageId?: number | null;
        endpoint?: string;
      };
      if (proxyData.ok) {
        console.info('[Telegram] Proxy delivery succeeded:', {
          endpoint: proxyData.endpoint ?? proxyEndpoint,
          chatId,
          messageId: proxyData.messageId ?? null,
        });
        return {
          ok: true,
          detail: proxyData.detail || 'Dispatched to Telegram ✓',
          endpoint: proxyData.endpoint ?? proxyEndpoint,
          messageId: proxyData.messageId ?? null,
        };
      }
      if (proxyRes.status !== 404) {
        console.error('[Telegram] Proxy returned API error:', {
          status: proxyRes.status,
          errorCode: proxyData.errorCode ?? null,
          detail: proxyData.detail,
          endpoint: proxyData.endpoint ?? proxyEndpoint,
          chatId,
        });
        return {
          ok: false,
          detail: proxyData.detail || `Telegram error (HTTP ${proxyRes.status})`,
          errorCode: proxyData.errorCode ?? null,
          endpoint: proxyData.endpoint ?? proxyEndpoint,
        };
      }
      console.warn('[Telegram] Proxy returned 404 — falling back to direct Telegram Bot API');
    } else {
      console.warn('[Telegram] Proxy returned non-JSON response:', {
        status: proxyRes.status,
        contentType,
      });
    }
  } catch (proxyErr) {
    console.warn('[Telegram] Proxy request failed, falling back to direct Telegram API:', proxyErr);
  }

  const directEndpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  const maskedDirectEndpoint = `https://api.telegram.org/bot${maskedToken}/sendMessage`;
  try {
    const res = await fetch(directEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const data = (await res.json()) as {
      ok?: boolean;
      error_code?: number;
      description?: string;
      result?: { message_id?: number };
    };
    if (!res.ok || !data.ok) {
      console.error('[Telegram] Direct API returned error:', {
        endpoint: maskedDirectEndpoint,
        status: res.status,
        errorCode: data.error_code ?? null,
        description: data.description,
        chatId,
      });
      return {
        ok: false,
        detail: data.description || `HTTP ${res.status}`,
        errorCode: data.error_code ?? null,
        endpoint: maskedDirectEndpoint,
      };
    }
    console.info('[Telegram] Direct API delivery succeeded:', {
      endpoint: maskedDirectEndpoint,
      chatId,
      messageId: data.result?.message_id ?? null,
    });
    return {
      ok: true,
      detail: 'Dispatched to Telegram ✓',
      endpoint: maskedDirectEndpoint,
      messageId: data.result?.message_id ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error sending Telegram alert';
    console.error('[Telegram] Direct API network failure:', {
      endpoint: maskedDirectEndpoint,
      chatId,
      error: msg,
    });
    return {
      ok: false,
      detail: msg,
      endpoint: maskedDirectEndpoint,
    };
  }
}
