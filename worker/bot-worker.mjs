/**
 * Aegis Quant Terminal — 24/7 Render Execution Worker
 * Connects Supabase (settings/trades/logs) + Binance Spot API + Telegram Alerts
 * Binds an optional HTTP healthcheck port when process.env.PORT is set (Render Web Service compatible).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import { renderPnlCard } from './pnl-card.mjs';

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const ENV_BINANCE_KEY = (process.env.BINANCE_API_KEY || '').trim();
const ENV_BINANCE_SECRET = (process.env.BINANCE_API_SECRET || '').trim();
const ENV_TESTNET = (process.env.BINANCE_TESTNET || '').trim() === 'true';

const BINANCE_ROUND_TRIP_FEE_PCT = 0.2; // 0.1% Buy + 0.1% Sell Spot taker fees
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
/** Bot owner's Telegram chat: receives registration approvals. */
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '').trim();
/** Optional: promote this email to admin/approved on boot. */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim();
/** The ONE owner account allowed to hold the admin seat (badge, tab, approvals). */
const OWNER_ADMIN_EMAIL = (process.env.OWNER_ADMIN_EMAIL || 'taseenbillah409@gmail.com')
  .trim()
  .toLowerCase();
/** The owner's private Telegram chat — never a valid alert recipient for anyone else. */
const OWNER_ADMIN_CHAT_ID = (process.env.OWNER_ADMIN_CHAT_ID || '7741119923').trim();
/**
 * Strict admin check: the Supabase flag alone is not enough. An account promoted
 * by a stale chat id (or an old bootstrap trigger) never becomes an admin.
 */
function isOwnerAdminAccount(account) {
  return (
    Boolean(account?.is_admin) &&
    String(account?.email || '').trim().toLowerCase() === OWNER_ADMIN_EMAIL
  );
}
/** Account/approval table (one row per Supabase Auth user). */
const USERS_TABLE = 'users';
/** Short-lived 6-digit Telegram password-reset codes (service-role only). */
const PASSWORD_RESET_TABLE = 'password_reset_otps';
const PASSWORD_RESET_TTL_MINUTES = 10;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const TELEGRAM_MINI_APP_URL = (
  process.env.TELEGRAM_MINI_APP_URL || 'https://auto-trade-qxp7.onrender.com'
).trim();
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
// Attached to every outgoing alert (BUY / SELL / TP / SL / status) so the
// operator can jump straight from chat into the Mini App terminal.
const TELEGRAM_OPEN_TERMINAL_MARKUP = {
  inline_keyboard: [[{ text: '📊 Open Terminal', web_app: { url: TELEGRAM_MINI_APP_URL } }]],
};
const TELEGRAM_STATUS_BUTTON = { text: '📈 Live Status', callback_data: 'refresh_status' };
/** Inline finance shortcuts attached to /help, /pnl and /leaderboard. */
const TELEGRAM_FINANCE_MARKUP = {
  inline_keyboard: [
    [
      { text: '📊 Open Terminal', web_app: { url: TELEGRAM_MINI_APP_URL } },
      { text: '💰 My PnL', callback_data: 'pnl' },
    ],
    [
      { text: '🏆 Leaderboard', callback_data: 'leaderboard' },
      TELEGRAM_STATUS_BUTTON,
    ],
  ],
};

function userScopeOf(settings) {
  return scopeOf(settings) || DEFAULT_OWNER_SCOPE;
}

/** Shared ranked text for `/leaderboard` and the `leaderboard` callback. */
function buildLeaderboardText(rows, ownScope) {
  if (!rows || rows.length === 0) {
    return [
      '🏆 <b>AEGIS COMMUNITY LEADERBOARD</b>',
      '',
      'No closed trades yet. Start the engine with /start_bot and the first settled trade puts you on the board.',
    ].join('\n');
  }
  const medals = ['🥇', '🥈', '🥉'];
  const lines = ['🏆 <b>AEGIS COMMUNITY LEADERBOARD</b>', '<i>Net realized PnL · all traders on @TaseenMarketBot</i>', ''];
  rows.slice(0, 10).forEach((row, index) => {
    const rank = medals[index] || `${index + 1}.`;
    const you = row.telegram_user_id === ownScope ? ' ← you' : '';
    const handle = row.username ? ` (@${row.username})` : '';
    const sign = row.pnl_usd >= 0 ? '+' : '-'
    lines.push(
      `${rank} <b>${row.name}</b>${handle}${you}`,
      `    ${row.mode} · ${row.win_rate.toFixed(1)}% win · ${row.trades} trades`,
      `    ${sign}$${Math.abs(row.pnl_usd).toFixed(2)} · ৳${Math.abs(row.pnl_bdt).toLocaleString('en-US')}`
    );
  });
  const mine = rows.findIndex((row) => row.telegram_user_id === ownScope);
  if (mine >= 10) {
    const row = rows[mine];
    lines.push('', `Your rank: #${mine + 1} · ${row.pnl_usd >= 0 ? '+' : '-'}$${Math.abs(row.pnl_usd).toFixed(2)}`);
  }
  return lines.join('\n');
}

/**
 * Two rows of inline actions on every trade alert: the Mini App entry point, plus
 * a one-tap close for THAT pair and an instant portfolio snapshot.
 */
function tradeAlertMarkup(symbol) {
  const secondRow = [];
  if (symbol) secondRow.push({ text: `🛑 Close ${symbol}`, callback_data: `close_symbol:${symbol}` });
  secondRow.push(TELEGRAM_STATUS_BUTTON);
  return {
    inline_keyboard: [
      [{ text: '📊 Open Terminal', web_app: { url: TELEGRAM_MINI_APP_URL } }],
      secondRow,
    ],
  };
}

/* ------------------------------------------------------------------------- *
 * Institutional risk intelligence constants
 * ------------------------------------------------------------------------- */

/** Flash-crash circuit breaker: a 5-minute drop at or beyond this % pauses a pair. */
const CRASH_GUARD_DROP_PCT = 4.0;
const CRASH_GUARD_WINDOW_MINUTES = 5;
const CRASH_GUARD_PAUSE_MINUTES = 15;
/** symbol -> { blockedUntil:number, dropPct:number, triggeredAt:number } */
const crashGuardState = new Map();
const IPV4_REGEX = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})\b/;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[WORKER ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* ------------------------------------------------------------------------- *
 * Multi-user workspace model
 * ------------------------------------------------------------------------- */

/** Fallback workspace used by the web terminal when it runs outside Telegram. */
const DEFAULT_OWNER_SCOPE = 'guest:owner';
/** Binance secrets live here and are readable ONLY with the service role key. */
const USER_KEYS_TABLE = 'user_api_keys';
const SCOPE_COLUMN = 'telegram_user_id';
const DEMO_START_BALANCE = 10_000;

/** `telegram_user_id` of a settings row (null for the legacy single-tenant row). */
function scopeOf(row) {
  const raw = String(row?.[SCOPE_COLUMN] ?? '').trim();
  return raw || null;
}

function userLabel(row) {
  const name = String(row?.full_name || '').trim();
  if (name) return name;
  const username = String(row?.telegram_username || '').trim();
  if (username) return `@${username.replace(/^@/, '')}`;
  return scopeOf(row) || 'Web Guest';
}

function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/** Only sane scope ids reach Supabase; everything else is rejected. */
function sanitiseScope(value) {
  const raw = String(value ?? '').trim();
  return /^[A-Za-z0-9:_@.\-]{1,64}$/.test(raw) ? raw : '';
}

/** Per-user Binance credentials, stored in the worker-only table. */
async function loadUserApiKeys(scope) {
  if (!scope) return null;
  const { data, error } = await supabase
    .from(USER_KEYS_TABLE)
    .select('*')
    .eq(SCOPE_COLUMN, scope)
    .maybeSingle();
  if (error) {
    if (!isMissingTableError(error)) console.warn('[USER KEYS] read failed:', error.message);
    return null;
  }
  if (!data) return null;
  return {
    apiKey: String(data.binance_api_key || '').trim(),
    apiSecret: String(data.binance_api_secret || '').trim(),
    useTestnet: Boolean(data.use_testnet),
    updatedAt: data.updated_at || null,
  };
}

/** Codes are stored hashed so the reset table never holds a usable OTP. */
function hashResetCode(email, code) {
  return crypto
    .createHash('sha256')
    .update(`${String(email || '').trim().toLowerCase()}:${String(code || '').trim()}`)
    .digest('hex');
}

function scopeForAccount(accountId) {
  return `u:${String(accountId || '').trim()}`;
}

function accountIdFromScope(scope) {
  const raw = String(scope || '');
  return raw.startsWith('u:') ? raw.slice(2) : null;
}

/** Validates a Supabase access token from a browser request. */
async function verifyAccessToken(req) {
  const header = String(req?.headers?.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

async function fetchAccountById(userId) {
  const id = String(userId || '').trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  const { data, error } = await supabase.from(USERS_TABLE).select('*').eq('id', id).maybeSingle();
  if (error) {
    if (!isMissingTableError(error)) console.warn('[USERS] account read failed:', error.message);
    return null;
  }
  return data || null;
}

async function fetchAccountByChat(chatId) {
  const clean = String(chatId || '').trim();
  if (!clean) return null;
  // A chat can own more than one row (old rejected applications next to a newly
  // approved registration), so list instead of maybeSingle and pick the row that
  // actually holds the approval — otherwise /start_bot and every command break.
  const { data, error } = await supabase
    .from(USERS_TABLE)
    .select('*')
    .eq('telegram_chat_id', clean)
    .order('created_at', { ascending: false });
  if (error) {
    if (!isMissingTableError(error)) console.warn('[USERS] chat lookup failed:', error.message);
    return null;
  }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows.find((row) => row?.approval_status === 'approved') || rows[0] || null;
}

let accountsTableAvailable = null;

/** Cached probe: does this project have the accounts/approval table yet? */
async function accountsEnabled() {
  if (accountsTableAvailable !== null) return accountsTableAvailable;
  const { error } = await supabase.from(USERS_TABLE).select('id').limit(1);
  if (error && isMissingTableError(error)) {
    accountsTableAvailable = false;
    return false;
  }
  // Transient failure: fail closed (assume approval is required) without caching.
  if (error) return true;
  accountsTableAvailable = true;
  return true;
}

const REGISTER_MARKUP = {
  inline_keyboard: [
    [{ text: '📝 Register / Login', web_app: { url: TELEGRAM_MINI_APP_URL } }],
  ],
};

/** Prompt for a chat that has not registered an approved account yet. */
function registrationPrompt(chatId) {
  return [
    '👋 <b>WELCOME TO AEGIS QUANT</b>',
    '',
    'This bot is the alert channel for a private multi-user trading platform.',
    'Create an account (email + password) in the Mini App, then wait for admin approval:',
    `<code>${TELEGRAM_MINI_APP_URL}</code>`,
    '',
    `Your Telegram chat id for the registration form:\n<code>${chatId}</code>`,
    '',
    'Once approved you can log in from any browser and this bot will send your private trade alerts.',
  ].join('\n');
}

async function fetchApprovedAccounts() {
  const { data, error } = await supabase
    .from(USERS_TABLE)
    .select('*')
    .eq('approval_status', 'approved');
  if (error) {
    if (!isMissingTableError(error)) console.warn('[USERS] approved list failed:', error.message);
    return null;
  }
  return data || [];
}

/** True only when the Telegram sender owns the single owner admin account. */
async function isAdminActor(from) {
  const chatId = String(from?.id ?? '').trim();
  if (!chatId) return false;
  const account = await fetchAccountByChat(chatId);
  return isOwnerAdminAccount(account);
}

async function resolveAdminChatId() {
  // Approvals go to the owner row only — a promoted impostor must not receive them.
  const { data } = await supabase
    .from(USERS_TABLE)
    .select('telegram_chat_id')
    .eq('is_admin', true)
    .ilike('email', OWNER_ADMIN_EMAIL)
    .not('telegram_chat_id', 'is', null)
    .limit(1)
    .maybeSingle();
  if (data?.telegram_chat_id) return String(data.telegram_chat_id).trim();
  if (ADMIN_CHAT_ID) return ADMIN_CHAT_ID;
  // Approvals only. Never fall back to the legacy global TELEGRAM_CHAT_ID here:
  // that is how a trader's private alerts used to end up in the admin's inbox.
  return '';
}

/**
 * Every approved account gets its own settings row (its trading workspace),
 * keyed `u:<auth uuid>` so both the worker and the web terminal use the same one.
 */
async function ensureWorkspaceForAccount(account) {
  if (!account?.id) return null;
  const scope = scopeForAccount(account.id);
  const existing = await fetchUserSettings(scope);
  if (existing) {
    // Keep the alert chat pointed at the account's current Telegram chat id.
    if (account.telegram_chat_id && String(existing.chat_id || '') !== String(account.telegram_chat_id)) {
      await supabase
        .from('settings')
        .update({ chat_id: String(account.telegram_chat_id) })
        .eq('id', existing.id);
      existing.chat_id = String(account.telegram_chat_id);
    }
    // Non-persisted handle: lets cfg carry the account's name/avatar for cards.
    existing.__account = account;
    return existing;
  }

  const live = String(account.trading_mode || 'VIRTUAL').toUpperCase() === 'LIVE';
  const running = Boolean(account.bot_running);
  // Independent switches, seeded from the account row when it already has them.
  const demoRunning = Boolean(account.demo_bot_running ?? (!live && running));
  const liveRunning = Boolean(account.live_bot_running ?? (live && running));
  const payload = {
    [SCOPE_COLUMN]: scope,
    telegram_username: account.telegram_username || null,
    full_name: account.full_name || account.email || null,
    chat_id: account.telegram_chat_id || null,
    bot_enabled: running,
    is_running: demoRunning || liveRunning,
    bot_running: demoRunning || liveRunning,
    demo_bot_running: demoRunning,
    live_bot_running: liveRunning,
    trading_mode: live ? 'live' : 'virtual',
    mode: live ? 'LIVE' : 'DEMO',
    virtual_balance: Number(account.virtual_balance ?? DEMO_START_BALANCE),
    telegram_enabled: true,
    enabled_pairs: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'],
    take_profit_pct: 2.4,
    zero_loss_mode: true,
    zero_loss_shield: true,
    sell_only_in_profit: true,
    dca_enabled: true,
    dca_step_pct: 1.5,
    dca_max_buys: 12,
    max_open_trades: 5,
    max_amount_per_pair: 500,
    daily_loss_limit: 150,
  };
  let { data, error } = await supabase.from('settings').insert(payload).select('*').maybeSingle();
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await supabase
      .from('settings')
      .insert({
        [SCOPE_COLUMN]: scope,
        chat_id: account.telegram_chat_id || null,
        bot_enabled: running,
      })
      .select('*')
      .maybeSingle());
  }
  if (error) {
    console.warn('[USERS] workspace provisioning failed:', error.message);
    return null;
  }
  console.log(`[USERS] Provisioned workspace ${scope} for ${account.email}.`);
  if (data) data.__account = account;
  return data || null;
}

/**
 * Approves/rejects an application, provisions the workspace and tells the
 * applicant privately. Used by both the Telegram buttons and the admin panel.
 */
async function applyApproval(userId, decision, actor = 'Admin') {
  const account = await fetchAccountById(userId);
  if (!account) return { ok: false, error: 'User not found' };
  const status = decision === 'reject' ? 'rejected' : 'approved';
  const { data: updated, error } = await supabase
    .from(USERS_TABLE)
    .update({ approval_status: status })
    .eq('id', account.id)
    .select('*')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  const user = updated || { ...account, approval_status: status };

  if (status === 'approved') await ensureWorkspaceForAccount(user);

  if (user.telegram_chat_id) {
    const text =
      status === 'approved'
        ? [
            '✅ <b>ACCOUNT APPROVED</b>',
            '',
            `Welcome, <b>${user.full_name || user.email || 'Trader'}</b>!`,
            'Your Aegis Quant account is live. Log in with your email and password:',
            `<code>${user.email || ''}</code>`,
            '',
            'Then set your Binance Spot API keys in Settings → Exchange Connection, and start the engine.',
          ].join('\n')
        : [
            '❌ <b>ACCOUNT NOT APPROVED</b>',
            '',
            'Your Aegis Quant registration was rejected by the administrator.',
            'Reply to the admin or register again with a different email.',
          ].join('\n');
    await sendTelegram(text, TELEGRAM_BOT_TOKEN, user.telegram_chat_id, {
      replyMarkup: {
        inline_keyboard: [[{ text: '📊 Open Terminal', web_app: { url: TELEGRAM_MINI_APP_URL } }]],
      },
    });
  }

  await appendLog(
    'INFO',
    `[ADMIN] ${actor} ${status} ${user.email || user.id}.`
  );
  return { ok: true, status, user };
}

/** Instant admin notification with one-tap approve/reject buttons. */
async function notifyAdminOfPendingAccounts() {
  if (!TELEGRAM_BOT_TOKEN) return 0;
  const { data: pending, error } = await supabase
    .from(USERS_TABLE)
    .select('*')
    .eq('approval_status', 'pending')
    .is('admin_notified_at', null)
    .order('created_at', { ascending: true })
    .limit(10);
  if (error) {
    if (!isMissingTableError(error)) console.warn('[ADMIN] pending read failed:', error.message);
    return 0;
  }
  if (!pending || pending.length === 0) return 0;
  // First registration may be the owner: promote before looking for an admin chat.
  await promoteConfiguredAdmin();
  const adminChat = await resolveAdminChatId();
  if (!adminChat) return 0;
  let sent = 0;
  for (const user of pending || []) {
    const text = [
      '🆕 <b>NEW REGISTRATION REQUEST</b>',
      '',
      `👤 Name: <b>${user.full_name || '—'}</b>`,
      `📧 Email: <code>${user.email || '—'}</code>`,
      `💬 Telegram: ${user.telegram_username ? `@${user.telegram_username}` : '—'} (${user.telegram_chat_id || 'no chat id'})`,
      `🆔 User: <code>${user.id}</code>`,
      '',
      'Approve to grant access to the terminal and the 24/7 engine.',
    ].join('\n');
    const approvalMarkup = {
      inline_keyboard: [
        [{ text: '✅ Approve User', callback_data: `approve_user:${user.id}` }],
        [{ text: '❌ Reject User', callback_data: `reject_user:${user.id}` }],
      ],
    };
    // Show the applicant's face when they uploaded one.
    const avatarBuffer = await fetchAvatarBuffer(user.avatar_url);
    const ok = avatarBuffer
      ? await sendTelegramPhoto(
          avatarBuffer,
          text,
          TELEGRAM_BOT_TOKEN,
          adminChat,
          approvalMarkup,
          imageMime(avatarBuffer)
        )
      : await sendTelegram(text, TELEGRAM_BOT_TOKEN, adminChat, {
          replyMarkup: approvalMarkup,
        });
    if (ok) {
      sent += 1;
      await supabase
        .from(USERS_TABLE)
        .update({ admin_notified_at: new Date().toISOString() })
        .eq('id', user.id);
    }
  }
  return sent;
}

/**
 * Enforces the single-owner policy on boot: only OWNER_ADMIN_EMAIL keeps the admin
 * seat, every other row is demoted. Promotion by chat id is gone — copying the
 * owner's Telegram chat id into another account must never grant privileges.
 */
async function promoteConfiguredAdmin() {
  const { data: admins, error: listError } = await supabase
    .from(USERS_TABLE)
    .select('id,email,is_admin')
    .eq('is_admin', true);
  if (listError) {
    if (!isMissingTableError(listError)) {
      console.warn('[ADMIN] admin list failed:', listError.message);
    }
    return;
  }
  for (const row of admins || []) {
    if (String(row.email || '').trim().toLowerCase() === OWNER_ADMIN_EMAIL) continue;
    const { error } = await supabase
      .from(USERS_TABLE)
      .update({ is_admin: false })
      .eq('id', row.id);
    if (error && !isMissingTableError(error)) {
      console.warn('[ADMIN] demote failed:', error.message);
    } else {
      await appendLog(
        'WARNING',
        `[ADMIN] Revoked the admin seat from non-owner account ${row.email || row.id}.`
      );
    }
  }
  const ownerEmail = OWNER_ADMIN_EMAIL;
  if (!ownerEmail) return;
  const { error } = await supabase
    .from(USERS_TABLE)
    .update({ is_admin: true, approval_status: 'approved', admin_notified_at: new Date().toISOString() })
    .ilike('email', ownerEmail);
  if (error && !isMissingTableError(error)) {
    console.warn('[ADMIN] owner promotion failed:', error.message);
  }
}

async function saveUserApiKeys(scope, apiKey, apiSecret, useTestnet) {
  if (!scope) return { ok: false, error: 'Missing workspace id' };
  const { error } = await supabase.from(USER_KEYS_TABLE).upsert(
    {
      [SCOPE_COLUMN]: scope,
      binance_api_key: apiKey,
      binance_api_secret: apiSecret,
      use_testnet: Boolean(useTestnet),
      updated_at: new Date().toISOString(),
    },
    { onConflict: SCOPE_COLUMN }
  );
  if (error) return { ok: false, error: error.message };
  // Mirror only a MASK onto the account row (admin roster shows "linked").
  const accountId = accountIdFromScope(scope);
  if (accountId) {
    await supabase
      .from(USERS_TABLE)
      .update({ binance_api_key: maskSecret(apiKey) })
      .eq('id', accountId);
  }
  return { ok: true };
}

/**
 * Validates Telegram Mini App `initData` with the bot token so a browser can
 * only claim a Telegram identity it actually owns. Returns the Telegram user id
 * on success, or null when the payload is absent/invalid/stale.
 */
function verifyTelegramInitData(initData) {
  const token = TELEGRAM_BOT_TOKEN;
  const raw = String(initData || '').trim();
  if (!token || !raw) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const expected = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');
    if (
      expected.length !== hash.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))
    ) {
      return null;
    }
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Date.now() / 1000 - authDate > 86_400) return null;
    const user = JSON.parse(params.get('user') || 'null');
    const id = Number(user?.id);
    return Number.isFinite(id) && id > 0
      ? { id: String(id), username: user?.username || null, name: [user?.first_name, user?.last_name].filter(Boolean).join(' ') }
      : null;
  } catch {
    return null;
  }
}

/** Verified Supabase session > verified Telegram initData > claimed workspace id. */
function resolveRequestScope(payload, authUser = null) {
  if (authUser?.id) {
    return { scope: scopeForAccount(authUser.id), verified: null, error: null, accountScoped: true };
  }
  const verified = verifyTelegramInitData(payload?.initData);
  if (verified) return { scope: verified.id, verified, error: null };
  const claimed = sanitiseScope(payload?.telegram_user_id ?? payload?.telegramUserId);
  return { scope: claimed || DEFAULT_OWNER_SCOPE, verified: null, error: null };
}

/** Resolves the effective config (settings + that user's own credentials). */
async function buildUserCfg(settings) {
  const cfg = resolveTradingConfig(settings);
  cfg.id = settings.id;
  cfg.scope = scopeOf(settings);
  cfg.account = settings.__account || null;
  cfg.displayName = cfg.account?.full_name || userLabel(settings);
  cfg.avatarUrl = cfg.account?.avatar_url || null;
  cfg.email = cfg.account?.email || null;
  // STRICT ISOLATION: only this workspace's vault row. No global env keys and no
  // settings-row key ever stand in for a user who has not linked their own pair.
  const stored = await loadUserApiKeys(cfg.scope);
  cfg.apiKey = String(stored?.apiKey || '').trim();
  cfg.apiSecret = String(stored?.apiSecret || '').trim();
  cfg.useTestnet =
    process.env.BINANCE_TESTNET === 'false'
      ? false
      : ENV_TESTNET || Boolean(stored?.useTestnet ?? settings.use_testnet);
  // A signed-in workspace always alerts its own Telegram chat, never the admin's.
  // For a real account the `users.telegram_chat_id` column is the only source: a
  // stale settings.chat_id (copied from the old single-tenant admin row) must not
  // hijack a trader's alerts.
  cfg.telegramChatId = String(
    cfg.account
      ? cfg.account.telegram_chat_id || ''
      : settings.chat_id || settings.telegram_chat_id || ''
  ).trim();
  if (!cfg.telegramChatId) {
    console.warn(
      `[TELEGRAM] Workspace ${cfg.scope} has no linked private chat — its alerts are skipped.`
    );
  }
  cfg.hasCredentials = Boolean(cfg.apiKey && cfg.apiSecret);
  return cfg;
}

let cachedServerIp = null;
let cachedServerIpAt = 0;

/** Resolves (and caches) this worker's public egress IP for Binance IP whitelisting. */
async function resolveServerPublicIp() {
  const configured = String(process.env.SERVER_PUBLIC_IP || process.env.PUBLIC_IP || '').trim();
  if (configured) return configured;
  if (cachedServerIp && Date.now() - cachedServerIpAt < 10 * 60_000) return cachedServerIp;
  for (const url of ['https://api.ipify.org?format=json', 'https://ifconfig.me/all.json']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      const ip = String(data?.ip || data?.ip_addr || '').trim();
      if (/^[0-9a-fA-F.:]+$/.test(ip)) {
        cachedServerIp = ip;
        cachedServerIpAt = Date.now();
        return ip;
      }
    } catch {
      /* try the next resolver */
    }
  }
  return cachedServerIp || '';
}

// Optional CORS HTTP Server & API Endpoints
const PORT = Number(process.env.PORT || 10000);
if (PORT > 0) {
  http
    .createServer(async (req, res) => {
      // The terminal is served from a different origin (Render static site), so every
      // API call — including the Supabase Bearer session — must pass CORS preflight.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, apikey, x-client-info, X-MBX-APIKEY'
      );
      res.setHeader('Access-Control-Max-Age', '86400');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (req.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/api/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            service: 'aegis-quant-worker',
            status: 'ok',
            timestamp: new Date().toISOString(),
            guards: describeCrashGuards(),
          })
        );
        return;
      }

      // Public egress IP of this 24/7 worker. Traders whitelist it in Binance under
      // API Management → "Restrict access to trusted IPs only".
      if (req.method === 'GET' && pathname === '/api/server-ip') {
        const ip = await resolveServerPublicIp();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: Boolean(ip),
            ip: ip || null,
            service: 'aegis-quant-worker',
            timestamp: new Date().toISOString(),
          })
        );
        return;
      }

      // Live circuit-breaker state for the terminal's "🛡️ Crash Guard: Active" badge.
      if (req.method === 'GET' && pathname === '/api/guards') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            timestamp: new Date().toISOString(),
            dropPctTrigger: CRASH_GUARD_DROP_PCT,
            pauseMinutes: CRASH_GUARD_PAUSE_MINUTES,
            guards: describeCrashGuards(),
          })
        );
        return;
      }

      // Server-side Telegram proxy for the web terminal and Mini App. The static
      // frontend origin has no API routes, so /api/telegram/send must live here.
      if (req.method === 'POST' && pathname === '/api/telegram/send') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const rawToken = String(data.botToken || data.bot_token || '')
              .trim()
              .replace(/^["']|["']$/g, '')
              .replace(/^bot/i, '')
              .trim();
            const requestedChat = String(data.chatId || data.chat_id || '').trim();
            const text = String(data.text || '').trim();

            // STRICT PER-USER ROUTING: the recipient is always the CALLER's own
            // `users.telegram_chat_id`. A client-supplied chat id is ignored for a
            // signed-in account, and the admin chat is never a delivery fallback.
            const authUser = await verifyAccessToken(req);
            let caller = authUser ? await fetchAccountById(authUser.id) : null;
            if (!caller) {
              const tgIdentity = verifyTelegramInitData(data.initData || data.init_data);
              if (tgIdentity) caller = await fetchAccountByChat(tgIdentity.id);
            }
            let chatId = '';
            if (caller) {
              chatId = String(caller.telegram_chat_id || '').trim();
              if (!chatId) {
                console.warn(
                  `[TELEGRAM] No private chat linked for ${caller.email || caller.id} — alert skipped.`
                );
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    ok: false,
                    detail:
                      'No Telegram chat linked to this account. Add your own chat ID in Settings → Telegram Alerts.',
                  })
                );
                return;
              }
            } else {
              if (!requestedChat) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, detail: 'Missing botToken, chatId or text' }));
                return;
              }
              if (ADMIN_CHAT_ID && requestedChat === ADMIN_CHAT_ID) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    ok: false,
                    detail: 'Private alerts are only delivered to the signed-in trader\'s own chat.',
                  })
                );
                return;
              }
              chatId = requestedChat;
            }
            if (!rawToken || !text) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, detail: 'Missing botToken or text' }));
              return;
            }
            const tgRes = await fetch(`https://api.telegram.org/bot${rawToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: data.replyMarkup ?? data.reply_markup ?? undefined,
              }),
            });
            const tgData = await tgRes.json().catch(() => ({}));
            if (!tgRes.ok || tgData.ok === false) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: false,
                  detail: tgData.description || `Telegram HTTP ${tgRes.status}`,
                  errorCode: tgData.error_code ?? null,
                })
              );
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                detail: 'Dispatched to Telegram ✓',
                messageId: tgData.result?.message_id ?? null,
              })
            );
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, detail: err.message }));
          }
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/verify-keys') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const apiKey = String(data.apiKey || data.api_key || '').trim();
            const apiSecret = String(data.apiSecret || data.api_secret || '').trim();
            const testnet = process.env.BINANCE_TESTNET === 'true' ? true : Boolean(data.testnet ?? data.use_testnet ?? false);

            if (!apiKey || !apiSecret) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Missing apiKey or apiSecret' }));
              return;
            }

            const portfolio = await fetchBinancePortfolioUsdt(apiKey, apiSecret, testnet);
            if (!portfolio) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Failed to verify Binance keys or fetch balance' }));
              return;
            }

            const { scope } = resolveRequestScope(data, await verifyAccessToken(req));
            if (scope) {
              // Keys are private to the requesting workspace: never written to a shared row.
              await saveUserApiKeys(scope, apiKey, apiSecret, testnet);
            }
            const { data: settingsRow } = scope
              ? await supabase.from('settings').select('id').eq(SCOPE_COLUMN, scope).maybeSingle()
              : await supabase.from('settings').select('id').limit(1).maybeSingle();
            if (settingsRow) {
              await supabase
                .from('settings')
                .update({
                  ...(scope ? {} : { binance_api_key: apiKey, binance_api_secret: apiSecret }),
                  use_testnet: testnet,
                  balance_usdt: portfolio.total,
                  last_heartbeat: new Date().toISOString(),
                })
                .eq('id', settingsRow.id);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                usdtBalance: portfolio.total,
                totalPortfolioUsd: portfolio.total,
                usdtFree: portfolio.usdtFree,
                usdtLocked: portfolio.usdtLocked,
                spotUsd: portfolio.spot,
                spotCoinsUsd: portfolio.spotCoins,
                fundingUsd: portfolio.funding,
                earnUsd: portfolio.earn,
                assets: portfolio.assets,
                message: `Binance API verified successfully. Portfolio balance: $${portfolio.total.toFixed(2)} (Spot $${portfolio.spot.toFixed(2)})`,
              })
            );
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      if ((req.method === 'GET' || req.method === 'POST') && (pathname === '/api/balance' || pathname === '/api/binance/balance')) {
        try {
          // Optional workspace scope: a user's terminal only ever sees its own account.
          const authUser = await verifyAccessToken(req);
          const scope = authUser?.id
            ? scopeForAccount(authUser.id)
            : sanitiseScope(url.searchParams.get(SCOPE_COLUMN));
          const { data: settingsRow } = scope
            ? { data: await fetchUserSettings(scope) }
            : await supabase.from('settings').select('*').limit(1).maybeSingle();
          if (!settingsRow) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, usdtBalance: 0, totalUsdt: 0, totalPortfolioUsd: 0 }));
            return;
          }

          // Only the requesting workspace's own vault keys are ever used here.
          const stored = scope ? await loadUserApiKeys(scope) : null;
          const apiKey = String(stored?.apiKey || '').trim();
          const apiSecret = String(stored?.apiSecret || '').trim();
          const useTestnet =
            process.env.BINANCE_TESTNET === 'false'
              ? false
              : ENV_TESTNET || Boolean(stored?.useTestnet ?? settingsRow.use_testnet);

          if (!apiKey || !apiSecret) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ ok: false, error: 'No Binance API keys linked to this workspace' })
            );
            return;
          }

          let spotUsdt = Number(settingsRow.balance_usdt || 0);
          let usdtFree = spotUsdt;
          let usdtLocked = 0;
          let spotCoins = 0;
          let assets = [];
          let fundingUsd = 0;
          let earnUsd = 0;
          if (apiKey && apiSecret) {
            const portfolio = await fetchBinancePortfolioUsdt(apiKey, apiSecret, useTestnet);
            if (portfolio) {
              spotUsdt = portfolio.spot;
              usdtFree = portfolio.usdtFree;
              usdtLocked = portfolio.usdtLocked;
              spotCoins = portfolio.spotCoins;
              assets = portfolio.assets;
              fundingUsd = portfolio.funding;
              earnUsd = portfolio.earn;
            }
          }
          const totalPortfolioUsd = Number((spotUsdt + fundingUsd + earnUsd).toFixed(2));
          const walletBreakdown = [
            { walletName: 'Spot', balanceUsd: spotUsdt },
            { walletName: 'Funding', balanceUsd: fundingUsd },
            { walletName: 'Earn', balanceUsd: earnUsd },
          ].filter((w) => w.balanceUsd > 0);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              usdtBalance: totalPortfolioUsd,
              usdtFree,
              usdtLocked,
              totalUsdt: totalPortfolioUsd,
              totalPortfolioUsd,
              spotUsd: spotUsdt,
              spotCoinsUsd: spotCoins,
              fundingUsd,
              earnUsd,
              walletBreakdown,
              assets,
            })
          );
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // Manual execution from the Mini App / web terminal: a real signed Binance Spot
      // MARKET order. The exchange decides the fill; the caller records that fill only.
      if (req.method === 'POST' && pathname === '/api/order') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            // Manual orders execute against the CALLER'S workspace credentials only.
            const { scope } = resolveRequestScope(data, await verifyAccessToken(req));
            const scopedRow = await fetchUserSettings(scope);
            const { data: settingsRow } = scopedRow
              ? { data: scopedRow }
              : await supabase.from('settings').select('*').limit(1).maybeSingle();
            const stored = await loadUserApiKeys(scope);
            // Strictly the caller's own vault pair — no global env or shared row fallback.
            const apiKey = String(stored?.apiKey || '').trim();
            const apiSecret = String(stored?.apiSecret || '').trim();
            const useTestnet =
              process.env.BINANCE_TESTNET === 'false'
                ? false
                : ENV_TESTNET ||
                  Boolean(data.testnet ?? data.useTestnet ?? stored?.useTestnet ?? settingsRow?.use_testnet);
            const symbol = String(data.symbol || '').trim().toUpperCase();
            const side = String(data.side || '').trim().toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
            const quoteOrderQty = Number(data.quoteOrderQty || 0);
            const quantity = Number(data.quantity || 0);

            if (!apiKey || !apiSecret) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Missing Binance API credentials' }));
              return;
            }
            if (!symbol) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Missing symbol' }));
              return;
            }
            if (side === 'BUY' && (!Number.isFinite(quoteOrderQty) || quoteOrderQty < BINANCE_MIN_ORDER_USDT)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: `Order notional must be at least $${BINANCE_MIN_ORDER_USDT.toFixed(2)} USDT`,
                })
              );
              return;
            }
            if (side === 'SELL' && (!Number.isFinite(quantity) || quantity <= 0)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Missing sell quantity' }));
              return;
            }

            const order = await placeBinanceMarketOrder(
              symbol,
              side,
              quoteOrderQty,
              quantity,
              apiKey,
              apiSecret,
              useTestnet
            );
            await appendLog(
              'TRADE',
              `[MANUAL] ${side} ${symbol} filled: qty ${order.executedQty} for ${order.cummulativeQuoteQty} USDT`,
              symbol
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, order }));
          } catch (err) {
            console.error('[MANUAL ORDER ERROR]', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      /** Per-user Binance key vault. Secrets are write-only; reads return a mask. */
      if (pathname === '/api/user/keys') {
        if (req.method === 'GET') {
          const { scope } = resolveRequestScope(
            {
              telegram_user_id: url.searchParams.get('telegram_user_id'),
              initData: url.searchParams.get('initData'),
            },
            await verifyAccessToken(req)
          );
          const stored = await loadUserApiKeys(scope);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              telegram_user_id: scope,
              linked: Boolean(stored?.apiKey && stored?.apiSecret),
              api_key_masked: stored?.apiKey ? maskSecret(stored.apiKey) : null,
              use_testnet: Boolean(stored?.useTestnet),
              updated_at: stored?.updatedAt || null,
            })
          );
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body || '{}');
              const apiKey = String(data.api_key || data.apiKey || '').trim();
              const apiSecret = String(data.api_secret || data.apiSecret || '').trim();
              if (apiKey.length < 16 || apiSecret.length < 16) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'API key and secret must be at least 16 characters' }));
                return;
              }
              const { scope, verified } = resolveRequestScope(data, await verifyAccessToken(req));
              const saved = await saveUserApiKeys(
                scope,
                apiKey,
                apiSecret,
                Boolean(data.use_testnet ?? data.testnet)
              );
              if (!saved.ok) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: saved.error }));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: true,
                  telegram_user_id: scope,
                  verified: Boolean(verified),
                  linked: true,
                  api_key_masked: maskSecret(apiKey),
                  use_testnet: Boolean(data.use_testnet ?? data.testnet),
                })
              );
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }
      }

      /** Tests the CALLER'S OWN stored Binance keys and syncs their live balance. */
      if (req.method === 'POST' && pathname === '/api/user/keys/test') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const { scope } = resolveRequestScope(data, await verifyAccessToken(req));
            const stored = await loadUserApiKeys(scope);
            if (!stored?.apiKey || !stored?.apiSecret) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'No Binance keys saved for this workspace yet' }));
              return;
            }
            const useTestnet = data.use_testnet === undefined ? stored.useTestnet : Boolean(data.use_testnet);
            const portfolio = await fetchBinancePortfolioUsdt(stored.apiKey, stored.apiSecret, useTestnet);
            if (!portfolio) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Binance rejected the keys or the account is unreachable' }));
              return;
            }
            const { data: row } = await supabase
              .from('settings')
              .select('id')
              .eq(SCOPE_COLUMN, scope)
              .maybeSingle();
            if (row) {
              await supabase
                .from('settings')
                .update({ balance_usdt: portfolio.total, last_heartbeat: new Date().toISOString() })
                .eq('id', row.id);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                usdtBalance: portfolio.total,
                totalPortfolioUsd: portfolio.total,
                usdtFree: portfolio.usdtFree,
                usdtLocked: portfolio.usdtLocked,
                spotUsd: portfolio.spot,
                spotCoinsUsd: portfolio.spotCoins,
                fundingUsd: portfolio.funding,
                earnUsd: portfolio.earn,
                assets: portfolio.assets,
                api_key_masked: maskSecret(stored.apiKey),
                use_testnet: useTestnet,
              })
            );
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      /** Public leaderboard: aggregates only, never balances of keys/balances. */
      if (req.method === 'GET' && pathname === '/api/leaderboard') {
        try {
          const board = await buildLeaderboardRows();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, timestamp: new Date().toISOString(), entries: board }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      /* ------------------------------------------------------------------ *
       * Admin console API (Supabase session + is_admin required)
       * ------------------------------------------------------------------ */

      /** Lists every account with aggregates — never API secrets. */
      if (req.method === 'GET' && pathname === '/api/admin/users') {
        try {
          const authUser = await verifyAccessToken(req);
          if (!authUser) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Sign in required' }));
            return;
          }
          const me = await fetchAccountById(authUser.id);
          if (!isOwnerAdminAccount(me)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Admin access required' }));
            return;
          }

          const { data: rows, error } = await supabase
            .from(USERS_TABLE)
            .select('*')
            .order('created_at', { ascending: false })
            .limit(500);
          if (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: error.message }));
            return;
          }
          const { data: keyRows } = await supabase
            .from(USER_KEYS_TABLE)
            .select(SCOPE_COLUMN);
          const linked = new Set((keyRows || []).map((row) => String(row[SCOPE_COLUMN] || '')));

          const entries = (rows || []).map((row) => ({
            id: row.id,
            email: row.email,
            full_name: row.full_name || '',
            avatar_url: row.avatar_url || null,
            telegram_chat_id: row.telegram_chat_id || null,
            telegram_username: row.telegram_username || null,
            approval_status: row.approval_status || 'pending',
            is_admin: isOwnerAdminAccount(row),
            trading_mode: String(row.trading_mode || 'VIRTUAL').toUpperCase() === 'LIVE' ? 'LIVE' : 'VIRTUAL',
            bot_running: Boolean(row.bot_running),
            realized_pnl_usd: Number(row.realized_pnl_usd || 0),
            total_trades: Number(row.total_trades || 0),
            win_trades: Number(row.win_trades || 0),
            has_keys: linked.has(scopeForAccount(row.id)),
            created_at: row.created_at || null,
          }));
          const totals = entries.reduce(
            (acc, entry) => {
              acc.users += 1;
              acc[entry.approval_status] = (acc[entry.approval_status] || 0) + 1;
              acc.pnl_usd += entry.realized_pnl_usd;
              return acc;
            },
            { users: 0, pending: 0, approved: 0, rejected: 0, pnl_usd: 0 }
          );
          totals.pnl_usd = Number(totals.pnl_usd.toFixed(2));
          totals.pnl_bdt = Math.round(totals.pnl_usd * BDT_PER_USD);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, entries, totals }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      /** Approve/reject from the web admin panel, with the same Telegram notice. */
      if (req.method === 'POST' && pathname === '/api/admin/approval') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const authUser = await verifyAccessToken(req);
            if (!authUser) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Sign in required' }));
              return;
            }
            const me = await fetchAccountById(authUser.id);
            if (!isOwnerAdminAccount(me)) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Admin access required' }));
              return;
            }
            const data = JSON.parse(body || '{}');
            const decision = String(data.decision || '').toLowerCase() === 'reject' ? 'reject' : 'approve';
            const result = await applyApproval(
              data.user_id || data.userId,
              decision,
              me.email || String(authUser.id)
            );
            if (!result.ok) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                status: result.status,
                email: result.user?.email || null,
              })
            );
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      /* ------------------------------------------------------------------ *
       * Password reset over Telegram: a 6-digit code is DM'd by @TaseenMarketBot
       * to the account's registered chat, then the worker sets the new password.
       * ------------------------------------------------------------------ */

      if (req.method === 'POST' && pathname === '/api/auth/reset-request') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          const generic = {
            ok: true,
            message:
              'If that email has a Telegram chat linked, a 6-digit reset code was sent by @TaseenMarketBot.',
          };
          try {
            const data = JSON.parse(body || '{}');
            const email = String(data.email || '').trim().toLowerCase();
            if (!email) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Email is required' }));
              return;
            }

            const { data: account } = await supabase
              .from(USERS_TABLE)
              .select('id,email,full_name,telegram_chat_id')
              .eq('email', email)
              .maybeSingle();

            if (!account?.telegram_chat_id) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(generic));
              return;
            }

            const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
            const expiresAt = new Date(
              Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000
            ).toISOString();
            const { error: storeError } = await supabase.from(PASSWORD_RESET_TABLE).upsert(
              {
                email,
                code_hash: hashResetCode(email, code),
                expires_at: expiresAt,
                attempts: 0,
                created_at: new Date().toISOString(),
              },
              { onConflict: 'email' }
            );
            if (storeError) throw new Error(storeError.message);

            const delivered = await sendTelegram(
              [
                '🔐 <b>AEGIS QUANT PASSWORD RESET</b>',
                '',
                `Hi ${account.full_name || 'Trader'}, your one-time reset code is:`,
                `<code>${code}</code>`,
                '',
                `It expires in ${PASSWORD_RESET_TTL_MINUTES} minutes. If you did not request this, ignore this message — your password stays unchanged.`,
              ].join('\n'),
              TELEGRAM_BOT_TOKEN,
              account.telegram_chat_id,
              { replyMarkup: null }
            );
            if (!delivered) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: false,
                  error:
                    'Telegram could not deliver the code. Open @TaseenMarketBot, send /start, and try again.',
                })
              );
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(generic));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/reset-confirm') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const email = String(data.email || '').trim().toLowerCase();
            const code = String(data.code || '').trim();
            const newPassword = String(data.new_password || data.newPassword || '');

            if (!email || !/^\d{6}$/.test(code)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Enter the 6-digit code sent on Telegram' }));
              return;
            }
            if (newPassword.length < 8) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ ok: false, error: 'New password must be at least 8 characters' })
              );
              return;
            }

            const { data: row } = await supabase
              .from(PASSWORD_RESET_TABLE)
              .select('*')
              .eq('email', email)
              .maybeSingle();
            if (!row || !row.code_hash) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Request a new reset code first' }));
              return;
            }
            if (new Date(row.expires_at).getTime() < Date.now()) {
              await supabase.from(PASSWORD_RESET_TABLE).delete().eq('email', email);
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'That code expired — request a new one' }));
              return;
            }
            if (Number(row.attempts || 0) >= PASSWORD_RESET_MAX_ATTEMPTS) {
              await supabase.from(PASSWORD_RESET_TABLE).delete().eq('email', email);
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ ok: false, error: 'Too many wrong codes — request a new one' })
              );
              return;
            }
            if (row.code_hash !== hashResetCode(email, code)) {
              await supabase
                .from(PASSWORD_RESET_TABLE)
                .update({ attempts: Number(row.attempts || 0) + 1 })
                .eq('email', email);
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Incorrect reset code' }));
              return;
            }

            const { data: account } = await supabase
              .from(USERS_TABLE)
              .select('id,email')
              .eq('email', email)
              .maybeSingle();
            if (!account?.id) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'No account found for that email' }));
              return;
            }

            const { error: authError } = await supabase.auth.admin.updateUserById(account.id, {
              password: newPassword,
            });
            if (authError) throw new Error(authError.message);

            await supabase.from(PASSWORD_RESET_TABLE).delete().eq('email', email);
            if (account.email) {
              await appendLog('INFO', `[AUTH] Password reset completed for ${account.email}.`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ ok: true, message: 'Password updated. Sign in with your new password.' })
            );
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    })
    .listen(PORT, '0.0.0.0', () => {
      console.log(`[WORKER] HTTP server listening on port ${PORT}`);
    });
}

async function sendTelegram(text, token, chatId, options = {}) {
  const t = (token || TELEGRAM_BOT_TOKEN || '').trim();
  // Never fall back to another workspace's chat: each user is alerted privately.
  const c = String(chatId || '').trim();
  if (!t) return false;
  if (!c) {
    console.warn(
      '[TELEGRAM] Alert skipped — this workspace has no linked telegram_chat_id (never routed to the admin).'
    );
    return false;
  }
  const replyMarkup =
    options.replyMarkup === null ? null : options.replyMarkup || TELEGRAM_OPEN_TERMINAL_MARKUP;
  try {
    const res = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: c,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn('[TELEGRAM ERROR]', data?.description || `HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[TELEGRAM ERROR]', err.message);
    return false;
  }
}

/** Sends a rendered PNG with an HTML caption (used for the shareable PnL card). */
/** Sniffs PNG/JPEG/WebP so avatars upload as photos without conversion. */
function imageMime(buffer) {
  if (!buffer || buffer.length < 12) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

/** Decodes a data-URL / https avatar into a Buffer for Telegram uploads. */
async function fetchAvatarBuffer(avatarUrl) {
  const url = String(avatarUrl || '').trim();
  if (!url) return null;
  try {
    if (url.startsWith('data:')) {
      const base64 = url.split(',')[1] || '';
      if (!base64) return null;
      const buffer = Buffer.from(base64, 'base64');
      return buffer.length > 0 && buffer.length <= 3_000_000 ? buffer : null;
    }
    if (/^https?:/i.test(url)) {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      return buffer.length > 0 && buffer.length <= 3_000_000 ? buffer : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function sendTelegramPhoto(pngBuffer, caption, token, chatId, replyMarkup, mimeType) {
  const t = (token || TELEGRAM_BOT_TOKEN || '').trim();
  const c = String(chatId || '').trim();
  if (!t || !c || !pngBuffer) return false;
  try {
    const form = new FormData();
    form.append('chat_id', c);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    const type = mimeType || imageMime(pngBuffer);
    form.append('photo', new Blob([pngBuffer], { type }), 'aegis.png');
    const res = await fetch(`https://api.telegram.org/bot${t}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn('[TELEGRAM PHOTO ERROR]', data?.description || `HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[TELEGRAM PHOTO ERROR]', err.message);
    return false;
  }
}

async function answerCallbackQuery(token, callbackQueryId, text, showAlert = false) {
  try {
    await telegramApiCall(
      token,
      'answerCallbackQuery',
      { callback_query_id: callbackQueryId, text, show_alert: showAlert },
      10_000
    );
  } catch (err) {
    console.warn('[TELEGRAM CALLBACK] answer failed:', err.message);
  }
}

/**
 * Renders and pushes the AEGIS QUANT PnL card. Falls back silently (the text
 * alert already carries the numbers) when the native renderer is unavailable.
 */
async function sendPnlCard(cfg, details) {
  if (!cfg.telegramEnabled || !cfg.telegramToken || !cfg.telegramChatId) return false;
  const png = await renderPnlCard({
    symbol: details.symbol,
    side: 'LONG SPOT',
    roiPct: details.pnlPct,
    netProfitUsd: details.pnlUsdt,
    entryPrice: details.entryPrice,
    exitPrice: details.exitPrice,
    mode: MODE_LABEL[cfg.mode],
    traderName: cfg.displayName,
    traderAvatarUrl: cfg.avatarUrl,
    closedAt: new Date(),
  });
  if (!png) return false;
  const caption = [
    `<b>💰 ${details.symbol} CLOSED IN PROFIT</b>`,
    cfg.displayName ? `Trader: <b>${cfg.displayName}</b>` : '',
    `Net ${Number(details.pnlUsdt) >= 0 ? '+' : ''}$${Number(details.pnlUsdt).toFixed(2)} USDT · ${
      Number(details.pnlPct) >= 0 ? '+' : ''
    }${Number(details.pnlPct).toFixed(2)}% ROI`,
    `Entry $${Number(details.entryPrice).toFixed(4)} → Exit $${Number(details.exitPrice).toFixed(4)}`,
  ]
    .filter(Boolean)
    .join('\n');
  return sendTelegramPhoto(png, caption, cfg.telegramToken, cfg.telegramChatId, tradeAlertMarkup(details.symbol));
}

function isMissingTableError(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    msg.includes('Could not find the table') ||
    msg.includes('does not exist')
  );
}

function isMissingPairColumnError(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    msg.includes("'pair'") ||
    msg.includes('column "pair"')
  );
}

async function insertLogIntoTable(tableName, level, message, pair) {
  const payload = pair ? { level, pair, message } : { level, message };
  let { error } = await supabase.from(tableName).insert(payload);
  if (error && pair && isMissingPairColumnError(error)) {
    ({ error } = await supabase.from(tableName).insert({ level, message }));
  }
  if (error && !isMissingTableError(error)) {
    console.warn(`[SUPABASE LOG WARNING] (${tableName}) ${error.message}`);
  }
}

async function appendLog(level, message, pair = null) {
  await Promise.allSettled([
    insertLogIntoTable('engine_logs', level, message, pair),
    insertLogIntoTable('logs', level, message, pair),
  ]);
}

async function fetchServerPublicIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      const match = String(data?.ip || '').trim().match(IPV4_REGEX);
      if (match) return match[1];
    }
  } catch (err) {
    console.warn('[IP LOOKUP WARNING] ipify.org failed:', err.message);
  }

  try {
    const res = await fetch('https://ifconfig.me/ip', {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      const match = text.match(IPV4_REGEX);
      if (match) return match[1];
    }
  } catch (err) {
    console.warn('[IP LOOKUP WARNING] ifconfig.me failed:', err.message);
  }

  return null;
}

async function logServerPublicIp() {
  const ip = await fetchServerPublicIp();
  if (ip) {
    const line = `[SERVER PUBLIC IP] ${ip}`;
    console.log(line);
    await appendLog('INFO', line);
    return ip;
  }
  const warnLine = '[SERVER PUBLIC IP] Unavailable';
  console.warn(warnLine);
  await appendLog('WARNING', warnLine);
  return null;
}

function signBinanceQuery(queryString, apiSecret) {
  return crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');
}

async function fetchPublicWithFallback(pathAndQuery, useTestnet) {
  const endpoints = useTestnet
    ? ['https://testnet.binance.vision']
    : [
        'https://data-api.binance.vision',
        'https://api1.binance.com',
        'https://api2.binance.com',
        'https://api3.binance.com',
      ];

  let lastErr = null;
  for (const base of endpoints) {
    try {
      const res = await fetch(`${base}${pathAndQuery}`);
      if (res.status === 418 || res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Binance public HTTP ${res.status} (${base})`);
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`Binance public HTTP ${res.status} (${base})`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All public Binance market endpoints failed');
}

async function signedBinanceRequest(method, path, apiKey, apiSecret, useTestnet, extraParams = {}) {
  if (!apiKey || !apiSecret) {
    throw new Error('Binance API credentials missing');
  }

  const endpoints = useTestnet
    ? ['https://testnet.binance.vision']
    : ['https://api1.binance.com', 'https://api2.binance.com', 'https://api3.binance.com'];

  let lastErr = null;
  for (const base of endpoints) {
    try {
      const params = new URLSearchParams({
        ...extraParams,
        recvWindow: '15000',
        timestamp: String(Date.now()),
      });
      const sig = signBinanceQuery(params.toString(), apiSecret);
      params.set('signature', sig);

      const res = await fetch(`${base}${path}?${params.toString()}`, {
        method,
        headers: { 'X-MBX-APIKEY': apiKey },
      });

      if (res.status === 418 || res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Binance signed HTTP ${res.status} (${base})`);
        continue;
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.msg || `Binance HTTP ${res.status}`);
      }
      return data;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      if (!msg.includes('HTTP 418') && !msg.includes('HTTP 429') && !msg.includes('HTTP 5')) {
        throw err;
      }
    }
  }
  throw lastErr || new Error('All Binance signed endpoints failed');
}

async function fetchBinancePrices(symbols, useTestnet) {
  if (!symbols || symbols.length === 0) return {};
  const param = encodeURIComponent(JSON.stringify(symbols));
  const rows = await fetchPublicWithFallback(`/api/v3/ticker/price?symbols=${param}`, useTestnet);
  const map = {};
  for (const row of rows) {
    map[row.symbol] = Number(row.price);
  }
  return map;
}

async function fetchKlines(symbol, interval, limit, useTestnet) {
  const rows = await fetchPublicWithFallback(
    `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
    useTestnet
  );
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      closeTime: Number(row[6]),
    }))
    .filter((row) => Number.isFinite(row.close) && row.close > 0);
}

function computeEma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeRsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Snapshot of every pair currently paused by the flash-crash guard. */
function describeCrashGuards() {
  const now = Date.now();
  const active = [];
  for (const [symbol, guard] of crashGuardState.entries()) {
    if (guard.blockedUntil <= now) {
      crashGuardState.delete(symbol);
      continue;
    }
    active.push({
      symbol,
      dropPct: Number(guard.dropPct.toFixed(2)),
      active: true,
      triggeredAt: new Date(guard.triggeredAt).toISOString(),
      resumeAt: new Date(guard.blockedUntil).toISOString(),
      minutesRemaining: Math.max(0, Math.ceil((guard.blockedUntil - now) / 60_000)),
    });
  }
  return active;
}

/**
 * Flash-Crash & Volatility Guard (circuit breaker).
 * Measures the last CRASH_GUARD_WINDOW_MINUTES of 1m candles; a drop at or beyond
 * CRASH_GUARD_DROP_PCT pauses new entries + DCA re-buys for that pair for
 * CRASH_GUARD_PAUSE_MINUTES and fires ONE Telegram warning per event.
 */
async function checkCrashGuard(symbol, cfg) {
  const now = Date.now();
  const existing = crashGuardState.get(symbol);
  if (existing && existing.blockedUntil > now) {
    return { blocked: true, dropPct: existing.dropPct, minutesRemaining: Math.ceil((existing.blockedUntil - now) / 60_000) };
  }
  if (existing) crashGuardState.delete(symbol);

  try {
    const klines = await fetchKlines(symbol, '1m', CRASH_GUARD_WINDOW_MINUTES + 1, cfg.useTestnet);
    if (klines.length < 2) return { blocked: false };
    const windowRows = klines.slice(-(CRASH_GUARD_WINDOW_MINUTES + 1));
    const firstOpen = windowRows[0].open;
    const lastClose = windowRows[windowRows.length - 1].close;
    if (!firstOpen || !lastClose) return { blocked: false };
    const changePct = ((lastClose - firstOpen) / firstOpen) * 100;

    if (changePct <= -CRASH_GUARD_DROP_PCT) {
      const guard = {
        dropPct: changePct,
        triggeredAt: now,
        blockedUntil: now + CRASH_GUARD_PAUSE_MINUTES * 60_000,
      };
      crashGuardState.set(symbol, guard);
      const message = `⚠️ CRASH GUARD PAUSED ${symbol}: ${changePct.toFixed(
        2
      )}% 5m drop detected — new entries and DCA re-buys paused for ${CRASH_GUARD_PAUSE_MINUTES} minutes.`;
      console.warn(`[CRASH GUARD] ${message}`);
      await appendLog('WARNING', `[${MODE_LABEL[cfg.mode]}] ${message}`, symbol);
      await sendWarningTelegram(cfg, message);
      return { blocked: true, dropPct: changePct, minutesRemaining: CRASH_GUARD_PAUSE_MINUTES };
    }
  } catch (err) {
    // Market data outages must never stop the engine — trade on without the guard.
    console.warn(`[CRASH GUARD] ${symbol} volatility check skipped:`, err.message);
  }
  return { blocked: false };
}

/**
 * Multi-timeframe trend confirmation: only allow a fresh BUY when the 1h candle
 * closes above its EMA20 and 1h RSI sits in the healthy 40-72 band, so the engine
 * stops buying dips inside a macro downtrend.
 */
async function checkHigherTimeframeTrend(symbol, cfg) {
  // Operator switched the confirmation filter OFF: never veto a fresh entry.
  if (!cfg.multiTimeframeFilter) return { ok: true, reason: 'MTF filter off' };
  try {
    const klines = await fetchKlines(symbol, '1h', 120, cfg.useTestnet);
    const closes = klines.map((row) => row.close);
    const ema20 = computeEma(closes, 20);
    const rsi = computeRsi(closes, 14);
    if (ema20 === null || rsi === null) return { ok: true, reason: 'insufficient 1h history' };
    const lastClose = closes[closes.length - 1];
    // DEMO uses a responsive band: ordinary in-trend movement (up to 2.5% below
    // the 1h EMA20) and a wider RSI ceiling still count as a healthy entry, so the
    // 24/7 paper engine keeps scanning and trading instead of vetoing every cycle.
    const relaxed = cfg.mode === 'virtual' || !cfg.multiTimeframeFilter;
    const emaFloor = relaxed ? ema20 * 0.975 : ema20;
    const bullish = lastClose >= emaFloor;
    const healthyRsi = relaxed ? rsi <= 78 : rsi >= 40 && rsi <= 72;
    return {
      ok: bullish && healthyRsi,
      close: lastClose,
      ema20,
      rsi,
      relaxed,
      reason: !bullish
        ? `1h close ${lastClose.toFixed(4)} more than 2.5% below 1h EMA20 ${ema20.toFixed(4)}`
        : `1h RSI ${rsi.toFixed(1)} above the ${relaxed ? '78' : '72'} buy ceiling`,
    };
  } catch (err) {
    console.warn(`[MTF FILTER] ${symbol} 1h trend check skipped:`, err.message);
    return { ok: true, reason: '1h data unavailable' };
  }
}

/**
 * Smart auto-compounding position sizing: a % of the live workspace balance,
 * clamped above the Binance notional floor so LIVE orders stay valid.
 */
function resolveEntryNotional(cfg, balance) {
  if (!cfg.autoCompounding) return cfg.lotRequested;
  const pct = Math.min(100, Math.max(0.5, cfg.compoundAllocationPct));
  const sized = (Number(balance) || 0) * (pct / 100);
  const floor = cfg.mode === 'live' ? BINANCE_MIN_ORDER_USDT : 1;
  return Math.max(floor, Number(sized.toFixed(2)));
}

/**
 * Full Spot snapshot: spendable/locked USDT **plus** every other held coin valued at
 * the live ticker. A wallet holding BTC/ETH must never be reported as its stablecoins.
 */
async function fetchBinanceSpotSnapshot(apiKey, apiSecret, useTestnet) {
  if (!apiKey || !apiSecret) return null;
  const account = await signedBinanceRequest('GET', '/api/v3/account', apiKey, apiSecret, useTestnet);
  if (!account || !Array.isArray(account.balances)) return null;

  const holdings = account.balances
    .map((row) => ({
      asset: String(row.asset || '').toUpperCase(),
      free: Number(row.free || 0),
      locked: Number(row.locked || 0),
    }))
    .filter((row) => row.asset && row.free + row.locked > 0);

  const usdt = holdings.find((row) => row.asset === 'USDT');
  const usdtFree = Number((usdt ? usdt.free : 0).toFixed(2));
  const usdtLocked = Number((usdt ? usdt.locked : 0).toFixed(2));

  const coins = holdings.filter((row) => row.asset !== 'USDT');
  let prices = {};
  if (coins.length > 0) {
    try {
      const tickers = await fetchPublicWithFallback('/api/v3/ticker/price', useTestnet);
      prices = Array.isArray(tickers)
        ? Object.fromEntries(
            tickers.map((t) => [String(t.symbol || '').toUpperCase(), Number(t.price || 0)])
          )
        : {};
    } catch (err) {
      console.warn('[SPOT PRICES] live ticker lookup skipped:', err.message);
    }
  }

  const assets = holdings
    .map((row) => {
      const total = Number((row.free + row.locked).toFixed(8));
      const usdValue =
        row.asset === 'USDT'
          ? Number(total.toFixed(2))
          : Number((total * (prices[`${row.asset}USDT`] || 0)).toFixed(2));
      return { asset: row.asset, total, usdValue };
    })
    .filter((row) => row.usdValue >= 0.01)
    .sort((a, b) => b.usdValue - a.usdValue)
    .slice(0, 20);

  const coinsUsd = assets
    .filter((row) => row.asset !== 'USDT')
    .reduce((sum, row) => sum + row.usdValue, 0);

  return {
    usdtFree,
    usdtLocked,
    coinsUsd: Number(coinsUsd.toFixed(2)),
    spotValue: Number((usdtFree + usdtLocked + coinsUsd).toFixed(2)),
    assets,
  };
}

async function fetchBinanceFundingUsdt(apiKey, apiSecret, useTestnet) {
  if (useTestnet) return 0;
  try {
    const rows = await signedBinanceRequest('POST', '/sapi/v1/asset/get-funding-asset', apiKey, apiSecret, useTestnet, {});
    if (!Array.isArray(rows)) return 0;
    return rows
      .filter((r) => r.asset === 'USDT')
      .reduce(
        (sum, r) => sum + Number(r.free || 0) + Number(r.locked || 0) + Number(r.freeze || 0),
        0
      );
  } catch (err) {
    console.warn('[FUNDING WALLET WARNING]', err.message);
    return 0;
  }
}

async function fetchBinanceEarnUsdt(apiKey, apiSecret, useTestnet) {
  if (useTestnet) return 0;
  try {
    const data = await signedBinanceRequest('GET', '/sapi/v1/simple-earn/flexible/position', apiKey, apiSecret, useTestnet, { size: '50' });
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    return rows
      .filter((r) => r.asset === 'USDT')
      .reduce((sum, r) => sum + Number(r.totalAmount || 0), 0);
  } catch (err) {
    console.warn('[EARN WALLET WARNING]', err.message);
    return 0;
  }
}

/**
 * Full wallet total (Spot + Funding + Earn) so real money never reads as $0.00.
 * Returns null when the Spot account itself cannot be read (bad keys/IP block).
 */
async function fetchBinancePortfolioUsdt(apiKey, apiSecret, useTestnet) {
  const snapshot = await fetchBinanceSpotSnapshot(apiKey, apiSecret, useTestnet);
  if (!snapshot) return null;
  const [funding, earn] = await Promise.all([
    fetchBinanceFundingUsdt(apiKey, apiSecret, useTestnet),
    fetchBinanceEarnUsdt(apiKey, apiSecret, useTestnet),
  ]);
  return {
    spot: Number(snapshot.spotValue.toFixed(2)),
    usdtFree: snapshot.usdtFree,
    usdtLocked: snapshot.usdtLocked,
    spotCoins: snapshot.coinsUsd,
    assets: snapshot.assets,
    funding: Number(funding.toFixed(2)),
    earn: Number(earn.toFixed(2)),
    total: Number((snapshot.spotValue + funding + earn).toFixed(2)),
  };
}

async function placeBinanceMarketOrder(symbol, side, quoteOrderQty, quantity, apiKey, apiSecret, useTestnet) {
  const params = {
    symbol,
    side,
    type: 'MARKET',
  };
  if (side === 'BUY') {
    params.quoteOrderQty = Number(quoteOrderQty).toFixed(2);
  } else {
    params.quantity = Number(quantity).toFixed(5);
  }
  return signedBinanceRequest('POST', '/api/v3/order', apiKey, apiSecret, useTestnet, params);
}

// Binance rejects any Spot order below the symbol's MIN_NOTIONAL (usually $5) with
// "Filter failure: NOTIONAL" and below LOT_SIZE stepSize with "Filter failure: LOT_SIZE".
// These helpers keep every live entry compliant instead of aborting the whole cycle.
const BINANCE_MIN_ORDER_USDT = 5.5;
let exchangeFiltersCache = { at: 0, data: null };
const lastWarnAt = new Map();

async function warnThrottled(key, message, pair = null, cfg = null) {
  const now = Date.now();
  if (now - (lastWarnAt.get(key) || 0) < 10 * 60_000) return;
  lastWarnAt.set(key, now);
  console.warn(message);
  await appendLog('WARNING', cfg ? `[${MODE_LABEL[cfg.mode]}] ${message}` : message, pair);
  if (cfg) await sendWarningTelegram(cfg, message);
}

async function getSymbolFilters(symbol, useTestnet) {
  const fallback = { stepSize: 0, minQty: 0, minNotional: BINANCE_MIN_ORDER_USDT };
  if (!exchangeFiltersCache.data || Date.now() - exchangeFiltersCache.at > 6 * 3600_000) {
    try {
      const info = await fetchPublicWithFallback('/api/v3/exchangeInfo', useTestnet);
      const map = {};
      for (const s of info.symbols || []) {
        const filters = s.filters || [];
        const lot = filters.find((f) => f.filterType === 'LOT_SIZE');
        const notional =
          filters.find((f) => f.filterType === 'MIN_NOTIONAL') ||
          filters.find((f) => f.filterType === 'NOTIONAL');
        map[s.symbol] = {
          stepSize: Number(lot?.stepSize || 0),
          minQty: Number(lot?.minQty || 0),
          minNotional: Number(notional?.minNotional || notional?.notional || 5),
        };
      }
      exchangeFiltersCache = { at: Date.now(), data: map };
    } catch (err) {
      console.warn('[FILTERS] exchangeInfo unavailable, using defaults:', err.message);
      return fallback;
    }
  }
  return exchangeFiltersCache.data[symbol] || fallback;
}

function floorToStep(qty, stepSize) {
  if (!stepSize || stepSize <= 0) return Number(qty.toFixed(8));
  const decimals = Math.max(0, Math.round(-Math.log10(stepSize)));
  return Number((Math.floor(qty / stepSize) * stepSize).toFixed(decimals));
}

/**
 * Places a MIN_NOTIONAL/LOT_SIZE-compliant live BUY, or logs one throttled warning
 * and returns null. Never throws, so one rejected order cannot abort the whole cycle.
 *
 * The order size is NEVER silently resized. If the operator's lot is below the
 * exchange minimum we skip the entry and say so in the log + Telegram, so the
 * Settings value, the trade record and the exchange order always agree.
 */
async function buyWithGuards(symbol, label, quoteQty, livePx, apiKey, apiSecret, useTestnet, availableUsdt, cfg = null) {
  const filters = await getSymbolFilters(symbol, useTestnet);
  const requested = Math.max(1, Number(quoteQty) || 1);
  const minNotional = Math.max(filters.minNotional || 0, BINANCE_MIN_ORDER_USDT);
  const available = Number.isFinite(availableUsdt) ? availableUsdt : 0;

  if (requested < minNotional) {
    await warnThrottled(
      `lot-below-min-${symbol}`,
      `LIVE ${label} SKIPPED ${symbol} — your lot is $${requested.toFixed(2)} but Binance Spot requires at least $${minNotional.toFixed(2)}. Raise "Amount Per Trade" in Settings (no order was placed and nothing was resized).`,
      symbol,
      cfg
    );
    return null;
  }
  const notional = requested;

  if (available < notional) {
    await warnThrottled(
      `no-funds-${symbol}`,
      available <= 0
        ? `LIVE ${label} SKIPPED ${symbol} — Binance Spot USDT is $0.00. Transfer USDT to your Spot wallet (Funding/Earn balances cannot be traded) and press Sync Balance.`
        : `LIVE ${label} SKIPPED ${symbol} — needs $${notional.toFixed(2)} but Spot has $${available.toFixed(2)} available.`,
      symbol,
      cfg
    );
    return null;
  }

  let qty = floorToStep(notional / livePx, filters.stepSize);
  if (!Number.isFinite(qty) || qty <= 0) {
    qty = filters.minQty > 0 ? floorToStep(filters.minQty, filters.stepSize) || filters.minQty : 0;
  }
  if (!qty) return null;

  try {
    const order = await placeBinanceMarketOrder(symbol, 'BUY', notional, qty, apiKey, apiSecret, useTestnet);
    return {
      filledQty: Number(order?.executedQty) || qty,
      notional: Number(order?.cummulativeQuoteQty) || notional,
    };
  } catch (err) {
    await warnThrottled(
      `order-failed-${symbol}`,
      `LIVE ${label} REJECTED ${symbol}: ${err.message} — skipped this cycle (no phantom trade created).`,
      symbol,
      cfg
    );
    return null;
  }
}

/** Last portfolio value logged, per workspace (so users don't stomp each other). */
const lastLoggedBalance = new Map();
/** Last FEED scan heartbeat per workspace+mode (throttles the per-cycle log). */
const lastScanLogAt = new Map();

const MODE_LABEL = { live: 'LIVE', virtual: 'DEMO' };

function normalizeTradingMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'live' || v === 'real' ? 'live' : 'virtual';
}

function normalizePairList(raw) {
  if (Array.isArray(raw)) return raw.map((p) => String(p).trim().toUpperCase()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((p) => String(p).trim().toUpperCase()).filter(Boolean);
    } catch {
      return raw.split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
    }
  }
  return ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
}

/**
 * Everything the 15s cycle needs comes from the Supabase settings row, so the bot
 * keeps running with zero browser tabs open. `is_running`/`trading_mode` are the
 * canonical columns; the legacy `bot_enabled`/`mode` pair is still honoured.
 */
function resolveTradingConfig(settings) {
  const zeroLoss = Boolean(
    settings.zero_loss_shield ?? settings.zero_loss_mode ?? settings.sell_only_in_profit ?? true
  );
  const runFlag = settings.is_running ?? settings.bot_running ?? settings.engine_running;
  const isRunning =
    runFlag === null || runFlag === undefined ? Boolean(settings.bot_enabled) : Boolean(runFlag);
  const mode = normalizeTradingMode(
    settings.workspace_mode ?? settings.trading_mode ?? settings.mode
  );
  // DEMO and LIVE each own an independent power switch. Rows written before those
  // columns existed fall back to the single legacy flag scoped to their own mode.
  const demoFlag = settings.demo_bot_running;
  const liveFlag = settings.live_bot_running;
  const demoRunning =
    demoFlag === null || demoFlag === undefined ? isRunning && mode === 'virtual' : Boolean(demoFlag);
  const liveRunning =
    liveFlag === null || liveFlag === undefined ? isRunning && mode === 'live' : Boolean(liveFlag);
  return {
    isRunning: demoRunning || liveRunning,
    demoRunning,
    liveRunning,
    mode,
    telegramEnabled: settings.telegram_enabled !== false,
    // One shared @TaseenMarketBot talks to every user; only the chat differs.
    telegramToken: String(
      TELEGRAM_BOT_TOKEN || settings.telegram_bot_token || settings.bot_token || ''
    ).trim(),
    // Strictly this workspace's own chat — never the global TELEGRAM_CHAT_ID.
    telegramChatId: String(settings.chat_id || settings.telegram_chat_id || '').trim(),
    lotRequested: Math.max(1, Number(settings.trade_amount ?? settings.amount_per_trade ?? 10)),
    pairs: normalizePairList(settings.enabled_pairs),
    tpPct: Number(settings.take_profit_pct || 2.4),
    dcaEnabled: settings.dca_enabled !== false,
    dcaStepPct: Math.max(0.2, Number(settings.dca_step_pct || 1.5)),
    dcaMaxBuys: Math.max(1, Number(settings.dca_max_buys || 12)),
    zeroLoss,
    stopLossPct: Math.abs(Number(settings.stop_loss_pct || 1.5)),
    stopLossEnabled: !zeroLoss && Boolean(settings.stop_loss_enabled),
    maxPerPair: Number(settings.max_amount_per_pair || 500),
    maxOpenTrades: Math.max(1, Number(settings.max_open_trades || 5)),
    trailingStopPct: Math.max(0, Number(settings.trailing_stop_pct ?? 1.5)),
    dailyMaxLossPct: Math.max(0, Number(settings.daily_max_loss_pct ?? 5)),
    // Smart auto-compounding: size each ticket from the live workspace balance.
    autoCompounding: Boolean(settings.auto_compounding),
    compoundAllocationPct: Math.min(
      100,
      Math.max(0.5, Number(settings.compound_allocation_pct ?? 5))
    ),
    // Multi-timeframe bullish filter (15m/5m/1m signals must agree with 1h trend).
    multiTimeframeFilter: settings.multi_timeframe_filter !== false,
  };
}

/** Rows written before the `mode` column existed are still separable by id prefix. */
function tradeModeOf(row) {
  const declared = String(row?.mode ?? row?.trading_mode ?? '').trim().toLowerCase();
  if (declared === 'live' || declared === 'virtual') return declared;
  return String(row?.id ?? '').startsWith('VDEMO-') ? 'virtual' : 'live';
}

function isMissingColumnError(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return error.code === '42703' || error.code === 'PGRST204' || msg.includes('column');
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

async function sendTradeTelegram(cfg, details) {
  if (!cfg.telegramEnabled || !cfg.telegramToken || !cfg.telegramChatId) return;
  const label = MODE_LABEL[cfg.mode];
  const lines = [
    `<b>[${label}] ${details.title}</b>`,
    `Pair: <b>${details.symbol}</b> · ${details.side}`,
    `Price: ${money(details.price)}`,
    `Amount: ${money(details.amountUsd)} USDT`,
  ];
  if (details.pnlUsdt !== undefined && details.pnlUsdt !== null) {
    const pnl = Number(details.pnlUsdt);
    const pct = details.pnlPct === undefined ? null : Number(details.pnlPct);
    lines.push(
      `P&L: ${pnl >= 0 ? '+' : ''}${money(pnl)}${
        pct === null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`
      }`
    );
  }
  lines.push(
    `Balance: ${money(details.balanceUsd)} ${cfg.mode === 'live' ? '(Spot portfolio)' : '(virtual)'}`
  );
  if (details.note) lines.push(details.note);
  lines.push(`🕒 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  await sendTelegram(
    lines.join('\n'),
    cfg.telegramToken,
    cfg.telegramChatId,
    { replyMarkup: tradeAlertMarkup(details.symbol) }
  );
}

async function sendWarningTelegram(cfg, message) {
  if (!cfg.telegramEnabled || !cfg.telegramToken || !cfg.telegramChatId) return;
  await sendTelegram(
    `<b>[AEGIS ${MODE_LABEL[cfg.mode]}] ⚠️ WARNING</b>\n${message}`,
    cfg.telegramToken,
    cfg.telegramChatId
  );
}

/* ------------------------------------------------------------------------- *
 * Midnight daily PnL report — 00:00 Asia/Dhaka (18:00 UTC)
 * ------------------------------------------------------------------------- */

const BDT_PER_USD = 122.4;
const DHAKA_OFFSET_MS = 6 * 3600_000;

/** Start of the current Asia/Dhaka day, expressed as a UTC Date. */
function dhakaDayStartUtc(now = new Date()) {
  const dhaka = new Date(now.getTime() + DHAKA_OFFSET_MS);
  dhaka.setUTCHours(0, 0, 0, 0);
  return new Date(dhaka.getTime() - DHAKA_OFFSET_MS);
}

function dhakaDateKey(now = new Date()) {
  return new Date(now.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

let lastDailyReportKey = null;

/** One midnight report per workspace, delivered to that trader's private chat. */
async function sendDailyPnlReportFor(settings) {
  const cfg = await buildUserCfg(settings);
  if (!cfg.isRunning) return false;

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: rows } = await queryTrades(cfg.scope, { status: 'CLOSED', since });
  const closed = (rows || []).filter((row) => tradeModeOf(row) === cfg.mode);
  const totalTrades = closed.length;
  const wins = closed.filter((row) => Number(row.profit_usdt || 0) > 0).length;
  const losses = Math.max(0, totalTrades - wins);
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const realized = closed.reduce((sum, row) => sum + Number(row.profit_usdt || 0), 0);

  let liveSpot = Number(settings.balance_usdt || 0);
  let liveTotal = liveSpot;
  if (cfg.hasCredentials) {
    try {
      const portfolio = await fetchBinancePortfolioUsdt(cfg.apiKey, cfg.apiSecret, cfg.useTestnet);
      if (portfolio) {
        liveSpot = portfolio.spot;
        liveTotal = portfolio.total;
      }
    } catch (err) {
      console.warn('[DAILY REPORT] Portfolio sync skipped:', err.message);
    }
  }

  const virtualBalance = readVirtualBalance(settings);
  const bdtRealized = Math.round(realized * BDT_PER_USD);
  const bdtLive = Math.round(liveTotal * BDT_PER_USD);
  const bdtVirtual = Math.round(virtualBalance * BDT_PER_USD);

  const lines = [
    '<b>📊 AEGIS DAILY REPORT</b>',
    `🗓 ${dhakaDateKey()} · Asia/Dhaka · past 24h`,
    `🎛 Workspace: <b>${MODE_LABEL[cfg.mode]}</b> · Engine ${
      cfg.isRunning ? '🟢 RUNNING' : '⚪ STOPPED'
    }`,
    '',
    `📈 Trades closed: <b>${totalTrades}</b>`,
    `✅ Win rate: <b>${winRate.toFixed(1)}%</b> (${wins}W / ${losses}L)`,
    `💰 Realized PnL: <b>${realized >= 0 ? '+' : ''}$${realized.toFixed(2)}</b> (৳${bdtRealized.toLocaleString(
      'en-US'
    )})`,
    '',
    `🏦 Live portfolio: $${liveTotal.toFixed(2)} · tradeable Spot $${liveSpot.toFixed(2)} (৳${bdtLive.toLocaleString(
      'en-US'
    )})`,
    `🧪 Virtual balance: $${virtualBalance.toFixed(2)} (৳${bdtVirtual.toLocaleString('en-US')})`,
  ];

  if (!cfg.telegramEnabled || !cfg.telegramToken || !cfg.telegramChatId) return false;
  await sendTelegram(lines.join('\n'), cfg.telegramToken, cfg.telegramChatId, {
    replyMarkup: TELEGRAM_FINANCE_MARKUP,
  });
  await appendLog(
    'INFO',
    `[${MODE_LABEL[cfg.mode]}] Daily report sent to ${cfg.displayName} — ${totalTrades} trades, ${winRate.toFixed(
      1
    )}% win rate, realized $${realized.toFixed(2)}.`
  );
  return true;
}

async function sendDailyPnlReport() {
  const rows = await fetchWorkspaceRows();
  let sent = 0;
  for (const row of rows) {
    try {
      if (await sendDailyPnlReportFor(row)) sent += 1;
    } catch (err) {
      console.warn('[DAILY REPORT] workspace failed:', err.message);
    }
  }
  return sent;
}

/** Fires once per Dhaka day during the first ten minutes after local midnight. */
async function dailyReportLoop() {
  try {
    const dhaka = new Date(Date.now() + DHAKA_OFFSET_MS);
    if (dhaka.getUTCHours() !== 0 || dhaka.getUTCMinutes() > 10) return;
    const key = dhakaDateKey();
    if (lastDailyReportKey === key) return;
    lastDailyReportKey = key;
    console.log(`[DAILY REPORT] Sending midnight summary for ${key}`);
    await sendDailyPnlReport();
  } catch (err) {
    console.warn('[DAILY REPORT ERROR]', err.message);
  }
}

/* ------------------------------------------------------------------------- *
 * Telegram command bridge for @TaseenMarketBot
 * Long-polls getUpdates with offset tracking, accepts commands only from the
 * authorized TELEGRAM_CHAT_ID, and mutates the same Supabase settings row the
 * 24/7 worker and web terminal already read — so chat commands and the UI stay
 * in lockstep. Every reply carries the "Open Terminal" Mini App button.
 * ------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let telegramUpdateOffset = 0;
let telegramOffsetInitialised = false;
let telegramPolling = false;
let telegramBridgeCache = null;

/** Legacy single-tenant row, kept for pre-multi-user projects. */
async function fetchSettingsRow() {
  const { data, error } = await supabase.from('settings').select('*').limit(1).maybeSingle();
  if (error) {
    console.warn('[TELEGRAM BOT] Could not read settings:', error.message);
    return null;
  }
  return data || null;
}

/** One workspace per `telegram_user_id` (guest browsers use `guest:owner`). */
async function fetchUserSettings(scope) {
  const clean = sanitiseScope(scope);
  if (!clean) return null;
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .eq(SCOPE_COLUMN, clean)
    .limit(1)
    .maybeSingle();
  if (error) {
    if (!isMissingColumnError(error)) console.warn('[USERS] read failed:', error.message);
    return null;
  }
  return data || null;
}

async function fetchUserSettingsByChatId(chatId) {
  const clean = String(chatId || '').trim();
  if (!clean) return null;
  for (const column of ['chat_id', 'telegram_chat_id']) {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .eq(column, clean)
      .limit(1)
      .maybeSingle();
    if (!error && data) return data;
    if (error && !isMissingColumnError(error)) return null;
  }
  return null;
}

/**
 * Auto-provisions a fresh DEMO workspace the first time somebody talks to the
 * bot, so every Telegram user gets an isolated account with no setup step.
 */
async function ensureUserProfile({ telegramId, chatId, username, fullName }) {
  const scope = sanitiseScope(telegramId) || sanitiseScope(chatId) || DEFAULT_OWNER_SCOPE;
  const existing = await fetchUserSettings(scope);
  if (existing) {
    const patch = {};
    if (chatId && String(existing.chat_id || '') !== String(chatId)) patch.chat_id = String(chatId);
    if (username && existing.telegram_username !== username) patch.telegram_username = username;
    if (fullName && existing.full_name !== fullName) patch.full_name = fullName;
    if (Object.keys(patch).length > 0) {
      await supabase.from('settings').update(patch).eq('id', existing.id);
      Object.assign(existing, patch);
    }
    return existing;
  }

  // Pre-multi-user project (no scope column yet): the owner chat keeps the legacy row.
  if (!telegramId || String(chatId || '') === TELEGRAM_CHAT_ID || scope === DEFAULT_OWNER_SCOPE) {
    const legacy = await fetchSettingsRow();
    if (legacy) return legacy;
  }

  const full = {
    [SCOPE_COLUMN]: scope,
    telegram_username: username || null,
    full_name: fullName || null,
    chat_id: String(chatId || '') || null,
    bot_enabled: false,
    is_running: false,
    bot_running: false,
    demo_bot_running: false,
    live_bot_running: false,
    trading_mode: 'virtual',
    mode: 'DEMO',
    virtual_balance: DEMO_START_BALANCE,
    amount_per_trade: 10,
    take_profit_pct: 2.4,
    zero_loss_mode: true,
    zero_loss_shield: true,
    sell_only_in_profit: true,
    dca_enabled: true,
    dca_step_pct: 1.5,
    dca_max_buys: 12,
    max_open_trades: 5,
    max_amount_per_pair: 500,
    daily_loss_limit: 150,
    telegram_enabled: true,
    enabled_pairs: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'],
  };

  let { data, error } = await supabase.from('settings').insert(full).select('*').maybeSingle();
  if (error && isMissingColumnError(error)) {
    // Pre-upgrade project: keep the identity + chat so commands still work.
    const minimal = {
      [SCOPE_COLUMN]: scope,
      chat_id: String(chatId || '') || null,
      bot_enabled: false,
    };
    ({ data, error } = await supabase.from('settings').insert(minimal).select('*').maybeSingle());
  }
  if (error) {
    console.warn('[USERS] could not create workspace:', error.message);
    return null;
  }
  console.log(`[USERS] Provisioned workspace ${scope} (${fullName || username || 'new trader'}).`);
  return data || null;
}

/** Pre-accounts project: scoped settings rows, else the legacy single row. */
async function legacyWorkspaceRows() {
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .not(SCOPE_COLUMN, 'is', null);
  if (error) {
    if (isMissingColumnError(error) || isMissingTableError(error)) {
      const legacy = await fetchSettingsRow();
      return legacy ? [legacy] : [];
    }
    console.warn('[USERS] could not list workspaces:', error.message);
    return [];
  }
  const rows = (data || []).filter((row) => scopeOf(row));
  if (rows.length > 0) return rows;
  const legacy = await fetchSettingsRow();
  return legacy ? [legacy] : [];
}

/**
 * Approved accounts only — the approval gate for the 24/7 engine. Each one is
 * mapped to its own `u:<uuid>` settings workspace.
 */
async function fetchWorkspaceRows() {
  const accounts = await fetchApprovedAccounts();
  if (accounts === null) return legacyWorkspaceRows();
  const rows = [];
  for (const account of accounts) {
    const row = await ensureWorkspaceForAccount(account);
    if (row) rows.push(row);
  }
  return rows;
}

function isWorkspaceRunning(row) {
  if (!row) return false;
  // Once the per-mode switches exist they are authoritative: both OFF means the
  // workspace is idle even if a legacy aggregate column still says otherwise.
  const hasModeFlags =
    (row.demo_bot_running !== undefined && row.demo_bot_running !== null) ||
    (row.live_bot_running !== undefined && row.live_bot_running !== null);
  if (hasModeFlags) return Boolean(row.demo_bot_running) || Boolean(row.live_bot_running);
  const flag = row?.is_running ?? row?.bot_running ?? row?.engine_running;
  return flag === null || flag === undefined ? Boolean(row?.bot_enabled) : Boolean(flag);
}

/** Mirrors the two independent power switches onto the account row. */
async function mirrorAccountRunState(scope, demoRunning, liveRunning) {
  const accountId = accountIdFromScope(scope);
  if (!accountId) return;
  const payload = {
    bot_running: Boolean(demoRunning || liveRunning),
    demo_bot_running: Boolean(demoRunning),
    live_bot_running: Boolean(liveRunning),
  };
  let { error } = await supabase.from(USERS_TABLE).update(payload).eq('id', accountId);
  if (error && isMissingColumnError(error)) {
    // Pre-migration project: keep the legacy aggregate in step.
    ({ error } = await supabase
      .from(USERS_TABLE)
      .update({ bot_running: payload.bot_running })
      .eq('id', accountId));
  }
  if (error && !isMissingTableError(error)) {
    console.warn('[USERS] run-state mirror failed:', error.message);
  }
}

/**
 * Trades are always scoped to the owning workspace. Older schemas without the
 * column degrade to the legacy global view instead of silently returning zero.
 */
async function queryTrades(scope, { status, pair, since } = {}) {
  const run = async (scoped) => {
    let q = supabase.from('trades').select('*');
    if (status) q = q.eq('status', status);
    if (pair) q = q.eq('pair', pair);
    if (since) q = q.gte('closed_at', since);
    if (scoped && scope) q = q.eq(SCOPE_COLUMN, scope);
    return q;
  };
  let res = await run(Boolean(scope));
  if (res.error && isMissingColumnError(res.error)) res = await run(false);
  return res;
}

/**
 * Recomputes this user's PnL counters plus the `open_positions` / `trade_history`
 * JSON snapshots kept on their own settings row (used by /pnl and the web UI).
 */
async function refreshUserStats(cfg) {
  if (!cfg?.id) return;
  const { data, error } = await queryTrades(cfg.scope, { status: 'CLOSED' });
  if (error || !Array.isArray(data)) return;
  const total = data.length;
  const wins = data.filter((row) => Number(row.profit_usdt || 0) > 0).length;
  const realized = Number(
    data.reduce((sum, row) => sum + Number(row.profit_usdt || 0), 0).toFixed(2)
  );

  const { data: openRows } = await queryTrades(cfg.scope, { status: 'OPEN' });
  const openPositions = (openRows || [])
    .filter((row) => tradeModeOf(row) === cfg.mode)
    .map((row) => ({
      pair: row.pair,
      quantity: Number(row.quantity || 0),
      entry_price: Number(row.entry_price || 0),
      invested_usdt: Number(row.invested_usdt || 0),
      profit_usdt: Number(row.profit_usdt || 0),
      opened_at: row.opened_at,
    }));
  const tradeHistory = data.slice(-50).map((row) => ({
    pair: row.pair,
    exit_price: Number(row.exit_price || 0),
    invested_usdt: Number(row.invested_usdt || 0),
    profit_usdt: Number(row.profit_usdt || 0),
    closed_at: row.closed_at,
  }));

  const { error: upErr } = await supabase
    .from('settings')
    .update({
      realized_pnl_usd: realized,
      total_trades: total,
      win_trades: wins,
      open_positions: openPositions,
      trade_history: tradeHistory,
    })
    .eq('id', cfg.id);
  if (upErr && !isMissingColumnError(upErr)) {
    console.warn('[USERS] stats sync failed:', upErr.message);
  }

  // Mirror the same numbers onto the account row the admin panel and
  // leaderboard read, so both channels always agree.
  const accountId = accountIdFromScope(cfg.scope);
  if (accountId) {
    const { error: accountErr } = await supabase
      .from(USERS_TABLE)
      .update({
        realized_pnl_usd: realized,
        total_trades: total,
        win_trades: wins,
        open_positions: openPositions,
        trade_history: tradeHistory,
        bot_running: Boolean(cfg.demoRunning || cfg.liveRunning),
        demo_bot_running: Boolean(cfg.demoRunning),
        live_bot_running: Boolean(cfg.liveRunning),
        trading_mode: cfg.mode === 'live' ? 'LIVE' : 'VIRTUAL',
      })
      .eq('id', accountId);
    if (accountErr && isMissingColumnError(accountErr)) {
      await supabase
        .from(USERS_TABLE)
        .update({ bot_running: Boolean(cfg.demoRunning || cfg.liveRunning) })
        .eq('id', accountId);
    } else if (accountErr && !isMissingTableError(accountErr)) {
      console.warn('[USERS] account mirror failed:', accountErr.message);
    }
  }
}

/** Ranked, key-free leaderboard rows shared by Telegram and the web terminal. */
async function buildLeaderboardRows() {
  // Accounts are the public leaderboard source: aggregates only, never keys.
  const { data: accounts, error: accountsErr } = await supabase
    .from(USERS_TABLE)
    .select(
      'id,email,full_name,telegram_username,trading_mode,approval_status,realized_pnl_usd,total_trades,win_trades,bot_running'
    )
    .eq('approval_status', 'approved');
  if (!accountsErr && Array.isArray(accounts)) {
    return accounts
      .map((account) => {
        const trades = Number(account.total_trades || 0);
        const wins = Number(account.win_trades || 0);
        const pnlUsd = Number(Number(account.realized_pnl_usd || 0).toFixed(2));
        return {
          telegram_user_id: scopeForAccount(account.id),
          name: String(account.full_name || account.email || 'Trader'),
          avatar_url: account.avatar_url || null,
          username:
            String(account.telegram_username || '').replace(/^@/, '') || null,
          mode: String(account.trading_mode || '').toUpperCase() === 'LIVE' ? 'LIVE' : 'DEMO',
          running: Boolean(account.bot_running),
          trades,
          wins,
          win_rate: trades > 0 ? Number(((wins / trades) * 100).toFixed(1)) : 0,
          pnl_usd: pnlUsd,
          pnl_bdt: Math.round(pnlUsd * BDT_PER_USD),
        };
      })
      .sort((a, b) => b.pnl_usd - a.pnl_usd);
  }

  const { data: users, error: usersErr } = await supabase
    .from('settings')
    .select('*')
    .not(SCOPE_COLUMN, 'is', null);
  if (usersErr) {
    if (!isMissingColumnError(usersErr) && !isMissingTableError(usersErr)) {
      console.warn('[LEADERBOARD] users read failed:', usersErr.message);
    }
    return [];
  }
  const scopedUsers = (users || []).filter((row) => scopeOf(row));
  if (scopedUsers.length === 0) return [];

  const { data: closed, error: closedErr } = await supabase
    .from('trades')
    .select(`${SCOPE_COLUMN},profit_usdt,status`)
    .eq('status', 'CLOSED');
  const stats = new Map();
  if (!closedErr && Array.isArray(closed)) {
    for (const row of closed) {
      const scope = String(row[SCOPE_COLUMN] || '').trim();
      if (!scope) continue;
      const entry = stats.get(scope) || { pnl: 0, wins: 0, trades: 0 };
      const pnl = Number(row.profit_usdt || 0);
      entry.pnl += pnl;
      entry.trades += 1;
      if (pnl > 0) entry.wins += 1;
      stats.set(scope, entry);
    }
  }

  return scopedUsers
    .map((row) => {
      const scope = scopeOf(row);
      const stored = stats.get(scope);
      const trades = stored ? stored.trades : Number(row.total_trades || 0);
      const wins = stored ? stored.wins : Number(row.win_trades || 0);
      const pnlUsd = Number((stored ? stored.pnl : Number(row.realized_pnl_usd || 0)).toFixed(2));
      return {
        telegram_user_id: scope,
        name: userLabel(row),
        avatar_url: row.avatar_url || null,
        username: String(row.telegram_username || '').replace(/^@/, '') || null,
        mode: settingsModeLabel(row) === 'LIVE' ? 'LIVE' : 'DEMO',
        running: isWorkspaceRunning(row),
        trades,
        wins,
        win_rate: trades > 0 ? Number(((wins / trades) * 100).toFixed(1)) : 0,
        pnl_usd: pnlUsd,
        pnl_bdt: Math.round(pnlUsd * BDT_PER_USD),
        open_positions: Number(row.open_positions_count || 0),
      };
    })
    .sort((a, b) => b.pnl_usd - a.pnl_usd);
}

/** `/pnl` payload: realized USD + BDT, win rate, closed trades, live open PnL. */
async function buildPersonalPnlMessage(settings) {
  const cfg = await buildUserCfg(settings);
  const [{ data: closedRows }, { data: openRows }] = await Promise.all([
    queryTrades(cfg.scope, { status: 'CLOSED' }),
    queryTrades(cfg.scope, { status: 'OPEN' }),
  ]);
  const closed = closedRows || [];
  const open = openRows || [];
  const total = closed.length;
  const wins = closed.filter((row) => Number(row.profit_usdt || 0) > 0).length;
  const losses = Math.max(0, total - wins);
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const realized = closed.reduce((sum, row) => sum + Number(row.profit_usdt || 0), 0);
  const openPnl = open.reduce((sum, row) => sum + Number(row.profit_usdt || 0), 0);
  const openInvested = open.reduce((sum, row) => sum + Number(row.invested_usdt || 0), 0);

  let balance = readVirtualBalance(settings);
  const mode = MODE_LABEL[cfg.mode];
  if (cfg.mode === 'live' && cfg.hasCredentials) {
    try {
      const portfolio = await fetchBinancePortfolioUsdt(cfg.apiKey, cfg.apiSecret, cfg.useTestnet);
      if (portfolio) balance = portfolio.total;
    } catch {
      /* keep the last stored balance */
    }
  }

  const sign = (n) => (n >= 0 ? '+' : '-');
  return [
    '💰 <b>PERSONAL PROFIT &amp; LOSS</b>',
    `👤 ${userLabel(settings)} · Workspace <b>${mode}</b>`,
    '',
    `📈 Realized PnL: <b>${sign(realized)}$${Math.abs(realized).toFixed(2)}</b> · ৳${Math.abs(
      Math.round(realized * BDT_PER_USD)
    ).toLocaleString('en-US')}`,
    `🎯 Win rate: <b>${winRate.toFixed(1)}%</b> (${wins}W / ${losses}L)`,
    `🧾 Closed trades: <b>${total}</b>`,
    `📂 Open positions: <b>${open.length}</b> · ${money(openInvested)} deployed`,
    `↕️ Open PnL: <b>${sign(openPnl)}$${Math.abs(openPnl).toFixed(2)}</b>`,
    `🏦 Balance: <b>${money(balance)}</b> (৳${Math.round(balance * BDT_PER_USD).toLocaleString('en-US')})`,
    '',
    'Send /leaderboard to see every trader\'s net PnL.',
  ].join('\n');
}

async function resolveTelegramBridge() {
  if (TELEGRAM_BOT_TOKEN) {
    // Chat routing is always per workspace; the bridge only supplies the bot token.
    return { token: TELEGRAM_BOT_TOKEN, chatId: '' };
  }
  if (telegramBridgeCache?.token) return telegramBridgeCache;
  const settings = await fetchSettingsRow();
  telegramBridgeCache = {
    token: (settings?.telegram_bot_token || settings?.bot_token || '').trim(),
    chatId: String(settings?.telegram_chat_id || settings?.chat_id || '').trim(),
  };
  return telegramBridgeCache;
}

async function telegramApiCall(token, method, payload, timeoutMs) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs || 30_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && data?.ok !== false, data };
}

/**
 * Writes a settings patch, degrading to per-column writes when the Supabase
 * schema predates some canonical columns (`engine_running`, `workspace_mode`).
 */
async function updateSettingsWithFallback(settingsId, patch) {
  const full = await supabase.from('settings').update(patch).eq('id', settingsId);
  if (!full.error) return { ok: true, applied: Object.keys(patch), skipped: [] };
  if (!isMissingColumnError(full.error)) {
    return { ok: false, applied: [], skipped: [], error: full.error.message };
  }

  const applied = [];
  const skipped = [];
  for (const [column, value] of Object.entries(patch)) {
    const { error } = await supabase
      .from('settings')
      .update({ [column]: value })
      .eq('id', settingsId);
    if (error) skipped.push(column);
    else applied.push(column);
  }
  return { ok: applied.length > 0, applied, skipped };
}

function settingsModeLabel(settings) {
  const raw = String(
    settings?.workspace_mode ?? settings?.trading_mode ?? settings?.mode ?? 'live'
  )
    .trim()
    .toLowerCase();
  return raw === 'live' || raw === 'real' ? 'LIVE' : 'VIRTUAL';
}

async function handleTelegramCommand(rawText, token, chatId, operatorName, userSettings = null) {
  const command = String(rawText || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/@[a-z0-9_]+$/i, '');

  // Every command runs against the caller's own workspace only.
  const settings = userSettings || (await ensureUserProfile({ telegramId: '', chatId, fullName: operatorName }));
  if (!settings) {
    await sendTelegram('⚠️ Aegis Quant: could not load your workspace — command ignored.', token, chatId);
    return;
  }

  switch (command) {
    case '/start':
    case '/help': {
      await sendTelegram(
        [
          '<b>🛡️ AEGIS QUANT — COMMAND MENU</b>',
          '',
          '/pnl — your realized profit &amp; loss (USD + BDT)',
          '/leaderboard — community profit rankings',
          '/balance — live Spot USDT + virtual demo balance',
          '/status — engine state, workspace mode, open positions',
          '/start_bot — start the 24/7 engine (LIVE or VIRTUAL)',
          '/stop_bot — pause trading immediately',
          '/mode_live — switch the workspace to LIVE Binance Spot',
          '/mode_demo — switch the workspace to VIRTUAL demo',
          '',
          `Trader: <b>${operatorName}</b> · Workspace ${settingsModeLabel(settings)}`,
        ].join('\n'),
        token,
        chatId,
        { replyMarkup: TELEGRAM_FINANCE_MARKUP }
      );
      return;
    }

    case '/pnl': {
      await sendTelegram(await buildPersonalPnlMessage(settings), token, chatId, {
        replyMarkup: TELEGRAM_FINANCE_MARKUP,
      });
      try {
        await refreshUserStats(await buildUserCfg(settings));
      } catch {
        /* counters are a convenience, never a blocker */
      }
      return;
    }

    case '/leaderboard': {
      const rows = await buildLeaderboardRows();
      await sendTelegram(
        buildLeaderboardText(rows, userScopeOf(settings)),
        token,
        chatId,
        { replyMarkup: TELEGRAM_FINANCE_MARKUP }
      );
      return;
    }

    case '/balance': {
      const cfg = await buildUserCfg(settings);
      const apiKey = cfg.apiKey;
      const apiSecret = cfg.apiSecret;
      const useTestnet = cfg.useTestnet;
      let liveSpot = Number(settings.balance_usdt || 0);
      let note = '';
      if (apiKey && apiSecret) {
        try {
          const portfolio = await fetchBinancePortfolioUsdt(apiKey, apiSecret, useTestnet);
          if (portfolio) {
            liveSpot = portfolio.spot;
            note = `\n<i>Spot $${portfolio.spot.toFixed(2)} · Funding $${portfolio.funding.toFixed(2)} · Earn $${portfolio.earn.toFixed(2)}</i>`;
          } else {
            note = '\n<i>Binance balance unavailable — check API keys and server IP access.</i>';
          }
        } catch (err) {
          note = `\n<i>Binance balance unavailable: ${err.message}</i>`;
        }
      } else {
        note = '\n<i>No Binance API keys linked.</i>';
      }
      const virtualBalance = readVirtualBalance(settings);
      await sendTelegram(
        [
          '💰 <b>ACCOUNT BALANCES</b>',
          `• Live Spot USDT: $${Number(liveSpot || 0).toFixed(2)}`,
          `• Virtual Demo USDT: $${Number(virtualBalance || 0).toFixed(2)}`,
          note,
        ].join('\n'),
        token,
        chatId
      );
      return;
    }

    case '/status': {
      const engineRunning = isWorkspaceRunning(settings);
      const modeLabel = settingsModeLabel(settings);
      const { data: openRows, error: openErr } = await queryTrades(userScopeOf(settings), {
        status: 'OPEN',
      });
      const openCount = openErr
        ? 0
        : (openRows || []).filter(
            (row) => tradeModeOf(row) === (modeLabel === 'LIVE' ? 'live' : 'virtual')
          ).length;
      const lastCycle = settings.last_heartbeat
        ? new Date(settings.last_heartbeat).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
        : 'never';
      const guardSummary = describeCrashGuards();
      await sendTelegram(
        [
          '📊 <b>AEGIS QUANT STATUS</b>',
          `• Engine: <b>${engineRunning ? 'RUNNING' : 'STOPPED'}</b>`,
          `• Workspace mode: <b>${modeLabel}</b>`,
          `• Open positions: <b>${openCount}</b>`,
          `• Last cycle: ${lastCycle}`,
          `• Crash Guard: <b>${
            guardSummary.length > 0
              ? `ACTIVE (${guardSummary.map((g) => g.symbol).join(', ')})`
              : 'clear'
          }</b>`,
        ].join('\n'),
        token,
        chatId,
        {
          replyMarkup: {
            inline_keyboard: [
              [{ text: '📊 Open Terminal', web_app: { url: TELEGRAM_MINI_APP_URL } }],
              [TELEGRAM_STATUS_BUTTON],
            ],
          },
        }
      );
      return;
    }

    case '/start_bot': {
      const modeLabel = settingsModeLabel(settings);
      const isLive = modeLabel === 'LIVE';
      // Only this mode's own switch flips — the other engine keeps its state.
      const result = await updateSettingsWithFallback(settings.id, {
        [isLive ? 'live_bot_running' : 'demo_bot_running']: true,
        engine_running: true,
        is_running: true,
        bot_running: true,
        bot_enabled: true,
      });
      if (!result.ok) {
        await sendTelegram(
          `⚠️ Could not start the engine: ${result.error || 'no writable settings column'}.`,
          token,
          chatId
        );
        return;
      }
      await appendLog('INFO', `[TELEGRAM] Engine STARTED by ${operatorName} (Mode: ${modeLabel}).`);
      await sendTelegram(
        `✅ <b>Aegis Quant Engine STARTED</b> (Mode: ${modeLabel}).`,
        token,
        chatId
      );
      return;
    }

    case '/stop_bot': {
      const isLive = settingsModeLabel(settings) === 'LIVE';
      // Pausing VIRTUAL must leave the LIVE engine untouched (and vice versa).
      const flags = resolveTradingConfig(settings);
      const otherRunning = isLive ? flags.demoRunning : flags.liveRunning;
      const result = await updateSettingsWithFallback(settings.id, {
        [isLive ? 'live_bot_running' : 'demo_bot_running']: false,
        engine_running: otherRunning,
        is_running: otherRunning,
        bot_running: otherRunning,
        bot_enabled: otherRunning,
      });
      if (!result.ok) {
        await sendTelegram(
          `⚠️ Could not stop the engine: ${result.error || 'no writable settings column'}.`,
          token,
          chatId
        );
        return;
      }
      await appendLog('INFO', `[TELEGRAM] Engine STOPPED by ${operatorName}.`);
      await sendTelegram('🛑 <b>Aegis Quant Engine STOPPED.</b>', token, chatId);
      return;
    }

    case '/mode_live':
    case '/mode_demo': {
      const nextMode = command === '/mode_live' ? 'live' : 'virtual';
      const modeLabel = nextMode === 'live' ? 'LIVE' : 'VIRTUAL';
      const result = await updateSettingsWithFallback(settings.id, {
        workspace_mode: nextMode,
        trading_mode: nextMode,
        mode: nextMode,
      });
      if (!result.ok) {
        await sendTelegram(
          `⚠️ Could not switch workspace: ${result.error || 'no writable settings column'}.`,
          token,
          chatId
        );
        return;
      }
      await appendLog('INFO', `[TELEGRAM] Workspace switched to ${modeLabel} by ${operatorName}.`);
      await sendTelegram(
        `✅ <b>Workspace switched to ${modeLabel}</b>${
          nextMode === 'live' ? ' — Binance Spot (real money).' : ' — paper demo engine.'
        }`,
        token,
        chatId
      );
      return;
    }

    default:
      if (command.startsWith('/')) {
        await sendTelegram(
          `Unknown command: <code>${command}</code>\nSend /help to see the menu.`,
          token,
          chatId
        );
      }
  }
}

/* ------------------------------------------------------------------------- *
 * Inline callback actions: one-tap close + instant live status
 * ------------------------------------------------------------------------- */

async function buildLiveStatusMessage(cfg, settings) {
  const { data: openRows } = await queryTrades(cfg.scope, { status: 'OPEN' });
  const positions = (openRows || []).filter((row) => tradeModeOf(row) === cfg.mode);
  const openPnl = positions.reduce((sum, row) => sum + Number(row.profit_usdt || 0), 0);
  const invested = positions.reduce((sum, row) => sum + Number(row.invested_usdt || 0), 0);
  const guards = describeCrashGuards();

  let balance = readVirtualBalance(settings);
  if (cfg.mode === 'live' && cfg.hasCredentials) {
    try {
      const portfolio = await fetchBinancePortfolioUsdt(cfg.apiKey, cfg.apiSecret, cfg.useTestnet);
      if (portfolio) balance = portfolio.total;
    } catch {
      /* keep the last stored balance */
    }
  }

  const lines = [
    '📈 <b>AEGIS LIVE SNAPSHOT</b>',
    `🎛 Workspace: <b>${MODE_LABEL[cfg.mode]}</b> · Engine ${cfg.isRunning ? '🟢 RUNNING' : '⚪ STOPPED'}`,
    `🏦 Balance: <b>${money(balance)}</b>`,
    `📂 Open: <b>${positions.length}</b> position(s) · ${money(invested)} deployed · ${
      openPnl >= 0 ? '+' : ''
    }${money(openPnl)} unrealized`,
    `🛡️ Crash Guard: <b>${
      guards.length > 0 ? `ACTIVE — ${guards.map((g) => `${g.symbol} ${g.dropPct}%`).join(', ')}` : 'clear'
    }</b>`,
  ];
  if (positions.length > 0) {
    lines.push('', '<b>POSITIONS</b>');
    for (const row of positions.slice(0, 8)) {
      const pnl = Number(row.profit_usdt || 0);
      lines.push(
        `• ${row.pair}: ${money(row.invested_usdt)} @ $${Number(row.entry_price).toFixed(
          4
        )} → $${Number(row.current_price || row.entry_price).toFixed(4)} (${
          pnl >= 0 ? '+' : ''
        }${pnl.toFixed(2)})`
      );
    }
  } else {
    lines.push('', '<i>No open positions in this workspace.</i>');
  }
  lines.push(`🕒 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  return lines.join('\n');
}

/**
 * Closes every open position of `symbol` in the active workspace straight from
 * the Telegram keyboard: LIVE sells the real Spot quantity first, DEMO settles
 * the paper P&L. Replies with the realized result (and the PnL card on profit).
 */
async function closeSymbolFromTelegram(symbol, cfg, token, chatId, settings = null) {
  const { data: openRows, error: openErr } = await queryTrades(cfg.scope, {
    status: 'OPEN',
    pair: symbol,
  });
  if (openErr) {
    await sendTelegram(`⚠️ Could not read open ${symbol} positions: ${openErr.message}`, token, chatId);
    return;
  }
  const positions = (openRows || []).filter((row) => tradeModeOf(row) === cfg.mode);
  if (positions.length === 0) {
    await sendTelegram(
      `ℹ️ No open <b>${symbol}</b> position in the ${MODE_LABEL[cfg.mode]} workspace.`,
      token,
      chatId,
      { replyMarkup: tradeAlertMarkup(symbol) }
    );
    return;
  }

  let livePx = Number(positions[0].current_price || positions[0].entry_price || 0);
  try {
    const prices = await fetchBinancePrices([symbol], cfg.useTestnet);
    if (prices[symbol]) livePx = Number(prices[symbol]);
  } catch (err) {
    console.warn('[TELEGRAM CLOSE] live price unavailable:', err.message);
  }

  const closedAt = new Date().toISOString();
  let closed = 0;
  let realized = 0;
  let invested = 0;
  let failed = null;

  for (const tr of positions) {
    if (cfg.mode === 'live') {
      try {
        await placeBinanceMarketOrder(
          symbol,
          'SELL',
          0,
          Number(tr.quantity),
          cfg.apiKey,
          cfg.apiSecret,
          cfg.useTestnet
        );
      } catch (sellErr) {
        failed = sellErr.message;
        continue;
      }
    }
    const pnl = Number(((livePx - Number(tr.entry_price)) * Number(tr.quantity || 0)).toFixed(2));
    const { error: closeErr } = await supabase
      .from('trades')
      .update({ status: 'CLOSED', exit_price: livePx, profit_usdt: pnl, closed_at: closedAt })
      .eq('id', tr.id);
    if (closeErr) {
      failed = closeErr.message;
      continue;
    }
    closed += 1;
    realized += pnl;
    invested += Number(tr.invested_usdt || 0);
  }

  if (closed === 0) {
    await sendTelegram(
      `⚠️ Could not close <b>${symbol}</b>: ${failed || 'unknown error'}. Position left open.`,
      token,
      chatId,
      { replyMarkup: tradeAlertMarkup(symbol) }
    );
    return;
  }

  if (cfg.mode === 'virtual') {
    const row = settings || (await fetchUserSettings(cfg.scope)) || {};
    const balance = readVirtualBalance(row);
    await writeVirtualBalance(cfg.id, balance + invested + realized, cfg);
  }
  // Keep this trader's P&L / win-rate counters current for the leaderboard.
  await refreshUserStats(cfg);

  const avgEntry =
    invested > 0
      ? positions.reduce((sum, tr) => sum + Number(tr.entry_price) * Number(tr.quantity || 0), 0) /
        Math.max(
          1e-12,
          positions.reduce((sum, tr) => sum + Number(tr.quantity || 0), 0)
        )
      : Number(positions[0].entry_price || 0);
  const roiPct = invested > 0 ? (realized / invested) * 100 : 0;

  await appendLog(
    'TRADE',
    `[${MODE_LABEL[cfg.mode]}] TELEGRAM CLOSE ${symbol} (${closed} orders) @ $${livePx} | Realized ${
      realized >= 0 ? '+' : ''
    }$${realized.toFixed(2)} (${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(2)}%)`,
    symbol
  );

  await sendTelegram(
    [
      `🛑 <b>${symbol} CLOSED FROM TELEGRAM</b>`,
      `Orders closed: <b>${closed}</b> · Workspace: <b>${MODE_LABEL[cfg.mode]}</b>`,
      `Exit: $${livePx.toFixed(4)} · Avg entry: $${avgEntry.toFixed(4)}`,
      `Realized PnL: <b>${realized >= 0 ? '+' : ''}$${realized.toFixed(2)} USDT</b> (${
        roiPct >= 0 ? '+' : ''
      }${roiPct.toFixed(2)}%)`,
      failed ? `\n⚠️ Some orders could not close: ${failed}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    token,
    chatId,
    { replyMarkup: tradeAlertMarkup(symbol) }
  );

  if (realized > 0) {
    await sendPnlCard(cfg, {
      symbol,
      pnlUsdt: realized,
      pnlPct: roiPct,
      entryPrice: avgEntry,
      exitPrice: livePx,
    });
  }
}

async function handleTelegramCallback(callbackQuery, token) {
  const id = String(callbackQuery?.id || '');
  const data = String(callbackQuery?.data || '');
  const from = callbackQuery?.from || {};
  const incomingChatId = String(callbackQuery?.message?.chat?.id ?? '').trim();

  /* ---- Admin approval buttons: the only privileged callback actions ---- */
  if (data.startsWith('approve_user:') || data.startsWith('reject_user:')) {
    const decision = data.startsWith('approve_user:') ? 'approve' : 'reject';
    const targetId = data.slice(data.indexOf(':') + 1).trim();
    if (!(await isAdminActor(from))) {
      await answerCallbackQuery(token, id, 'Admins only', true);
      return;
    }
    const actor = from.username ? `@${from.username}` : String(from.id || 'admin');
    const result = await applyApproval(targetId, decision, actor);
    await answerCallbackQuery(
      token,
      id,
      result.ok
        ? `${decision === 'approve' ? '✅ Approved' : '❌ Rejected'}: ${result.user?.email || targetId}`
        : result.error || 'Action failed',
      !result.ok
    );
    const adminChat = await resolveAdminChatId();
    if (result.ok && adminChat) {
      await sendTelegram(
        `${decision === 'approve' ? '✅' : '❌'} <b>${result.user?.email || targetId}</b> ${
          result.status
        } by ${actor}.`,
        token,
        adminChat,
        { replyMarkup: null }
      );
    }
    return;
  }

  // The tap belongs to whoever pressed it — resolve THEIR approved account.
  const account = await fetchAccountByChat(incomingChatId);
  if (!account) {
    await answerCallbackQuery(token, id, 'Register in the Mini App first', true);
    return;
  }
  if (account.approval_status !== 'approved') {
    await answerCallbackQuery(token, id, `Account ${account.approval_status} — awaiting admin approval`, true);
    return;
  }
  const settings = await ensureWorkspaceForAccount(account);
  if (!settings) {
    await answerCallbackQuery(token, id, 'Workspace not found', true);
    return;
  }
  const cfg = await buildUserCfg(settings);
  // The tapper's own chat only — never a chat copied from another workspace row.
  cfg.telegramChatId = String(account.telegram_chat_id || incomingChatId);
  const chatId = cfg.telegramChatId;
  if (!chatId) {
    await answerCallbackQuery(token, id, 'No private chat linked to this workspace', true);
    return;
  }

  if (data === 'pnl') {
    await answerCallbackQuery(token, id, 'Building your P&L report…');
    await sendTelegram(await buildPersonalPnlMessage(settings), token, chatId, {
      replyMarkup: TELEGRAM_FINANCE_MARKUP,
    });
    return;
  }

  if (data === 'leaderboard') {
    await answerCallbackQuery(token, id, 'Loading leaderboard…');
    await sendTelegram(
      buildLeaderboardText(await buildLeaderboardRows(), userScopeOf(settings)),
      token,
      chatId,
      { replyMarkup: TELEGRAM_FINANCE_MARKUP }
    );
    return;
  }

  if (data === 'refresh_status') {
    await answerCallbackQuery(token, id, 'Refreshing live snapshot…');
    await sendTelegram(
      await buildLiveStatusMessage(cfg, settings),
      token,
      chatId,
      { replyMarkup: tradeAlertMarkup(null) }
    );
    return;
  }

  if (data.startsWith('close_symbol:')) {
    const symbol = data.slice('close_symbol:'.length).trim().toUpperCase();
    if (!symbol) {
      await answerCallbackQuery(token, id, 'Missing symbol', true);
      return;
    }
    if (cfg.mode === 'live' && !cfg.hasCredentials) {
      await answerCallbackQuery(token, id, 'Binance API keys missing — cannot close LIVE', true);
      return;
    }
    await answerCallbackQuery(token, id, `Closing ${symbol}…`);
    await closeSymbolFromTelegram(symbol, cfg, token, chatId, settings);
    return;
  }

  await answerCallbackQuery(token, id, 'Unknown action', true);
}

async function pollTelegramUpdates() {
  if (telegramPolling) return;
  telegramPolling = true;
  try {
    const { token } = await resolveTelegramBridge();
    if (!token) return;

    // Skip the backlog once at boot so a restart never replays days-old commands.
    if (!telegramOffsetInitialised) {
      const probe = await telegramApiCall(
        token,
        'getUpdates',
        { offset: -1, limit: 1, timeout: 0 },
        15_000
      );
      const results = Array.isArray(probe.data?.result) ? probe.data.result : [];
      const lastId = Number(results[results.length - 1]?.update_id);
      telegramUpdateOffset = Number.isFinite(lastId) ? lastId + 1 : 0;
      telegramOffsetInitialised = true;
    }

    const { status, data } = await telegramApiCall(
      token,
      'getUpdates',
      {
        offset: telegramUpdateOffset,
        timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
        limit: 20,
        allowed_updates: ['message', 'callback_query'],
      },
      (TELEGRAM_POLL_TIMEOUT_SECONDS + 20) * 1000
    );

    if (status === 409) {
      console.warn('[TELEGRAM BOT] 409 Conflict — another poller is active. Backing off 30s.');
      await sleep(30_000);
      return;
    }
    if (!data?.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      const updateId = Number(update?.update_id);
      if (Number.isFinite(updateId)) {
        telegramUpdateOffset = Math.max(telegramUpdateOffset, updateId + 1);
      }
      const callbackQuery = update?.callback_query;
      if (callbackQuery) {
        console.log(
          `[TELEGRAM BOT] Callback ${callbackQuery.data} from ${callbackQuery?.from?.id} (chat ${callbackQuery?.message?.chat?.id})`
        );
        await handleTelegramCallback(callbackQuery, token);
        continue;
      }

      const message = update?.message;
      const text = String(message?.text || '').trim();
      if (!text) continue;

      const incomingChatId = String(message?.chat?.id ?? '').trim();
      if (!incomingChatId) continue;
      const from = message?.from || {};
      const senderName =
        [from.first_name, from.last_name].filter(Boolean).join(' ') ||
        (from.username ? `@${from.username}` : 'Trader');
      // Approval gate: the sender's chat id must map to an approved account.
      if (!(await accountsEnabled())) {
        // Pre-accounts project: keep the previous auto-provision behaviour.
        const legacySettings = await ensureUserProfile({
          telegramId: from.id ? String(from.id) : '',
          chatId: incomingChatId,
          username: from.username || null,
          fullName: senderName,
        });
        if (!legacySettings) continue;
        await handleTelegramCommand(text, token, incomingChatId, senderName, legacySettings);
        continue;
      }

      const account = await fetchAccountByChat(incomingChatId);
      if (!account) {
        await sendTelegram(registrationPrompt(incomingChatId), token, incomingChatId, {
          replyMarkup: REGISTER_MARKUP,
        });
        continue;
      }
      if (account.approval_status !== 'approved') {
        await sendTelegram(
          [
            account.approval_status === 'rejected'
              ? '❌ <b>ACCOUNT REJECTED</b>'
              : '⏳ <b>ACCOUNT PENDING APPROVAL</b>',
            '',
            `Account: <code>${account.email || 'unknown'}</code>`,
            account.approval_status === 'rejected'
              ? 'Your registration was declined. Contact the administrator.'
              : 'The admin has been notified — you will get a message here the moment access is granted.',
          ].join('\n'),
          token,
          incomingChatId,
          { replyMarkup: REGISTER_MARKUP }
        );
        continue;
      }

      const senderSettings = await ensureWorkspaceForAccount(account);
      if (!senderSettings) {
        console.warn(`[TELEGRAM BOT] No workspace resolved for chat ${incomingChatId} — ignored.`);
        continue;
      }

      console.log(`[TELEGRAM BOT] Command from ${incomingChatId} (${senderName}): ${text}`);
      await handleTelegramCommand(text, token, incomingChatId, senderName, senderSettings);
    }
  } catch (err) {
    const msg = String(err?.message || err);
    if (!msg.toLowerCase().includes('timeout') && !msg.toLowerCase().includes('abort')) {
      console.warn('[TELEGRAM BOT] Poll failed:', msg);
      await sleep(5_000);
    }
  } finally {
    telegramPolling = false;
  }
}

async function startTelegramCommandLoop() {
  const { token } = await resolveTelegramBridge();
  if (!token) {
    console.warn(
      '[TELEGRAM BOT] Command listener idle — TELEGRAM_BOT_TOKEN not configured yet. Retrying in 60s.'
    );
    setTimeout(() => void startTelegramCommandLoop(), 60_000).unref?.();
    return;
  }
  console.log('[TELEGRAM BOT] Command listener online — multi-user long polling on @TaseenMarketBot.');
  for (;;) {
    await pollTelegramUpdates();
    await sleep(1_200);
  }
}

function buildTradeRow({ mode, symbol, price, quantity, notional, tpPct, zeroLoss, stopLossPct }) {
  const id = `${mode === 'virtual' ? 'VDEMO' : 'ORD'}-${Date.now()}-${Math.floor(Math.random() * 999)}`;
  return {
    id,
    pair: symbol,
    side: 'BUY',
    status: 'OPEN',
    entry_price: price,
    current_price: price,
    quantity,
    invested_usdt: Number(notional.toFixed(2)),
    profit_usdt: 0,
    profit_pct: 0,
    take_profit_price: Number(
      (price * (1 + (tpPct + (zeroLoss ? BINANCE_ROUND_TRIP_FEE_PCT : 0)) / 100)).toFixed(4)
    ),
    stop_loss_price: Number((price * (1 - stopLossPct / 100)).toFixed(4)),
    opened_at: new Date().toISOString(),
  };
}

async function insertTradeWithMode(row, mode, scope = null) {
  const payload = { ...row, mode, ...(scope ? { [SCOPE_COLUMN]: scope } : {}) };
  let { error } = await supabase.from('trades').insert(payload);
  if (error && isMissingColumnError(error)) {
    const { mode: _ignored, [SCOPE_COLUMN]: _ignoredScope, ...legacyRow } = payload;
    ({ error } = await supabase.from('trades').insert(legacyRow));
  }
  if (error) {
    console.error(`[TRADE INSERT ERROR] ${error.message}`);
    await appendLog('ERROR', `Could not persist trade ${row.id} (${row.pair}): ${error.message}`, row.pair);
    return false;
  }
  return true;
}

const VIRTUAL_BALANCE_START = 10_000;
// Written in this order; the first column that accepts a write becomes the one we read back.
const VIRTUAL_BALANCE_COLUMNS = ['virtual_balance', 'demo_balance'];
let virtualBalanceColumn = VIRTUAL_BALANCE_COLUMNS[0];
/** Per-workspace in-process balances: one user's paper cash never leaks into another's. */
const virtualBalanceMemory = new Map();
const virtualBalanceHeldInMemory = new Set();

function balanceKey(settingsOrId) {
  const id =
    settingsOrId && typeof settingsOrId === 'object' ? settingsOrId.id : settingsOrId;
  return String(id ?? 'default');
}

function readVirtualBalance(settings) {
  // While no column accepts writes, the in-process balance is the only source of truth,
  // otherwise every cycle would resurrect the stale DB value and restart the paper P&L.
  const key = balanceKey(settings);
  if (virtualBalanceHeldInMemory.has(key) && virtualBalanceMemory.has(key)) {
    return virtualBalanceMemory.get(key);
  }
  const stored = Number(settings?.[virtualBalanceColumn] ?? settings?.virtual_balance ?? settings?.demo_balance);
  if (Number.isFinite(stored)) {
    virtualBalanceMemory.set(key, stored);
    return stored;
  }
  if (virtualBalanceMemory.has(key)) return virtualBalanceMemory.get(key);
  return VIRTUAL_BALANCE_START;
}

async function writeVirtualBalance(settingsId, balance, cfg = null) {
  const value = Math.max(0, Number(balance.toFixed(2)));
  const key = balanceKey(settingsId);
  virtualBalanceMemory.set(key, value);

  let lastError = null;
  for (const column of VIRTUAL_BALANCE_COLUMNS) {
    const { error } = await supabase
      .from('settings')
      .update({ [column]: value })
      .eq('id', settingsId);
    if (!error) {
      if (column !== virtualBalanceColumn) {
        console.warn(`[DEMO BALANCE] Persisting paper balance in settings.${column}.`);
      }
      virtualBalanceColumn = column;
      if (virtualBalanceHeldInMemory.has(key)) {
        virtualBalanceHeldInMemory.delete(key);
        await appendLog('INFO', `[${MODE_LABEL[cfg?.mode] || 'DEMO'}] Paper balance persistence restored — ${money(value)} saved to settings.${column}.`);
      }
      return value;
    }
    lastError = error;
    if (!isMissingColumnError(error)) break;
  }

  const reason = lastError?.message || 'no writable settings column';
  if (!virtualBalanceHeldInMemory.has(key)) {
    virtualBalanceHeldInMemory.add(key);
    console.warn(
      `[DEMO BALANCE] ${reason} — holding paper balance in memory so DEMO trades and P&L keep accumulating.`
    );
  }
  await warnThrottled(
    'virtual-balance-column',
    `DEMO balance could not be saved (${reason}). Holding ${money(value)} in memory so paper trades and P&L keep accumulating — run "alter table public.settings add column if not exists virtual_balance numeric default 10000;" to persist it again.`,
    null,
    cfg
  );
  return value;
}

/**
 * Drives BOTH independent power switches of one workspace. `demo_bot_running` and
 * `live_bot_running` are completely separate: turning VIRTUAL on/off never touches
 * the LIVE engine and vice versa, so each mode gets its own cycle pass.
 */
async function runCycleForUser(settings) {
  const cfg = await buildUserCfg(settings);
  const modes = [];
  if (cfg.demoRunning) modes.push('virtual');
  if (cfg.liveRunning) modes.push('live');
  if (modes.length === 0) {
    // Standby workspace: heartbeat so the terminal shows a live engine clock.
    await supabase
      .from('settings')
      .update({ last_heartbeat: new Date().toISOString() })
      .eq('id', settings.id);
    return;
  }
  for (const mode of modes) {
    await runCycleForUserMode(settings, mode);
  }
}

/**
 * Runs the full trading engine for ONE workspace in ONE mode using that user's own
 * credentials, risk settings and trade history. Nothing is shared across users.
 */
async function runCycleForUserMode(settings, mode) {
  try {
    const cfg = await buildUserCfg(settings);
    cfg.mode = mode;
    cfg.isRunning = mode === 'live' ? cfg.liveRunning : cfg.demoRunning;
    if (!cfg.isRunning) return;
    const label = MODE_LABEL[cfg.mode];

    const heartbeatPatch = { last_heartbeat: new Date().toISOString() };
    let liveSpot = Number(settings.balance_usdt || 0);
    let virtualBalance = readVirtualBalance(settings);

    // 1. Always sync the real Binance balance for the LIVE readout (even on standby).
    if (cfg.hasCredentials) {
      try {
        const portfolio = await fetchBinancePortfolioUsdt(cfg.apiKey, cfg.apiSecret, cfg.useTestnet);
        if (portfolio) {
          liveSpot = portfolio.spot;
          heartbeatPatch.balance_usdt = portfolio.total;
          const balanceKeyId = cfg.scope || 'owner';
          if (lastLoggedBalance.get(balanceKeyId) !== portfolio.total) {
            lastLoggedBalance.set(balanceKeyId, portfolio.total);
            const logMsg = `[BALANCE SYNC] Portfolio $${portfolio.total.toFixed(2)} — Spot $${portfolio.spot.toFixed(2)} (tradeable) · Funding $${portfolio.funding.toFixed(2)} · Earn $${portfolio.earn.toFixed(2)}`;
            console.log(logMsg);
            await appendLog('INFO', logMsg);
          }
        }
      } catch (balErr) {
        console.warn('[BALANCE SYNC WARNING]', balErr.message);
      }
    }

    await supabase.from('settings').update(heartbeatPatch).eq('id', settings.id);

    if (!cfg.isRunning) return; // Standby: heartbeat only, never place orders.

    const { data: openRows } = await queryTrades(cfg.scope, { status: 'OPEN' });
    const activeTrades = (openRows || []).filter((row) => tradeModeOf(row) === cfg.mode);

    const symbolsToFetch = Array.from(
      new Set([...cfg.pairs, ...activeTrades.map((t) => t.pair)].filter(Boolean))
    );
    const prices = await fetchBinancePrices(symbolsToFetch, cfg.useTestnet);

    // Visible heartbeat for the FEED tab: once a minute per workspace, so the user
    // can always see the 24/7 engine scanning instead of a silent cycle.
    const scanKey = `${cfg.scope || 'owner'}:${cfg.mode}`;
    const nowMs = Date.now();
    const shouldLogScan = nowMs - (lastScanLogAt.get(scanKey) || 0) >= 60_000;
    if (shouldLogScan) {
      lastScanLogAt.set(scanKey, nowMs);
      await appendLog(
        'INFO',
        `[${label}] SCANNING ${cfg.pairs.length} pairs (${cfg.pairs.join(', ')}) — ${
          activeTrades.length
        } open trade(s) · balance ${money(
          cfg.mode === 'live' ? liveSpot : virtualBalance
        )} · MTF ${cfg.multiTimeframeFilter ? 'ON' : 'OFF'}`
      );
    }

    // 2. Refresh open-trade PnL for this workspace's positions only.
    for (const tr of activeTrades) {
      const livePx = prices[tr.pair];
      if (!livePx) continue;
      const qty = Number(tr.quantity || 0);
      const profitUsdt = Number(((livePx - Number(tr.entry_price)) * qty).toFixed(2));
      const profitPct = Number(
        ((profitUsdt / Math.max(0.01, Number(tr.invested_usdt))) * 100).toFixed(2)
      );
      // Highest watermark since entry, used by the trailing stop-loss.
      const entryPx = Number(tr.entry_price) || 0;
      const peakPrice = Math.max(Number(tr.peak_price) || 0, entryPx, livePx);
      const pnlPatch = {
        current_price: livePx,
        profit_usdt: profitUsdt,
        profit_pct: profitPct,
        peak_price: peakPrice,
      };
      let { error: pnlError } = await supabase
        .from('trades')
        .update(pnlPatch)
        .eq('id', tr.id);
      if (pnlError && isMissingColumnError(pnlError)) {
        // Pre-upgrade schema: keep PnL live and fall back to entry-only trailing.
        const { peak_price: _ignoredPeak, ...legacyPatch } = pnlPatch;
        ({ error: pnlError } = await supabase
          .from('trades')
          .update(legacyPatch)
          .eq('id', tr.id));
      }
      tr.current_price = livePx;
      tr.profit_usdt = profitUsdt;
      tr.profit_pct = profitPct;
      tr.peak_price = peakPrice;
    }

    // 2.5 Daily max-loss guard (Asia/Dhaka day): pause new risk once the realized loss
    // for the current day reaches daily_max_loss_pct of that day's opening equity.
    let dailyLossBreached = false;
    if (cfg.dailyMaxLossPct > 0) {
      try {
        const { data: closedToday } = await queryTrades(cfg.scope, {
          status: 'CLOSED',
          since: dhakaDayStartUtc().toISOString(),
        });
        const realizedToday = (closedToday || [])
          .filter((row) => tradeModeOf(row) === cfg.mode)
          .reduce((sum, row) => sum + Number(row.profit_usdt || 0), 0);
        const equity = cfg.mode === 'live' ? liveSpot : virtualBalance;
        const dayOpenEquity = Math.max(1, equity - realizedToday);
        const lossPct = realizedToday < 0 ? (Math.abs(realizedToday) / dayOpenEquity) * 100 : 0;
        dailyLossBreached = lossPct >= cfg.dailyMaxLossPct;
        if (dailyLossBreached) {
          await warnThrottled(
            'daily-max-loss',
            `Daily loss guard hit — realized loss ${lossPct.toFixed(2)}% of $${dayOpenEquity.toFixed(
              2
            )} opening equity (limit ${cfg.dailyMaxLossPct}%). New entries paused until 00:00 Asia/Dhaka.`,
            null,
            cfg
          );
        }
      } catch (guardErr) {
        console.warn('[DAILY GUARD WARNING]', guardErr.message);
      }
    }

    // 3. Strategy: batch sell-all (fee-aware zero-loss), DCA re-buy, fresh entries.
    let scannedPairs = 0;
    let enteredTrades = 0;
    let filteredSignals = 0;
    for (const symbol of cfg.pairs) {
      const livePx = prices[symbol];
      if (!livePx) continue;
      scannedPairs += 1;
      const pairOpen = activeTrades.filter((t) => t.pair === symbol);
      // Flash-Crash & Volatility Guard: pause NEW entries and DCA re-buys for a
      // pair that just lost >=4% in five minutes. Exits below still run normally.
      const crashGuard = await checkCrashGuard(symbol, cfg);
      if (crashGuard.blocked) {
        await warnThrottled(
          `crash-guard-${symbol}`,
          `Crash Guard active on ${symbol} (${crashGuard.dropPct.toFixed(
            2
          )}% 5m drop) — entries and DCA re-buys paused for ${crashGuard.minutesRemaining}m.`,
          symbol,
          null
        );
      }

      if (pairOpen.length > 0) {
        const totalInvested = pairOpen.reduce((s, t) => s + Number(t.invested_usdt || 0), 0);
        const totalPnl = pairOpen.reduce((s, t) => s + Number(t.profit_usdt || 0), 0);
        const aggPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
        const estimatedFeesUsdt = totalInvested * (BINANCE_ROUND_TRIP_FEE_PCT / 100);
        const netPnlAfterFees = totalPnl - estimatedFeesUsdt;
        const requiredTpWithFees = cfg.zeroLoss ? cfg.tpPct + BINANCE_ROUND_TRIP_FEE_PCT : cfg.tpPct;

        const takeProfitTriggered =
          aggPct >= requiredTpWithFees && (!cfg.zeroLoss || netPnlAfterFees > 0);
        const stopLossTriggered = cfg.stopLossEnabled && !cfg.zeroLoss && aggPct <= -cfg.stopLossPct;

        // Trailing stop-loss: lock in profit once price retraces trailing_stop_pct from
        // the highest watermark reached since entry.
        const peakPrice = Math.max(
          ...pairOpen.map((t) => Number(t.peak_price) || Number(t.entry_price) || 0)
        );
        const peakAboveEntry = pairOpen.some(
          (t) => (Number(t.peak_price) || 0) > Number(t.entry_price || 0)
        );
        const trailingTriggered =
          cfg.trailingStopPct > 0 &&
          peakAboveEntry &&
          peakPrice > 0 &&
          livePx <= peakPrice * (1 - cfg.trailingStopPct / 100) &&
          netPnlAfterFees > 0;

        if (takeProfitTriggered || stopLossTriggered || trailingTriggered) {
          const closedAt = new Date().toISOString();
          let closedCount = 0;
          for (const tr of pairOpen) {
            if (cfg.mode === 'live') {
              try {
                await placeBinanceMarketOrder(
                  symbol,
                  'SELL',
                  0,
                  Number(tr.quantity),
                  cfg.apiKey,
                  cfg.apiSecret,
                  cfg.useTestnet
                );
              } catch (sellErr) {
                await warnThrottled(
                  `sell-failed-${symbol}`,
                  `LIVE SELL REJECTED ${symbol}: ${sellErr.message} — position kept open, next cycle will retry.`,
                  symbol,
                  cfg
                );
                continue;
              }
            }
            const { error: closeErr } = await supabase
              .from('trades')
              .update({
                status: 'CLOSED',
                exit_price: livePx,
                profit_usdt: Number((livePx - Number(tr.entry_price)) * Number(tr.quantity || 0)),
                closed_at: closedAt,
              })
              .eq('id', tr.id);
            if (closeErr) {
              console.error(`[CLOSE ERROR] ${closeErr.message}`);
              continue;
            }
            closedCount += 1;
          }

          if (closedCount > 0) {
            const proceeds = totalInvested + netPnlAfterFees;
            if (cfg.mode === 'virtual') {
              virtualBalance = await writeVirtualBalance(cfg.id, virtualBalance + proceeds, cfg);
            } else {
              liveSpot = Math.max(0, liveSpot + proceeds);
            }
            const tag = takeProfitTriggered
              ? 'BATCH SELL ALL'
              : trailingTriggered
                ? 'TRAILING STOP EXIT'
                : 'STOP-LOSS EXIT';
            // Every settlement refreshes THIS user's leaderboard counters.
            await refreshUserStats(cfg);
            const msg = `${tag} ${symbol} (${closedCount} orders) @ $${livePx} | Net PnL ${
              netPnlAfterFees >= 0 ? '+' : ''
            }$${netPnlAfterFees.toFixed(2)} (${aggPct >= 0 ? '+' : ''}${aggPct.toFixed(2)}%)`;
            await appendLog('TRADE', `[${label}] ${msg}`, symbol);
            await sendTradeTelegram(cfg, {
              title: tag,
              symbol,
              side: 'SELL',
              price: livePx,
              amountUsd: totalInvested,
              pnlUsdt: netPnlAfterFees,
              pnlPct: aggPct,
              balanceUsd: cfg.mode === 'live' ? liveSpot : virtualBalance,
              note: takeProfitTriggered
                ? cfg.zeroLoss
                  ? 'Zero-Loss Shield: exit cleared the 0.2% round-trip fee.'
                  : undefined
                : trailingTriggered
                  ? `Trailing stop: price fell ${cfg.trailingStopPct}% from the $${peakPrice.toFixed(
                      2
                    )} peak — profit locked in.`
                  : 'Circuit breaker: stop-loss exit executed.',
            });

            // Shareable Binance-style PnL card for every profitable close.
            if (netPnlAfterFees > 0) {
              const totalQty = pairOpen.reduce((sum, t) => sum + Number(t.quantity || 0), 0);
              const avgEntryPx = totalQty > 0 ? totalInvested / totalQty : livePx;
              await sendPnlCard(cfg, {
                symbol,
                pnlUsdt: netPnlAfterFees,
                pnlPct: aggPct,
                entryPrice: avgEntryPx,
                exitPrice: livePx,
              });
            }
          }
          continue;
        }

        // DCA re-buy on a dip below the lowest open entry.
        if (!dailyLossBreached && !crashGuard.blocked && cfg.dcaEnabled && pairOpen.length < cfg.dcaMaxBuys) {
          const lowestEntry = Math.min(...pairOpen.map((t) => Number(t.entry_price)));
          const dropPct = ((lowestEntry - livePx) / lowestEntry) * 100;
          // Auto-compounding sizes every DCA ticket from the current balance too.
          const dcaNotional = resolveEntryNotional(
            cfg,
            cfg.mode === 'live' ? liveSpot : virtualBalance
          );
          if (dropPct >= cfg.dcaStepPct && totalInvested + dcaNotional <= cfg.maxPerPair) {
            let row = null;
            if (cfg.mode === 'live') {
              const buy = await buyWithGuards(
                symbol,
                'DCA',
                dcaNotional,
                livePx,
                cfg.apiKey,
                cfg.apiSecret,
                cfg.useTestnet,
                liveSpot,
                cfg
              );
              if (!buy) continue;
              row = buildTradeRow({
                mode: 'live',
                symbol,
                price: livePx,
                quantity: buy.filledQty,
                notional: buy.notional,
                tpPct: cfg.tpPct,
                zeroLoss: cfg.zeroLoss,
                stopLossPct: cfg.stopLossPct,
              });
              if (!(await insertTradeWithMode(row, 'live', cfg.scope))) continue;
              liveSpot = Math.max(0, liveSpot - buy.notional);
            } else {
              if (virtualBalance < dcaNotional) {
                await warnThrottled(
                  `virtual-funds-${symbol}`,
                  `DEMO ${symbol} DCA skipped — virtual balance ${money(
                    virtualBalance
                  )} is below the ${money(dcaNotional)} lot.`,
                  symbol,
                  cfg
                );
                continue;
              }
              row = buildTradeRow({
                mode: 'virtual',
                symbol,
                price: livePx,
                quantity: Number((dcaNotional / livePx).toFixed(8)),
                notional: dcaNotional,
                tpPct: cfg.tpPct,
                zeroLoss: cfg.zeroLoss,
                stopLossPct: cfg.stopLossPct,
              });
              if (!(await insertTradeWithMode(row, 'virtual', cfg.scope))) continue;
              virtualBalance = await writeVirtualBalance(cfg.id, virtualBalance - dcaNotional, cfg);
            }
            activeTrades.push(row);
            const msg = `DCA RE-BUY #${pairOpen.length + 1} ${symbol} @ $${livePx} (-${dropPct.toFixed(
              2
            )}% dip) | ${money(row.invested_usdt)} USDT`;
            await appendLog('TRADE', `[${label}] ${msg}`, symbol);
            await sendTradeTelegram(cfg, {
              title: `DCA RE-BUY #${pairOpen.length + 1}`,
              symbol,
              side: 'BUY',
              price: livePx,
              amountUsd: row.invested_usdt,
              balanceUsd: cfg.mode === 'live' ? liveSpot : virtualBalance,
              note: `Dip: -${dropPct.toFixed(2)}% vs lowest entry`,
            });
          }
        }
      } else if (!dailyLossBreached && !crashGuard.blocked && activeTrades.length < cfg.maxOpenTrades) {
        if (cfg.mode === 'live' && !cfg.hasCredentials) {
          await warnThrottled(
            'live-missing-keys',
            'LIVE mode is ON but no Binance API key/secret is configured — no orders are sent and no phantom trades are recorded.',
            null,
            cfg
          );
          return;
        }

        let ticker24h = null;
        try {
          ticker24h = await fetchPublicWithFallback(
            `/api/v3/ticker/24hr?symbol=${symbol}`,
            cfg.useTestnet
          );
        } catch {}

        const priceChangePercent = ticker24h ? Number(ticker24h.priceChangePercent || 0) : 0;
        const quoteVolume = ticker24h ? Number(ticker24h.quoteVolume || 0) : 100000;
        // DEMO keeps a relaxed but still liquid signal; LIVE stays conservative.
        const relaxedDemo = cfg.mode === 'virtual';
        const hasHealthyVolume = quoteVolume > (relaxedDemo ? 50_000 : 200_000);
        const favorableMomentum = priceChangePercent > (relaxedDemo ? -8.0 : -5.0);

        if (hasHealthyVolume && favorableMomentum) {
          // Multi-timeframe confirmation: a 1m/5m BUY is vetoed when the 1h trend
          // is not bullish (close > EMA20) with RSI inside the 40-72 buy band.
          if (cfg.multiTimeframeFilter) {
            const trend = await checkHigherTimeframeTrend(symbol, cfg);
            if (!trend.ok) {
              filteredSignals += 1;
              await warnThrottled(
                `mtf-filter-${symbol}`,
                `MTF FILTER skipped ${symbol} entry — ${trend.reason}.`,
                symbol,
                null
              );
              continue;
            }
          }

          // Smart auto-compounding: ticket = compoundAllocationPct% of balance.
          const entryNotional = resolveEntryNotional(
            cfg,
            cfg.mode === 'live' ? liveSpot : virtualBalance
          );
          let row = null;
          if (cfg.mode === 'live') {
            const buy = await buyWithGuards(
              symbol,
              'ENTRY',
              entryNotional,
              livePx,
              cfg.apiKey,
              cfg.apiSecret,
              cfg.useTestnet,
              liveSpot,
              cfg
            );
            if (!buy) continue;
            row = buildTradeRow({
              mode: 'live',
              symbol,
              price: livePx,
              quantity: buy.filledQty,
              notional: buy.notional,
              tpPct: cfg.tpPct,
              zeroLoss: cfg.zeroLoss,
              stopLossPct: cfg.stopLossPct,
            });
            if (!(await insertTradeWithMode(row, 'live', cfg.scope))) continue;
            liveSpot = Math.max(0, liveSpot - buy.notional);
          } else {
            if (virtualBalance < entryNotional) {
              await warnThrottled(
                `virtual-funds-${symbol}`,
                `DEMO ${symbol} entry skipped — virtual balance ${money(
                  virtualBalance
                )} is below the ${money(entryNotional)} lot.`,
                symbol,
                cfg
              );
              continue;
            }
            row = buildTradeRow({
              mode: 'virtual',
              symbol,
              price: livePx,
              quantity: Number((entryNotional / livePx).toFixed(8)),
              notional: entryNotional,
              tpPct: cfg.tpPct,
              zeroLoss: cfg.zeroLoss,
              stopLossPct: cfg.stopLossPct,
            });
            if (!(await insertTradeWithMode(row, 'virtual', cfg.scope))) continue;
            virtualBalance = await writeVirtualBalance(cfg.id, virtualBalance - entryNotional, cfg);
          }

          activeTrades.push(row);
          enteredTrades += 1;
          const msg = `ENTRY BUY ${symbol} @ $${livePx} | ${money(
            row.invested_usdt
          )} USDT | 24h ${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(
            2
          )}% | Vol $${Math.round(quoteVolume).toLocaleString()}`;
          await appendLog('TRADE', `[${label}] ${msg}`, symbol);
          await sendTradeTelegram(cfg, {
            title: cfg.mode === 'live' ? 'ENTRY BUY' : 'PAPER ENTRY BUY',
            symbol,
            side: 'BUY',
            price: livePx,
            amountUsd: row.invested_usdt,
            balanceUsd: cfg.mode === 'live' ? liveSpot : virtualBalance,
            note: `24h ${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}% · ${
              cfg.zeroLoss ? 'Zero-Loss Shield ON' : 'Standard TP/SL'
            }`,
          });
        }
      }
    }

    if (shouldLogScan) {
      await appendLog(
        'INFO',
        `[${label}] Scan complete — ${scannedPairs}/${cfg.pairs.length} pairs priced · ${
          enteredTrades
        } new entr${enteredTrades === 1 ? 'y' : 'ies'} · ${
          filteredSignals
        } signal(s) filtered · ${activeTrades.length} open.`
      );
    }

    // One snapshot per cycle keeps open_positions / trade_history in step with
    // the actual ledger for this user (and powers the web P&L panel).
    await refreshUserStats(cfg);
  } catch (err) {
    console.error('[CYCLE ERROR]', err.message);
    await appendLog(
      'ERROR',
      `Worker cycle error for ${userLabel(settings)} (${MODE_LABEL[mode]}): ${err.message}`
    );
  }
}

let lastActiveWorkspaceCount = -1;

/** Multi-user driver: executes every workspace whose engine is switched ON. */
async function runCycle() {
  try {
    const rows = await fetchWorkspaceRows();
    if (rows.length === 0) return;

    // Standby workspaces still get a heartbeat so their terminal shows a live engine clock.
    const stamp = new Date().toISOString();
    for (const row of rows.filter((r) => !isWorkspaceRunning(r))) {
      await supabase.from('settings').update({ last_heartbeat: stamp }).eq('id', row.id);
      // Keep the account mirror honest for stopped engines too.
      await mirrorAccountRunState(scopeOf(row), false, false);
    }

    const active = rows.filter(isWorkspaceRunning);
    if (active.length !== lastActiveWorkspaceCount) {
      lastActiveWorkspaceCount = active.length;
      console.log(
        `[CYCLE] Executing ${active.length} active workspace(s) out of ${rows.length} registered trader(s).`
      );
    }
    for (const row of active) {
      const flags = resolveTradingConfig(row);
      await mirrorAccountRunState(scopeOf(row), flags.demoRunning, flags.liveRunning);
      try {
        await runCycleForUser(row);
      } catch (err) {
        console.error(`[CYCLE ERROR] workspace ${scopeOf(row) || row.id}:`, err.message);
        await appendLog('ERROR', `Worker cycle error (${userLabel(row)}): ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[CYCLE ERROR]', err.message);
  }
}

async function startWorker() {
  console.log(
    '[AEGIS WORKER] Started — multi-user 24/7 engine. Each telegram_user_id runs with its own mode, keys and risk profile; polling every 15s...'
  );
  await logServerPublicIp();
  await promoteConfiguredAdmin();
  // Registration approvals: notify the admin instantly, then keep watching.
  void notifyAdminOfPendingAccounts();
  setInterval(() => void notifyAdminOfPendingAccounts(), 30_000);
  void startTelegramCommandLoop();
  // Midnight Asia/Dhaka PnL report — checked every minute, sent once per day.
  setInterval(() => void dailyReportLoop(), 60_000);
  await runCycle();
  setInterval(runCycle, 15_000);
}

startWorker();
