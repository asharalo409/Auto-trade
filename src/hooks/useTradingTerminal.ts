import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BDT_PER_USD,
  EQUITY_SERIES,
  INITIAL_BINANCE_CONFIG,
  INITIAL_DEMO_LOGS,
  INITIAL_DEMO_SETTINGS,
  INITIAL_DEMO_TRADES,
  INITIAL_LIVE_LOGS,
  INITIAL_LIVE_SETTINGS,
  INITIAL_MARKET_PAIRS,
  INITIAL_SMART_ALERTS,
  INITIAL_TELEGRAM_CONFIG,
  SUPPORTED_PAIRS,
} from '../data/demoData';
import { audioSynth } from '../lib/audioSynth';
import { fetchBinance24hrTickers, openBinanceStream } from '../lib/binanceMarket';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { dispatchTelegramAlert } from '../lib/telegram';
import { resolveWorkspaceIdentity } from '../lib/userIdentity';
import { MIN_TRADEABLE_USDT } from '../lib/tradeLimits';
import { getTimeBasedTheme } from '../lib/themes';
import {
  balanceSentence,
  buySentence,
  catchUpSentence,
  sellSentence,
  voiceAnnouncer,
} from '../lib/voiceAnnouncer';
import {
  AccountProfile,
  AdminUserRow,
  ApprovalStatus,
  BinanceAccountSummary,
  BinanceConfig,
  BotSettings,
  BotStatus,
  CandleStyle,
  CrashGuardState,
  CoreVisualMode,
  EquityPoint,
  LeaderboardEntry,
  EquityTimeframe,
  LogEntry,
  LogLevel,
  PairMarketData,
  SmartAlert,
  TelegramConfig,
  ThemeId,
  Trade,
  TradingMode,
  UserApiKeyStatus,
  WorkspaceUser,
} from '../types/trading';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || "https://aegis-quant-worker-eu.onrender.com";

const STORAGE_PREFS_KEY = 'aegis_quant_prefs_v2';
const STORAGE_TG_KEY = 'aegis_quant_telegram_v1';
const STORAGE_BN_KEY = 'aegis_quant_binance_v1';
const STORAGE_WORKSPACE_KEY = 'aegis_active_workspace_v1';
const STORAGE_DEMO_SETTINGS_KEY = 'aegis_quant_demo_settings_v3';
const STORAGE_LIVE_SETTINGS_KEY = 'aegis_quant_live_settings_v3';
const STORAGE_DEMO_TRADES_KEY = 'aegis_quant_demo_trades_v3';
const STORAGE_LIVE_TRADES_KEY = 'aegis_quant_live_trades_v3';
const STORAGE_ALERT_PAIRS_KEY = 'aegis_alert_enabled_pairs_v1';

let idSequence = 0;
function createUniqueId(prefix: string, suffix?: string): string {
  idSequence += 1;
  const ts = Date.now().toString(36).toUpperCase();
  const seq = idSequence.toString(36).toUpperCase();
  return suffix ? `${prefix}-${ts}-${seq}-${suffix}` : `${prefix}-${ts}-${seq}`;
}

interface StoredPrefs {
  sound_enabled?: boolean;
  theme?: ThemeId;
  auto_theme_by_time?: boolean;
  zero_loss_mode?: boolean;
  dca_enabled?: boolean;
  dca_step_pct?: number;
  dca_max_buys?: number;
  core_visual?: CoreVisualMode;
  candle_style?: CandleStyle;
}

function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (Array.isArray(fallback)) {
      return (Array.isArray(parsed) ? parsed : fallback) as T;
    }
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

function normalizeSettings(row: Record<string, unknown>, fallback: BotSettings): BotSettings {
  const enabledPairsRaw = row.enabled_pairs;
  let enabled_pairs: string[] = fallback.enabled_pairs;
  if (Array.isArray(enabledPairsRaw)) {
    enabled_pairs = enabledPairsRaw.map(String);
  } else if (typeof enabledPairsRaw === 'string') {
    try {
      const parsed = JSON.parse(enabledPairsRaw);
      if (Array.isArray(parsed)) enabled_pairs = parsed.map(String);
    } catch {
      enabled_pairs = enabledPairsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  const zeroLossResolved = Boolean(
    row.zero_loss_shield ?? row.zero_loss_mode ?? row.sell_only_in_profit ?? fallback.zero_loss_mode
  );

  // `telegram_enabled` is null on rows created before the column existed. The worker
  // treats null as "enabled" (`settings.telegram_enabled !== false`), so the terminal
  // must agree — otherwise it shows MUTED while the server keeps pushing alerts.
  const telegramRaw = row.telegram_enabled;
  const telegramEnabled =
    telegramRaw === null || telegramRaw === undefined
      ? true
      : telegramRaw === 'false' || telegramRaw === '0' || telegramRaw === 0
        ? false
        : Boolean(telegramRaw);

  return {
    ...fallback,
    id: (row.id as number | string) ?? fallback.id,
    bot_enabled: Boolean(row.is_running ?? row.engine_running ?? row.bot_enabled),
    amount_per_trade: Math.max(1, Number(row.amount_per_trade ?? fallback.amount_per_trade)),
    take_profit_pct: Number(row.take_profit_pct ?? fallback.take_profit_pct),
    stop_loss_enabled: zeroLossResolved
      ? false
      : Boolean(row.stop_loss_enabled ?? fallback.stop_loss_enabled),
    stop_loss_pct: Number(row.stop_loss_pct ?? fallback.stop_loss_pct),
    sell_only_in_profit: zeroLossResolved
      ? true
      : Boolean(row.sell_only_in_profit ?? fallback.sell_only_in_profit),
    zero_loss_mode: zeroLossResolved,
    dca_enabled: Boolean(row.dca_enabled ?? fallback.dca_enabled),
    dca_step_pct: Math.max(0.2, Number(row.dca_step_pct ?? fallback.dca_step_pct)),
    dca_max_buys: Math.max(1, Number(row.dca_max_buys ?? fallback.dca_max_buys)),
    auto_theme_by_time: Boolean(row.auto_theme_by_time ?? fallback.auto_theme_by_time),
    max_open_trades: Number(row.max_open_trades ?? fallback.max_open_trades),
    max_amount_per_pair: Number(row.max_amount_per_pair ?? fallback.max_amount_per_pair),
    daily_loss_limit: Number(row.daily_loss_limit ?? fallback.daily_loss_limit),
    trailing_stop_pct: Math.max(
      0,
      Number(row.trailing_stop_pct ?? fallback.trailing_stop_pct ?? 1.5)
    ),
    daily_max_loss_pct: Math.max(
      0,
      Number(row.daily_max_loss_pct ?? fallback.daily_max_loss_pct ?? 5)
    ),
    voice_language:
      row.voice_language === 'bn_en' || row.voice_language === 'en'
        ? row.voice_language
        : (fallback.voice_language ?? 'en'),
    auto_compounding: Boolean(row.auto_compounding ?? fallback.auto_compounding),
    compound_allocation_pct: Math.min(
      100,
      Math.max(0.5, Number(row.compound_allocation_pct ?? fallback.compound_allocation_pct ?? 5))
    ),
    multi_timeframe_filter:
      row.multi_timeframe_filter === null || row.multi_timeframe_filter === undefined
        ? (fallback.multi_timeframe_filter ?? true)
        : Boolean(row.multi_timeframe_filter),
    mode: ((row.mode ?? row.workspace_mode ?? row.trading_mode ?? fallback.mode) as TradingMode),
    enabled_pairs,
    telegram_enabled: telegramEnabled,
    last_heartbeat: String(
      row.last_heartbeat ?? row.heartbeat_at ?? row.updated_at ?? new Date().toISOString()
    ),
    balance_usdt:
      row.balance_usdt !== undefined
        ? Number(row.balance_usdt)
        : row.balance !== undefined
          ? Number(row.balance)
          : fallback.balance_usdt,
    updated_at: row.updated_at ? String(row.updated_at) : undefined,
  };
}

/**
 * Each workspace owns an independent power switch (`demo_bot_running` /
 * `live_bot_running`). Rows written before those columns existed fall back to the
 * single legacy aggregate so the toggle still reflects the worker.
 */
function modeRunFlag(row: Record<string, unknown>, mode: TradingMode, legacy: boolean): boolean {
  const raw = mode === 'DEMO' ? row.demo_bot_running : row.live_bot_running;
  if (raw === null || raw === undefined) return legacy;
  return raw === 'false' || raw === '0' || raw === 0 ? false : Boolean(raw);
}

function normalizeAccount(row: Record<string, unknown>): AccountProfile {
  const rawStatus = String(row.approval_status ?? 'pending').toLowerCase();
  const approval_status: ApprovalStatus =
    rawStatus === 'approved' || rawStatus === 'rejected' ? rawStatus : 'pending';
  return {
    id: String(row.id ?? ''),
    email: String(row.email ?? ''),
    full_name: String(row.full_name ?? ''),
    avatar_url: row.avatar_url ? String(row.avatar_url) : null,
    telegram_chat_id: row.telegram_chat_id ? String(row.telegram_chat_id) : null,
    telegram_username: row.telegram_username ? String(row.telegram_username) : null,
    approval_status,
    is_admin: Boolean(row.is_admin),
    trading_mode:
      String(row.trading_mode ?? 'VIRTUAL').toUpperCase() === 'LIVE' ? 'LIVE' : 'VIRTUAL',
    bot_running: Boolean(row.bot_running),
    virtual_balance: Number(row.virtual_balance ?? 10000),
    realized_pnl_usd: Number(row.realized_pnl_usd ?? 0),
    total_trades: Number(row.total_trades ?? 0),
    win_trades: Number(row.win_trades ?? 0),
    binance_api_key: row.binance_api_key ? String(row.binance_api_key) : null,
  };
}

function normalizeTrade(row: Record<string, unknown>): Trade {
  const entry = Number(row.entry_price ?? 0);
  const current = Number(row.current_price ?? row.exit_price ?? entry);
  const qty = Number(row.quantity ?? row.amount ?? 0);
  const invested = Number(row.invested_usdt ?? row.quote_qty ?? entry * qty);
  const profitUsdt = Number(row.profit_usdt ?? row.pnl ?? (current - entry) * qty);
  const profitPct = Number(
    row.profit_pct ?? row.pnl_pct ?? (invested > 0 ? (profitUsdt / invested) * 100 : 0)
  );
  const rawStatus = String(row.status ?? 'OPEN').toUpperCase();
  const status = (['OPEN', 'CLOSED', 'CANCELLED'].includes(rawStatus)
    ? rawStatus
    : 'OPEN') as Trade['status'];
  // Rows written by the 24/7 worker carry their workspace. Older rows have no
  // `mode`, so the VDEMO- id prefix keeps paper trades out of the LIVE ledger.
  const rawMode = String(row.mode ?? row.trading_mode ?? '').trim().toLowerCase();
  const tradeMode: TradingMode =
    rawMode === 'live'
      ? 'LIVE'
      : rawMode === 'virtual'
        ? 'DEMO'
        : String(row.id ?? '').startsWith('VDEMO-')
          ? 'DEMO'
          : 'LIVE';

  return {
    id: String(row.id ?? Math.random().toString(36).slice(2, 8)),
    pair: String(row.pair ?? row.symbol ?? 'BTCUSDT'),
    side: String(row.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
    status,
    entry_price: entry,
    current_price: current,
    exit_price: row.exit_price != null ? Number(row.exit_price) : null,
    quantity: qty,
    invested_usdt: invested,
    profit_usdt: profitUsdt,
    profit_pct: profitPct,
    take_profit_price: Number(row.take_profit_price ?? entry * 1.024),
    stop_loss_price: Number(row.stop_loss_price ?? entry * 0.985),
    opened_at: String(row.opened_at ?? row.created_at ?? new Date().toISOString()),
    closed_at: row.closed_at ? String(row.closed_at) : null,
    mode: tradeMode,
  };
}

function normalizeLog(row: Record<string, unknown>, sourcePrefix = 'log'): LogEntry {
  const lvl = String(row.level ?? 'INFO').toUpperCase();
  const level = (['INFO', 'WARNING', 'ERROR', 'TRADE'].includes(lvl)
    ? lvl
    : 'INFO') as LogLevel;

  return {
    id: `${sourcePrefix}-${String(row.id ?? `${Date.now()}-${Math.random()}`)}`,
    level,
    message: String(row.message ?? ''),
    pair: row.pair ? String(row.pair) : row.symbol ? String(row.symbol) : null,
    created_at: String(row.created_at ?? new Date().toISOString()),
  };
}

function isMissingSupabaseTableError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = String(error.message ?? '');
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    msg.includes('Could not find the table') ||
    msg.includes('does not exist')
  );
}

function isMissingSupabaseColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = String(error.message ?? '');
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    msg.includes('column') ||
    msg.includes('schema cache')
  );
}

/**
 * Single source of truth for reading an account value out of a balance payload.
 * Portfolio value (Spot + Funding + Earn + coin holdings) must win over USDT-only
 * totals, otherwise an account holding BTC/ETH reports $0.00.
 */
function pickPortfolioUsd(
  source:
    | { totalPortfolioUsd?: number; totalUsdt?: number; usdtBalance?: number }
    | null
    | undefined,
  fallback = 0
): number {
  if (!source) return fallback;
  const value = source.totalPortfolioUsd ?? source.usdtBalance ?? source.totalUsdt;
  return Number.isFinite(value) ? Number(value) : fallback;
}

function mergeAndDedupeLogs(entries: LogEntry[]): LogEntry[] {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const deduped: LogEntry[] = [];
  const seenKeys = new Set<string>();
  for (const item of sorted) {
    const bucket = Math.floor(new Date(item.created_at).getTime() / 2000);
    const sig = `${item.level}|${item.pair ?? ''}|${item.message}|${bucket}`;
    if (seenKeys.has(sig)) continue;
    seenKeys.add(sig);
    deduped.push(item);
  }
  return deduped.slice(-150);
}

export function useTradingTerminal() {
  const initialPrefs = useMemo(
    () =>
      loadJson<StoredPrefs>(STORAGE_PREFS_KEY, {
        sound_enabled: true,
        theme: 'CYBER_CYAN',
        auto_theme_by_time: false,
        zero_loss_mode: true,
        dca_enabled: true,
        dca_step_pct: 1.5,
        dca_max_buys: 12,
        core_visual: 'torus',
        candle_style: 'japanese',
      }),
    []
  );

  // Telegram identity (for pre-filling the registration form) and the signed-in
  // account that actually owns the workspace.
  const identity = useMemo(() => resolveWorkspaceIdentity(), []);
  const identityRef = useRef(identity);
  const [account, setAccount] = useState<AccountProfile | null>(null);
  const accountRef = useRef<AccountProfile | null>(null);
  const accessTokenRef = useRef<string | null>(null);

  // A signed-in account owns `u:<uuid>`; otherwise the Telegram id / guest scope.
  const activeIdentity = useMemo(() => {
    if (account?.id) {
      return {
        ...identity,
        telegramUserId: `u:${account.id}`,
        displayName: account.full_name || account.email || identity.displayName,
        username: account.telegram_username ?? identity.username,
        chatId: account.telegram_chat_id ?? identity.chatId,
        photoUrl: account.avatar_url ?? identity.photoUrl,
        isTelegram: Boolean(account.telegram_chat_id),
      };
    }
    return identity;
  }, [account, identity]);
  identityRef.current = activeIdentity;

  const workspaceUser: WorkspaceUser = useMemo(
    () => ({
      telegramUserId: activeIdentity.telegramUserId,
      displayName: activeIdentity.displayName,
      username: activeIdentity.username,
      avatarUrl: activeIdentity.photoUrl,
      isTelegram: activeIdentity.isTelegram,
    }),
    [activeIdentity]
  );

  const accountApproved = account === null || account.approval_status === 'approved';
  const isAdmin = Boolean(account?.is_admin);

  /** Worker calls carry the Supabase session so scope/authority is server-verified. */
  const workerAuthHeaders = useCallback(() => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accessTokenRef.current) headers.Authorization = `Bearer ${accessTokenRef.current}`;
    return headers;
  }, []);

  /**
   * A browser is shared hardware: wipe any Exchange API key material another
   * trader left behind and reload purely from THIS account's server vault.
   */
  const resetLocalApiKeys = useCallback(() => {
    saveJson(STORAGE_BN_KEY, INITIAL_BINANCE_CONFIG);
    setBinanceConfig({ ...INITIAL_BINANCE_CONFIG });
    setApiKeyStatus({ linked: false, api_key_masked: null, use_testnet: false });
    setBinanceAccount(null);
  }, []);

  const [isDemoMode, setIsDemoMode] = useState<boolean>(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  // A guest browses the terminal and paper-trades DEMO without an account. Every
  // money-touching action (LIVE, key vault, live engine) is gated in the UI.
  const [isGuest, setIsGuest] = useState<boolean>(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(isSupabaseConfigured);
  const [dataLoading, setDataLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [activeWorkspace, setActiveWorkspace] = useState<TradingMode>(() => {
    if (typeof window === 'undefined') return 'DEMO';
    try {
      // The workspace is persisted with JSON.stringify ("DEMO" / "LIVE") but was read
      // raw here, so every reload after a workspace switch produced the value '"DEMO"'
      // and fell through to the LIVE branch with an empty trade list.
      const raw = window.localStorage.getItem(STORAGE_WORKSPACE_KEY);
      if (!raw) return 'DEMO';
      let value = raw;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') value = parsed;
      } catch {
        value = raw.replace(/"/g, '');
      }
      return value === 'LIVE' ? 'LIVE' : 'DEMO';
    } catch {
      return 'DEMO';
    }
  });

  const [demoSettings, setDemoSettings] = useState<BotSettings>(() => {
    const zLoss = initialPrefs.zero_loss_mode ?? INITIAL_DEMO_SETTINGS.zero_loss_mode;
    const fallback = {
      ...INITIAL_DEMO_SETTINGS,
      sound_enabled: initialPrefs.sound_enabled ?? true,
      theme: initialPrefs.theme ?? 'CYBER_CYAN',
      auto_theme_by_time: initialPrefs.auto_theme_by_time ?? false,
      zero_loss_mode: zLoss,
      sell_only_in_profit: zLoss ? true : INITIAL_DEMO_SETTINGS.sell_only_in_profit,
      stop_loss_enabled: zLoss ? false : INITIAL_DEMO_SETTINGS.stop_loss_enabled,
      dca_enabled: initialPrefs.dca_enabled ?? true,
      dca_step_pct: initialPrefs.dca_step_pct ?? 1.5,
      dca_max_buys: initialPrefs.dca_max_buys ?? 12,
      core_visual: initialPrefs.core_visual ?? 'torus',
      candle_style: initialPrefs.candle_style ?? 'japanese',
      balance_usdt: 10000,
    };
    return loadJson<BotSettings>(STORAGE_DEMO_SETTINGS_KEY, fallback);
  });
  const [demoTrades, setDemoTrades] = useState<Trade[]>(() =>
    loadJson<Trade[]>(STORAGE_DEMO_TRADES_KEY, INITIAL_DEMO_TRADES)
  );
  const [demoLogs, setDemoLogs] = useState<LogEntry[]>(INITIAL_DEMO_LOGS);

  const [liveSettings, setLiveSettings] = useState<BotSettings>(() => {
    const fallback = {
      ...INITIAL_LIVE_SETTINGS,
      sound_enabled: initialPrefs.sound_enabled ?? true,
      theme: initialPrefs.theme ?? 'CYBER_CYAN',
      auto_theme_by_time: initialPrefs.auto_theme_by_time ?? false,
      dca_enabled: initialPrefs.dca_enabled ?? true,
      dca_step_pct: initialPrefs.dca_step_pct ?? 1.5,
      dca_max_buys: initialPrefs.dca_max_buys ?? 12,
      core_visual: initialPrefs.core_visual ?? 'torus',
      candle_style: initialPrefs.candle_style ?? 'japanese',
      balance_usdt: 0,
      zero_loss_mode: true,
      sell_only_in_profit: true,
      stop_loss_enabled: false,
    };
    const loaded = loadJson<BotSettings>(STORAGE_LIVE_SETTINGS_KEY, fallback);
    // Never retain stale mock/legacy balances in LIVE before live Binance sync succeeds
    return { ...loaded, balance_usdt: 0 };
  });
  const [liveTrades, setLiveTrades] = useState<Trade[]>(() =>
    loadJson<Trade[]>(STORAGE_LIVE_TRADES_KEY, [])
  );
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>(INITIAL_LIVE_LOGS);

  const [telegramConfig, setTelegramConfig] = useState<TelegramConfig>(() =>
    loadJson<TelegramConfig>(STORAGE_TG_KEY, INITIAL_TELEGRAM_CONFIG)
  );
  const [binanceConfig, setBinanceConfig] = useState<BinanceConfig>(() =>
    loadJson<BinanceConfig>(STORAGE_BN_KEY, INITIAL_BINANCE_CONFIG)
  );
  const [binanceAccount, setBinanceAccount] = useState<BinanceAccountSummary | null>(null);
  const [syncingBalance, setSyncingBalance] = useState(false);
  // Master Voice & SFX switch. Mirrors the announcer module so the UI can render it.
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(() => voiceAnnouncer.isEnabled());
  // Telegram's mobile WebView answers "locked" until the first real gesture, so the
  // header renders an explicit Tap to Unlock Audio pill instead of pretending it works.
  const [audioReady, setAudioReady] = useState<boolean>(() => voiceAnnouncer.isAudioUnlocked());
  // Flash-crash circuit breaker state, polled from the 24/7 worker (/api/guards).
  const [crashGuards, setCrashGuards] = useState<CrashGuardState[]>([]);
  // Masked status of THIS user's Binance key vault (secrets stay in the worker).
  const [apiKeyStatus, setApiKeyStatus] = useState<UserApiKeyStatus>({
    linked: false,
    api_key_masked: null,
    use_testnet: false,
  });
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [adminUsers, setAdminUsers] = useState<AdminUserRow[]>([]);
  const [adminTotals, setAdminTotals] = useState<{
    users: number;
    pending: number;
    approved: number;
    rejected: number;
    pnl_usd: number;
    pnl_bdt: number;
  } | null>(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  const [alertEnabledPairs, setAlertEnabledPairs] = useState<string[]>(() =>
    loadJson<string[]>(STORAGE_ALERT_PAIRS_KEY, [...SUPPORTED_PAIRS])
  );

  const [marketPairs, setMarketPairs] = useState<PairMarketData[]>(INITIAL_MARKET_PAIRS);
  const [smartAlerts, setSmartAlerts] = useState<SmartAlert[]>(INITIAL_SMART_ALERTS);
  const [binanceFeedLive, setBinanceFeedLive] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const logCycleRef = useRef(0);
  const hasHydratedRef = useRef(false);
  const lastHydratedAtRef = useRef<number>(Date.now());
  // The real settings row id, learned from Supabase. Before hydration both workspaces
  // still carry the hardcoded mock ids (1 for DEMO, 2 for LIVE), so writing with
  // `settings.id` could target a non-existent row — or another row entirely — right
  // after a workspace switch.
  const settingsRowIdRef = useRef<number | string | null>(null);
  // Set when the operator picks a workspace by hand, so a slow first hydration can
  // never yank the view back to the persisted mode.
  const workspaceTouchedRef = useRef(false);
  const marketPairsRef = useRef<PairMarketData[]>(marketPairs);
  const demoTradesRef = useRef<Trade[]>(demoTrades);
  const liveTradesRef = useRef<Trade[]>(liveTrades);
  const binanceAccountRef = useRef<BinanceAccountSummary | null>(binanceAccount);
  const demoSettingsRef = useRef<BotSettings>(demoSettings);
  const liveSettingsRef = useRef<BotSettings>(liveSettings);
  const activeWorkspaceRef = useRef<TradingMode>(activeWorkspace);
  // Trades/ids the announcer already knows about, so a reload, a hydration batch or a
  // realtime echo never re-reads old fills out loud.
  const seenTradeIdsRef = useRef<Set<string>>(new Set());
  const seenClosedIdsRef = useRef<Set<string>>(new Set());
  const voiceHydratedRef = useRef(false);
  const balanceAnnouncedRef = useRef(false);
  useEffect(() => {
    marketPairsRef.current = marketPairs;
  }, [marketPairs]);
  useEffect(() => {
    demoTradesRef.current = demoTrades;
  }, [demoTrades]);
  useEffect(() => {
    liveTradesRef.current = liveTrades;
  }, [liveTrades]);
  useEffect(() => {
    binanceAccountRef.current = binanceAccount;
  }, [binanceAccount]);
  useEffect(() => {
    demoSettingsRef.current = demoSettings;
  }, [demoSettings]);
  useEffect(() => {
    liveSettingsRef.current = liveSettings;
  }, [liveSettings]);
  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspace;
  }, [activeWorkspace]);

  const balanceForVoice = useCallback((workspace: TradingMode): number => {
    if (workspace === 'LIVE') {
      const account = binanceAccountRef.current;
      return account?.connected
        ? pickPortfolioUsd(account)
        : Number(liveSettingsRef.current.balance_usdt ?? 0);
    }
    return Number(demoSettingsRef.current.balance_usdt ?? 10000);
  }, []);

  // Unlock Web Audio / speechSynthesis on the very first tap, click or keypress so
  // Android Chrome does not silently drop every later announcement.
  useEffect(() => {
    voiceAnnouncer.installUnlockHandlers();
    const unsubscribe = voiceAnnouncer.onAudioReady(setAudioReady);
    const retry = window.setInterval(() => {
      setAudioReady(voiceAnnouncer.isAudioUnlocked());
    }, 2500);
    return () => {
      unsubscribe();
      window.clearInterval(retry);
    };
  }, []);

  // The worker owns the crash guard; 30s polling keeps the header badge honest without
  // a websocket. Failures are silent so a sleeping worker never breaks the terminal.
  useEffect(() => {
    let cancelled = false;
    const loadGuards = async () => {
      try {
        const res = await fetch(`${WORKER_URL}/api/guards`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setCrashGuards(Array.isArray(data?.guards) ? data.guards : []);
      } catch {
        // worker offline — leave the last known state alone
      }
    };
    void loadGuards();
    const timer = window.setInterval(() => void loadGuards(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const settings = activeWorkspace === 'DEMO' ? demoSettings : liveSettings;
  const trades = activeWorkspace === 'DEMO' ? demoTrades : liveTrades;
  const logs = activeWorkspace === 'DEMO' ? demoLogs : liveLogs;

  const effectiveTheme: ThemeId = useMemo(() => {
    if (settings.auto_theme_by_time) {
      return getTimeBasedTheme(new Date(nowTick)).theme;
    }
    return settings.theme;
  }, [settings.auto_theme_by_time, settings.theme, nowTick]);

  useEffect(() => {
    audioSynth.setEnabled(settings.sound_enabled);
  }, [settings.sound_enabled]);

  useEffect(() => {
    voiceAnnouncer.setLanguage(settings.voice_language === 'bn_en' ? 'bn_en' : 'en');
  }, [settings.voice_language]);

  useEffect(() => {
    saveJson(STORAGE_PREFS_KEY, {
      sound_enabled: settings.sound_enabled,
      theme: settings.theme,
      auto_theme_by_time: settings.auto_theme_by_time,
      zero_loss_mode: settings.zero_loss_mode,
      dca_enabled: settings.dca_enabled,
      dca_step_pct: settings.dca_step_pct,
      dca_max_buys: settings.dca_max_buys,
      core_visual: settings.core_visual,
      candle_style: settings.candle_style,
    });
  }, [
    settings.sound_enabled,
    settings.theme,
    settings.auto_theme_by_time,
    settings.zero_loss_mode,
    settings.dca_enabled,
    settings.dca_step_pct,
    settings.dca_max_buys,
    settings.core_visual,
    settings.candle_style,
  ]);

  useEffect(() => {
    saveJson(STORAGE_TG_KEY, telegramConfig);
  }, [telegramConfig]);

  // The worker cannot read localStorage, so Telegram credentials must also live in
  // the Supabase settings row for server-side push notifications. Nothing is written
  // before the row id is known, and blank local fields never overwrite credentials
  // that another browser already stored on the server.
  useEffect(() => {
    if (!supabase || isDemoMode || !isAuthenticated) return;
    const rowId = settingsRowIdRef.current;
    if (rowId === null) return;
    const timeout = window.setTimeout(() => {
      const patch: Record<string, unknown> = { telegram_enabled: settings.telegram_enabled };
      const botToken = telegramConfig.bot_token.trim();
      const chatId = telegramConfig.chat_id.trim();
      if (botToken) patch.telegram_bot_token = botToken;
      if (chatId) {
        patch.telegram_chat_id = chatId;
        // The worker's per-user alerts read `chat_id`; keep it in sync too.
        patch.chat_id = chatId;
      }
      void supabase!
        .from('settings')
        .update(patch)
        .eq('id', rowId)
        .then(({ error }) => {
          if (error) console.warn('Telegram settings sync warning:', error.message);
        });
      // And on the account, so approval/welcome messages reach the right chat.
      const accountId = accountRef.current?.id;
      if (chatId && accountId) {
        void supabase!
          .from('users')
          .update({ telegram_chat_id: chatId })
          .eq('id', accountId)
          .then(({ error }) => {
            if (error) console.warn('Telegram chat sync warning:', error.message);
          });
      }
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [isAuthenticated, isDemoMode, settings.id, settings.telegram_enabled, telegramConfig]);

  useEffect(() => {
    saveJson(STORAGE_BN_KEY, binanceConfig);
  }, [binanceConfig]);

  useEffect(() => {
    saveJson(STORAGE_DEMO_SETTINGS_KEY, demoSettings);
  }, [demoSettings]);

  useEffect(() => {
    saveJson(STORAGE_LIVE_SETTINGS_KEY, liveSettings);
  }, [liveSettings]);

  useEffect(() => {
    saveJson(STORAGE_DEMO_TRADES_KEY, demoTrades);
  }, [demoTrades]);

  useEffect(() => {
    saveJson(STORAGE_LIVE_TRADES_KEY, liveTrades);
  }, [liveTrades]);

  useEffect(() => {
    saveJson(STORAGE_ALERT_PAIRS_KEY, alertEnabledPairs);
  }, [alertEnabledPairs]);

  const appendLog = useCallback((workspace: TradingMode, entry: LogEntry) => {
    const updater = (prev: LogEntry[]) => [...prev.filter((l) => l.id !== entry.id).slice(-99), entry];
    if (workspace === 'DEMO') {
      setDemoLogs(updater);
    } else {
      setLiveLogs(updater);
    }
  }, []);

  const notifyTelegramIfConfigured = useCallback(
    async (text: string, workspace: TradingMode) => {
      const targetSettings = workspace === 'DEMO' ? demoSettings : liveSettings;
      if (!targetSettings.telegram_enabled) {
        console.debug('[useTradingTerminal] notifyTelegramIfConfigured skipped: telegram_enabled=false', { workspace });
        return;
      }
      if (!telegramConfig.bot_token.trim() || !telegramConfig.chat_id.trim()) {
        console.warn('[useTradingTerminal] notifyTelegramIfConfigured skipped: missing bot_token or chat_id', { workspace });
        return;
      }
      const wsBal =
        workspace === 'LIVE'
          ? binanceAccountRef.current?.connected
            ? pickPortfolioUsd(binanceAccountRef.current)
            : 0
          : Number(targetSettings.balance_usdt ?? 10000);
      const bdtVal = Math.round(wsBal * BDT_PER_USD);
      const balanceFooter =
        telegramConfig.notify_balance !== false
          ? `\n💰 <b>Balance:</b> $${wsBal.toFixed(2)} (৳${bdtVal.toLocaleString('en-US')})`
          : '';
      const res = await dispatchTelegramAlert(
        telegramConfig,
        `<b>[AEGIS ${workspace}]</b> ${text}${balanceFooter}`
      );
      if (!res.ok) {
        console.error('[useTradingTerminal] notifyTelegramIfConfigured failed:', res);
      }
    },
    [demoSettings, liveSettings, telegramConfig]
  );

  // Sync real Binance Spot public 24h prices via data-api.binance.vision + api1/2/3 fallback + live !miniTicker@arr WebSocket
  useEffect(() => {
    let active = true;
    const supportedSet = new Set<string>(SUPPORTED_PAIRS);

    const syncBinancePublic = async () => {
      if (document.hidden) return;
      try {
        const rows = await fetchBinance24hrTickers(SUPPORTED_PAIRS);
        if (!active || !Array.isArray(rows) || rows.length === 0) return;

        setBinanceFeedLive(true);
        setMarketPairs((prev) =>
          prev.map((pair) => {
            const live = rows.find((r) => r.symbol === pair.symbol);
            if (!live) return pair;
            const p = Number(live.lastPrice);
            const chg = Number(live.priceChangePercent);
            const hi = Number(live.highPrice);
            const lo = Number(live.lowPrice);
            const vol = Number(live.quoteVolume);
            const bVol = Number(live.volume);
            if (!Number.isFinite(p) || p <= 0) return pair;
            const chgRounded = Number(chg.toFixed(2));
            const nextSignal: PairMarketData['signal'] =
              pair.rsi14 > 56 && chgRounded > 0.4
                ? 'BUY'
                : pair.rsi14 < 40 || chgRounded < -2.0
                  ? 'SELL'
                  : 'HOLD';
            return {
              ...pair,
              price: p,
              change24h: chgRounded,
              high24h: hi,
              low24h: lo,
              volume24h: vol,
              baseVolume24h: bVol,
              signal: nextSignal,
              perf: { ...pair.perf, today: chgRounded },
              sparkline: [
                ...pair.sparkline.slice(1),
                {
                  t: new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }),
                  p,
                },
              ],
            };
          })
        );
      } catch {
        // Silent fallback to simulated tick stream
      }
    };

    syncBinancePublic();
    const restId = window.setInterval(syncBinancePublic, 20_000);

    // Live per-second Binance WebSocket miniTicker stream for all 10 pairs
    const pendingUpdates = new Map<
      string,
      { c: number; o: number; h: number; l: number; v: number; q: number }
    >();

    const closeWs = openBinanceStream(
      '!miniTicker@arr',
      (payload) => {
        if (!Array.isArray(payload)) return;
        for (const item of payload as Record<string, string>[]) {
          const sym = item.s;
          if (!sym || !supportedSet.has(sym)) continue;
          const c = Number(item.c);
          const o = Number(item.o);
          const h = Number(item.h);
          const l = Number(item.l);
          const v = Number(item.v);
          const q = Number(item.q);
          if (Number.isFinite(c) && c > 0) {
            pendingUpdates.set(sym, { c, o, h, l, v, q });
          }
        }
      },
      () => {
        if (active) setBinanceFeedLive(true);
      }
    );

    const flushId = window.setInterval(() => {
      if (!active || document.hidden || pendingUpdates.size === 0) return;
      const snapshot = new Map(pendingUpdates);
      pendingUpdates.clear();

      setBinanceFeedLive(true);
      setMarketPairs((prev) => {
        const nextPairs = prev.map((pair) => {
          const tick = snapshot.get(pair.symbol);
          if (!tick) return pair;
          const chg = tick.o > 0 ? ((tick.c - tick.o) / tick.o) * 100 : pair.change24h;
          const nextSpark =
            tick.c !== pair.price
              ? [
                  ...pair.sparkline.slice(1),
                  {
                    t: new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }),
                    p: tick.c,
                  },
                ]
              : pair.sparkline;
          return {
            ...pair,
            price: tick.c,
            change24h: Number(chg.toFixed(2)),
            high24h: Number.isFinite(tick.h) && tick.h > 0 ? tick.h : pair.high24h,
            low24h: Number.isFinite(tick.l) && tick.l > 0 ? tick.l : pair.low24h,
            baseVolume24h: Number.isFinite(tick.v) && tick.v > 0 ? tick.v : pair.baseVolume24h,
            volume24h: Number.isFinite(tick.q) && tick.q > 0 ? tick.q : pair.volume24h,
            perf: { ...pair.perf, today: Number(chg.toFixed(2)) },
            sparkline: nextSpark,
          };
        });

        const recalcTrades = (list: Trade[]) =>
          list.map((trade) => {
            if (trade.status !== 'OPEN') return trade;
            const matched = nextPairs.find((p) => p.symbol === trade.pair);
            if (!matched) return trade;
            const profitUsdt = Number(
              ((matched.price - trade.entry_price) * trade.quantity).toFixed(2)
            );
            const profitPct = Number(
              ((profitUsdt / Math.max(0.01, trade.invested_usdt)) * 100).toFixed(2)
            );
            return {
              ...trade,
              current_price: matched.price,
              profit_usdt: profitUsdt,
              profit_pct: profitPct,
            };
          });

        setDemoTrades(recalcTrades);
        setLiveTrades(recalcTrades);
        return nextPairs;
      });
    }, 750);

    return () => {
      active = false;
      window.clearInterval(restId);
      window.clearInterval(flushId);
      closeWs();
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * Loads this session's `users` row — the approval gate, admin flag and trading
   * profile. Projects without the table keep working (no gate).
   */
  const loadAccountProfile = useCallback(
    async (authUser: { id: string; email?: string | null } | null) => {
      if (!supabase) return null;
      if (!authUser?.id) {
        accountRef.current = null;
        setAccount(null);
        return null;
      }
      try {
        const { data, error } = await supabase
          .from('users')
          .select('*')
          .eq('id', authUser.id)
          .maybeSingle();
        if (error) {
          if (
            isMissingSupabaseTableError(error) ||
            isMissingSupabaseColumnError(error)
          ) {
            accountRef.current = null;
            setAccount(null);
            return null;
          }
          console.warn('[useTradingTerminal] account load failed:', error.message);
          return null;
        }

        let row = data as Record<string, unknown> | null;
        if (!row) {
          // Trigger-less project: create the pending profile from this session.
          const me = identityRef.current;
          const { data: created, error: insertErr } = await supabase
            .from('users')
            .insert({
              id: authUser.id,
              email: authUser.email ?? me.username ?? '',
              full_name: me.displayName,
              telegram_chat_id: me.chatId,
              telegram_username: me.username,
              approval_status: 'pending',
            })
            .select('*')
            .maybeSingle();
          if (insertErr) {
            console.warn('[useTradingTerminal] account provisioning failed:', insertErr.message);
            return null;
          }
          row = created as Record<string, unknown> | null;
        }

        const profile = row ? normalizeAccount(row) : null;
        accountRef.current = profile;
        setAccount(profile);
        return profile;
      } catch (err) {
        console.warn('[useTradingTerminal] account load error:', err);
        return null;
      }
    },
    []
  );

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }

    let mounted = true;
    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (!mounted) return;
        accessTokenRef.current = data.session?.access_token ?? null;
        if (data.session) {
          setIsDemoMode(false);
          setUserEmail(data.session.user.email ?? null);
          // Never inherit the previous browser user's Binance keys.
          resetLocalApiKeys();
          // Load the approval profile BEFORE unlocking data fetches.
          await loadAccountProfile(data.session.user);
          setIsAuthenticated(true);
        }
      })
      .finally(() => {
        if (mounted) setAuthLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      accessTokenRef.current = session?.access_token ?? null;
      if (session) {
        setIsDemoMode(false);
        setUserEmail(session.user.email ?? null);
        resetLocalApiKeys();
        void loadAccountProfile(session.user).then(() => setIsAuthenticated(true));
      } else {
        setIsAuthenticated(false);
        setUserEmail(null);
        accountRef.current = null;
        setAccount(null);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [loadAccountProfile, resetLocalApiKeys]);

  /**
   * Creates this browser/Telegram user's own settings row on first contact.
   * Everything the worker trades for them then lives behind that single key.
   */
  const ensureWorkspaceRow = useCallback(async (): Promise<Record<string, unknown> | null> => {
    if (!supabase) return null;
    // Never provision trading state for an account that is still pending.
    if (accountRef.current && accountRef.current.approval_status !== 'approved') return null;
    const me = identityRef.current;
    const payload: Record<string, unknown> = {
      telegram_user_id: me.telegramUserId,
      telegram_username: me.username,
      full_name: me.displayName,
      chat_id: me.chatId,
      telegram_enabled: true,
      bot_enabled: false,
      is_running: false,
      bot_running: false,
      demo_bot_running: false,
      live_bot_running: false,
      trading_mode: activeWorkspace === 'LIVE' ? 'live' : 'virtual',
      mode: activeWorkspace,
      virtual_balance: 10000,
      zero_loss_mode: true,
      sell_only_in_profit: true,
      enabled_pairs: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'],
    };
    let { data, error } = await supabase
      .from('settings')
      .insert(payload)
      .select('*')
      .maybeSingle();
    if (error && isMissingSupabaseColumnError(error)) {
      // Pre-migration project: still create an isolated row with the basics.
      ({ data, error } = await supabase
        .from('settings')
        .insert({
          telegram_user_id: me.telegramUserId,
          chat_id: me.chatId,
          bot_enabled: false,
        })
        .select('*')
        .maybeSingle());
    }
    if (error) {
      console.warn('[useTradingTerminal] workspace provisioning failed:', error.message);
      return null;
    }
    console.log(`[useTradingTerminal] Provisioned workspace ${me.telegramUserId}.`);
    return (data as Record<string, unknown> | null) ?? null;
  }, [activeWorkspace]);

  const fetchSupabaseData = useCallback(async () => {
    if (!supabase || isDemoMode || !isAuthenticated) return;
    // Pending/rejected accounts never load or provision a trading workspace.
    if (accountRef.current && accountRef.current.approval_status !== 'approved') {
      setDataLoading(false);
      return;
    }
    setDataLoading(true);
    setErrorMsg(null);
    try {
      const scopeId = identityRef.current.telegramUserId;
      const scopedSettings = () =>
        supabase!
          .from('settings')
          .select('*')
          .eq('telegram_user_id', scopeId)
          .limit(1)
          .maybeSingle();
      const scopedTrades = () =>
        supabase!
          .from('trades')
          .select('*')
          .eq('telegram_user_id', scopeId)
          .order('opened_at', { ascending: false })
          .limit(200);

      let [settingsRes, tradesRes, logsRes, engineLogsRes] = await Promise.all([
        scopedSettings(),
        scopedTrades(),
        supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(120),
        supabase.from('engine_logs').select('*').order('created_at', { ascending: false }).limit(120),
      ]);

      // Pre-multi-user schema: degrade to the original unscoped reads.
      if (settingsRes.error && isMissingSupabaseColumnError(settingsRes.error)) {
        [settingsRes, tradesRes] = await Promise.all([
          supabase.from('settings').select('*').limit(1).maybeSingle(),
          supabase.from('trades').select('*').order('opened_at', { ascending: false }).limit(200),
        ]);
      }

      // First contact for this Telegram user: provision their isolated workspace.
      if (!settingsRes.error && !settingsRes.data) {
        const created = await ensureWorkspaceRow();
        if (created) settingsRes = { data: created, error: null } as typeof settingsRes;
      }

      const settingsMissing = isMissingSupabaseTableError(settingsRes.error);
      const tradesMissing = isMissingSupabaseTableError(tradesRes.error);
      const logsMissing = isMissingSupabaseTableError(logsRes.error);
      const engineLogsMissing = isMissingSupabaseTableError(engineLogsRes.error);

      if (settingsRes.error && !settingsMissing) throw settingsRes.error;
      if (tradesRes.error && !tradesMissing) throw tradesRes.error;

      const settingsRow = (settingsRes.data ?? null) as Record<string, unknown> | null;
      if (settingsRow) {
        const rowId = settingsRow.id as number | string | undefined;
        if (rowId !== undefined && rowId !== null) settingsRowIdRef.current = rowId;
        const normalized = normalizeSettings(settingsRow, INITIAL_LIVE_SETTINGS);
        setLiveSettings((prev) => ({
          ...normalized,
          // The LIVE toggle follows ONLY the live switch, never the DEMO one.
          bot_enabled: modeRunFlag(settingsRow, 'LIVE', normalized.bot_enabled),
          sound_enabled: prev.sound_enabled,
          theme: prev.theme,
          core_visual: prev.core_visual,
          candle_style: prev.candle_style,
          // Never let stale Supabase balance overwrite verified live Binance balance
          balance_usdt: binanceAccountRef.current?.connected ? prev.balance_usdt : 0,
        }));

        // The DEMO workspace mirrors the worker's virtual configuration so the
        // paper account shown here is the one actually trading on the server.
        const virtualBalance = Number(settingsRow.virtual_balance ?? settingsRow.demo_balance);
        setDemoSettings((prev) => {
          const demoNormalized = normalizeSettings(settingsRow, prev);
          return {
            ...demoNormalized,
            mode: 'DEMO',
            // The VIRTUAL toggle follows ONLY the demo switch.
            bot_enabled: modeRunFlag(settingsRow, 'DEMO', demoNormalized.bot_enabled),
            sound_enabled: prev.sound_enabled,
          theme: prev.theme,
            core_visual: prev.core_visual,
            candle_style: prev.candle_style,
            balance_usdt: Number.isFinite(virtualBalance) ? virtualBalance : prev.balance_usdt,
          };
        });

        // Only follow the persisted workspace on the first load, never while the
        // operator is actively looking at the other workspace.
        if (!hasHydratedRef.current && !workspaceTouchedRef.current) {
          const declared = String(settingsRow.trading_mode ?? settingsRow.mode ?? '')
            .trim()
            .toLowerCase();
          if (declared === 'live') setActiveWorkspace('LIVE');
          else if (declared === 'virtual' || declared === 'demo') setActiveWorkspace('DEMO');
        }
      }

      if (tradesRes.data) {
        const rows = (tradesRes.data as Record<string, unknown>[]).map(normalizeTrade);
        // A successful-but-empty payload (fresh project, RLS hiding every row, lag right
        // after a write) must never erase history the terminal already holds: nothing in
        // this app deletes trades, so "no rows" means "unknown", not "empty account".
        if (rows.length === 0) {
          console.debug(
            '[useTradingTerminal] trades fetch returned no rows; keeping local trade history'
          );
        } else {
          const closedSince = (t: Trade) =>
            new Date(t.closed_at ?? t.opened_at).getTime() > lastHydratedAtRef.current;
          const missed = rows.filter(closedSince);
          // Everything in a bulk fetch is history, not a fresh fill: mark it spoken so
          // the announcer only reads the single catch-up summary below.
          for (const t of rows) {
            seenTradeIdsRef.current.add(t.id);
            if (t.status === 'CLOSED') seenClosedIdsRef.current.add(t.id);
          }
          setLiveTrades(rows.filter((t) => t.mode !== 'DEMO'));
          setDemoTrades(rows.filter((t) => t.mode === 'DEMO'));
          if (missed.length > 0 && hasHydratedRef.current) {
            // One concise catch-up summary beats reading 20 restored trades one by one.
            for (const t of missed) {
              seenTradeIdsRef.current.add(t.id);
              if (t.status === 'CLOSED') seenClosedIdsRef.current.add(t.id);
            }
            const netPnl = missed.reduce((acc, t) => acc + (t.profit_usdt || 0), 0);
            const mode = activeWorkspaceRef.current;
            const rowVirtual = Number(settingsRow?.virtual_balance ?? settingsRow?.demo_balance);
            const balance =
              mode === 'DEMO' && Number.isFinite(rowVirtual) ? rowVirtual : balanceForVoice(mode);
            voiceAnnouncer.speak(catchUpSentence(missed.length, netPnl, balance));
            const summary: LogEntry = {
              id: `catchup-${Date.now()}`,
              level: 'INFO',
              pair: null,
              message: `CATCH-UP: ${missed.length} trade event(s) executed while the terminal was closed were restored from Supabase.`,
              created_at: new Date().toISOString(),
            };
            setLiveLogs((prev) => mergeAndDedupeLogs([...prev, summary]));
            setDemoLogs((prev) => mergeAndDedupeLogs([...prev, summary]));
          }
        }
      }
      lastHydratedAtRef.current = Date.now();
      const firstHydration = !hasHydratedRef.current;
      hasHydratedRef.current = true;

      // Login hydration: announce the exact balance once, not on every refetch.
      if (firstHydration && !balanceAnnouncedRef.current) {
        balanceAnnouncedRef.current = true;
        const mode = activeWorkspaceRef.current;
        const rowVirtual = Number(settingsRow?.virtual_balance ?? settingsRow?.demo_balance);
        const amount =
          mode === 'DEMO' && Number.isFinite(rowVirtual) ? rowVirtual : balanceForVoice(mode);
        voiceAnnouncer.speak(balanceSentence(mode, amount));
      }

      const combinedLogs: LogEntry[] = [
        ...(logsRes.data
          ? (logsRes.data as Record<string, unknown>[]).map((r) => normalizeLog(r, 'logs'))
          : []),
        ...(engineLogsRes.data
          ? (engineLogsRes.data as Record<string, unknown>[]).map((r) =>
              normalizeLog(r, 'engine_logs')
            )
          : []),
      ];
      if (combinedLogs.length > 0) {
        const demoOnly = combinedLogs.filter((l) => l.message.startsWith('[DEMO]'));
        setLiveLogs(
          mergeAndDedupeLogs(combinedLogs.filter((l) => !l.message.startsWith('[DEMO]')))
        );
        if (demoOnly.length > 0) setDemoLogs(mergeAndDedupeLogs(demoOnly));
      }
    } catch (err) {
      console.error('Supabase fetch error:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load Supabase data');
    } finally {
      setDataLoading(false);
    }
  }, [balanceForVoice, ensureWorkspaceRow, isAuthenticated, isDemoMode]);

  useEffect(() => {
    if (!supabase || isDemoMode || !isAuthenticated) return;
    // Never stream another workspace into a pending account.
    if (accountRef.current && accountRef.current.approval_status !== 'approved') return;
    fetchSupabaseData();

    const handleRealtimeLog = (source: string) => (payload: { new?: unknown }) => {
      if (payload.new && typeof payload.new === 'object') {
        const entry = normalizeLog(payload.new as Record<string, unknown>, source);
        // The worker tags paper-engine lines with [DEMO]; keep them out of the LIVE feed.
        const setter = entry.message.startsWith('[DEMO]') ? setDemoLogs : setLiveLogs;
        setter((prev) => {
          const filtered = prev.filter((l) => l.id !== entry.id);
          return mergeAndDedupeLogs([...filtered, entry]);
        });
      }
    };

    const channel = supabase
      .channel('aegis-terminal-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'settings' },
        (payload) => {
          if (payload.new && typeof payload.new === 'object') {
            const row = payload.new as Record<string, unknown>;
            // Never mirror another trader's settings into this workspace.
            const rowScope = String(row.telegram_user_id ?? '').trim();
            if (rowScope && rowScope !== identityRef.current.telegramUserId) return;
            const rowId = row.id as number | string | undefined;
            if (rowId !== undefined && rowId !== null) settingsRowIdRef.current = rowId;
            setLiveSettings((prev) => {
              const next = normalizeSettings(row, prev);
              return {
                ...next,
                bot_enabled: modeRunFlag(row, 'LIVE', next.bot_enabled),
                balance_usdt: binanceAccountRef.current?.connected ? prev.balance_usdt : 0,
              };
            });
            // Both workspaces are projections of the same row, so DEMO must follow the
            // worker's writes too (virtual balance, lot, run state) instead of waiting
            // for the next focus/visibility refetch.
            setDemoSettings((prev) => {
              const virtualBalance = Number(row.virtual_balance ?? row.demo_balance);
              const demoNormalized = normalizeSettings(row, prev);
              return {
                ...demoNormalized,
                mode: 'DEMO',
                bot_enabled: modeRunFlag(row, 'DEMO', demoNormalized.bot_enabled),
                balance_usdt: Number.isFinite(virtualBalance) ? virtualBalance : prev.balance_usdt,
              };
            });
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trades' },
        (payload) => {
          const rowScope = String(
            (payload.new as Record<string, unknown> | undefined)?.telegram_user_id ?? ''
          ).trim();
          if (rowScope && rowScope !== identityRef.current.telegramUserId) return;
          if (payload.eventType === 'INSERT' && payload.new) {
            const incoming = normalizeTrade(payload.new as Record<string, unknown>);
            // Route by mode: a VDEMO- paper fill must never surface in the LIVE ledger.
            const setter = incoming.mode === 'DEMO' ? setDemoTrades : setLiveTrades;
            setter((prev) => [incoming, ...prev.filter((t) => t.id !== incoming.id)]);
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            const updated = normalizeTrade(payload.new as Record<string, unknown>);
            const setter = updated.mode === 'DEMO' ? setDemoTrades : setLiveTrades;
            setter((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
          } else if (payload.eventType === 'DELETE' && payload.old) {
            const oldId = String((payload.old as Record<string, unknown>).id);
            setLiveTrades((prev) => prev.filter((t) => t.id !== oldId));
            setDemoTrades((prev) => prev.filter((t) => t.id !== oldId));
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'logs' },
        handleRealtimeLog('logs')
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'engine_logs' },
        handleRealtimeLog('engine_logs')
      )
      .subscribe();

    return () => {
      supabase?.removeChannel(channel);
    };
  }, [fetchSupabaseData, isAuthenticated, isDemoMode]);

  // Catch-up hydration: on reopen/focus/network recovery, immediately pull every
  // trade and log the 24/7 worker produced while this tab was closed.
  useEffect(() => {
    if (!supabase || isDemoMode || !isAuthenticated) return;
    const hydrate = () => {
      if (!document.hidden) void fetchSupabaseData();
    };
    document.addEventListener('visibilitychange', hydrate);
    window.addEventListener('focus', hydrate);
    window.addEventListener('online', hydrate);
    return () => {
      document.removeEventListener('visibilitychange', hydrate);
      window.removeEventListener('focus', hydrate);
      window.removeEventListener('online', hydrate);
    };
  }, [fetchSupabaseData, isAuthenticated, isDemoMode]);

  // Micro-tick engine for open PnL, RSI, Inflow, and heartbeat
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.hidden) return;

      const prevPairs = marketPairsRef.current;
      const generatedAlerts: SmartAlert[] = [];

      const nextPairs = prevPairs.map((pair) => {
        const drift = binanceFeedLive ? 0 : (Math.random() - 0.482) * 0.0042;
        const nextPrice =
          drift === 0
            ? pair.price
            : Number((pair.price * (1 + drift)).toFixed(pair.price > 10 ? 2 : 5));
        const nextChange =
          drift === 0 ? pair.change24h : Number((pair.change24h + drift * 100).toFixed(2));
        const nextRsi = Number(
          Math.max(18, Math.min(84, pair.rsi14 + (Math.random() - 0.5) * 1.4)).toFixed(1)
        );
        const nextInflow = Number(
          Math.max(25, Math.min(78, pair.inflowPct + (Math.random() - 0.5) * 1.8)).toFixed(1)
        );
        const signal: PairMarketData['signal'] =
          nextRsi > 56 && nextChange > 0.4
            ? 'BUY'
            : nextRsi < 40 || nextChange < -2.0
              ? 'SELL'
              : 'HOLD';

        const nextSpark =
          drift === 0
            ? pair.sparkline
            : [
                ...pair.sparkline.slice(1),
                {
                  t: new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }),
                  p: nextPrice,
                },
              ];

        if (signal !== pair.signal && (signal === 'BUY' || signal === 'SELL')) {
          generatedAlerts.push({
            id: createUniqueId('ALT', pair.base),
            pair: pair.symbol,
            title: signal === 'BUY' ? 'BUY Signal Triggered' : 'SELL Signal Triggered',
            desc:
              signal === 'BUY'
                ? `RSI ${nextRsi.toFixed(1)} · Inflow ${nextInflow.toFixed(1)}% · Momentum breakout @ $${nextPrice}`
                : `RSI ${nextRsi.toFixed(1)} · 24h ${nextChange >= 0 ? '+' : ''}${nextChange.toFixed(2)}% · Bearish pressure @ $${nextPrice}`,
            deltaPct: nextChange,
            time: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }),
            spark: nextSpark.slice(-7).map((pt) => pt.p),
          });
        }

        return {
          ...pair,
          price: nextPrice,
          change24h: nextChange,
          high24h: Math.max(pair.high24h, nextPrice),
          low24h: Math.min(pair.low24h, nextPrice),
          inflowPct: nextInflow,
          rsi14: nextRsi,
          signal,
          sparkline: nextSpark,
        };
      });

      setMarketPairs(nextPairs);

      if (generatedAlerts.length > 0) {
        setSmartAlerts((prev) => [...generatedAlerts, ...prev].slice(0, 5));
      }

      setDemoTrades((prevTrades) =>
        prevTrades.map((trade) => {
          if (trade.status !== 'OPEN') return trade;
          const matched = nextPairs.find((p) => p.symbol === trade.pair);
          if (!matched) return trade;
          const currentPrice = matched.price;
          const profitUsdt = Number(
            ((currentPrice - trade.entry_price) * trade.quantity).toFixed(2)
          );
          const profitPct = Number(
            ((profitUsdt / Math.max(0.01, trade.invested_usdt)) * 100).toFixed(2)
          );
          return {
            ...trade,
            current_price: currentPrice,
            profit_usdt: profitUsdt,
            profit_pct: profitPct,
          };
        })
      );

      if (isDemoMode) {
        setLiveTrades((prevTrades) =>
          prevTrades.map((trade) => {
            if (trade.status !== 'OPEN') return trade;
            const matched = nextPairs.find((p) => p.symbol === trade.pair);
            if (!matched) return trade;
            const currentPrice = matched.price;
            const profitUsdt = Number(
              ((currentPrice - trade.entry_price) * trade.quantity).toFixed(2)
            );
            const profitPct = Number(
              ((profitUsdt / Math.max(0.01, trade.invested_usdt)) * 100).toFixed(2)
            );
            return {
              ...trade,
              current_price: currentPrice,
              profit_usdt: profitUsdt,
              profit_pct: profitPct,
            };
          })
        );
      }

      logCycleRef.current += 1;

      setDemoSettings((prev) =>
        prev.bot_enabled ? { ...prev, last_heartbeat: new Date().toISOString() } : prev
      );
      if (isDemoMode) {
        setLiveSettings((prev) =>
          prev.bot_enabled ? { ...prev, last_heartbeat: new Date().toISOString() } : prev
        );
      }

      // Autonomous DCA Dip Re-Buy & Batch Sell-All Execution when Engine is ON
      if (logCycleRef.current % 2 === 0) {
        const ws: TradingMode = activeWorkspace;
        const activeCfg = ws === 'DEMO' ? demoSettings : liveSettings;
        // With Supabase connected the 24/7 worker owns execution; a second execute
        // loop in this tab would double every order. Local simulation is only for
        // the offline/guest demo.
        const workerOwnsExecution = Boolean(supabase && isAuthenticated && !isDemoMode);
        if (activeCfg.bot_enabled && !workerOwnsExecution && (ws === 'DEMO' || isDemoMode)) {
          const currentTrades = ws === 'DEMO' ? demoTradesRef.current : liveTradesRef.current;
          const setTargetTrades = ws === 'DEMO' ? setDemoTrades : setLiveTrades;
          let nextTrades = [...currentTrades];
          let mutated = false;
          const nowIso = new Date().toISOString();
          const pendingLogs: LogEntry[] = [];
          const pendingTg: string[] = [];
          let soundWin: boolean | null = null;

          for (const pair of marketPairsRef.current) {
            if (!activeCfg.enabled_pairs.includes(pair.symbol)) continue;
            const pairOpen = nextTrades.filter(
              (t) => t.pair === pair.symbol && t.status === 'OPEN'
            );

            if (pairOpen.length > 0) {
              const totalInvested = pairOpen.reduce((s, t) => s + t.invested_usdt, 0);
              const totalPnl = pairOpen.reduce((s, t) => s + t.profit_usdt, 0);
              const aggPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
              const feeCostUsdt = totalInvested * 0.002; // 0.2% Binance round-trip fee
              const netPnlAfterFees = totalPnl - feeCostUsdt;
              const requiredTpPct = activeCfg.zero_loss_mode
                ? activeCfg.take_profit_pct + 0.2
                : activeCfg.take_profit_pct;

              // 1) Batch Sell-All when combined stack covers fees + Take Profit (strict Zero-Loss Shield)
              const takeProfitHit =
                aggPct >= requiredTpPct && (!activeCfg.zero_loss_mode || netPnlAfterFees > 0);
              const stopLossHit =
                !activeCfg.zero_loss_mode &&
                activeCfg.stop_loss_enabled &&
                aggPct <= -Math.abs(activeCfg.stop_loss_pct);

              if (takeProfitHit || stopLossHit) {
                const openIds = new Set(pairOpen.map((t) => t.id));
                nextTrades = nextTrades.map((t) =>
                  openIds.has(t.id)
                    ? { ...t, status: 'CLOSED', exit_price: pair.price, closed_at: nowIso }
                    : t
                );
                mutated = true;
                soundWin = netPnlAfterFees >= 0;
                const exitTag = takeProfitHit ? 'BATCH SELL ALL' : 'STOP-LOSS EXIT';
                pendingLogs.push({
                  id: createUniqueId('LOG', pair.base),
                  level: 'TRADE',
                  pair: pair.symbol,
                  message: `${exitTag} (${pairOpen.length} orders) @ $${pair.price} | Net Profit ${
                    netPnlAfterFees >= 0 ? '+' : ''
                  }$${netPnlAfterFees.toFixed(2)} (${aggPct >= 0 ? '+' : ''}${aggPct.toFixed(2)}%)`,
                  created_at: nowIso,
                });
                pendingTg.push(
                  `${exitTag} ${pair.symbol} (${pairOpen.length} trades) @ $${pair.price} | Net $${netPnlAfterFees.toFixed(
                    2
                  )}`
                );
                continue;
              }

              // 2) Auto Re-Buy on Dip (DCA stacking — never sit idle on one stuck trade)
              if (activeCfg.dca_enabled && pairOpen.length < activeCfg.dca_max_buys) {
                const lowestEntry = Math.min(...pairOpen.map((t) => t.entry_price));
                const dropFromLowestPct = ((lowestEntry - pair.price) / lowestEntry) * 100;
                const lot = Math.max(1, activeCfg.amount_per_trade);

                if (
                  dropFromLowestPct >= activeCfg.dca_step_pct &&
                  totalInvested + lot <= activeCfg.max_amount_per_pair
                ) {
                  const qty = Number((lot / pair.price).toFixed(pair.price > 100 ? 5 : 2));
                  const dcaOrder: Trade = {
                    id: createUniqueId('DCA', pair.base),
                    pair: pair.symbol,
                    side: 'BUY',
                    status: 'OPEN',
                    entry_price: pair.price,
                    current_price: pair.price,
                    quantity: qty,
                    invested_usdt: lot,
                    profit_usdt: 0,
                    profit_pct: 0,
                    take_profit_price: Number(
                      (pair.price * (1 + activeCfg.take_profit_pct / 100)).toFixed(4)
                    ),
                    stop_loss_price: Number(
                      (pair.price * (1 - activeCfg.stop_loss_pct / 100)).toFixed(4)
                    ),
                    opened_at: nowIso,
                  };
                  nextTrades = [dcaOrder, ...nextTrades];
                  mutated = true;
                  soundWin = true;
                  pendingLogs.push({
                    id: createUniqueId('LOG', `${pair.base}-D`),
                    level: 'TRADE',
                    pair: pair.symbol,
                    message: `DCA RE-BUY #${pairOpen.length + 1} @ $${pair.price} (-${dropFromLowestPct.toFixed(
                      2
                    )}% dip) | Lot $${lot} USDT`,
                    created_at: nowIso,
                  });
                  pendingTg.push(
                    `DCA RE-BUY #${pairOpen.length + 1} ${pair.symbol} @ $${pair.price} (-${dropFromLowestPct.toFixed(2)}% dip)`
                  );
                }
              } else if (pairOpen.length === 0 && nextTrades.filter((t) => t.status === 'OPEN').length < activeCfg.max_open_trades) {
                // Strict Market Observation: Check RSI and 24h change / momentum before opening trade
                const healthyRsi = pair.rsi14 >= 25 && pair.rsi14 <= 70;
                const positiveMomentum = pair.change24h > -4.5 || pair.signal === 'BUY';
                if (healthyRsi || positiveMomentum) {
                  const lot = Math.max(1, activeCfg.amount_per_trade);
                  const qty = Number((lot / pair.price).toFixed(pair.price > 100 ? 5 : 2));
                  const newOrder: Trade = {
                    id: createUniqueId('ORD', pair.base),
                    pair: pair.symbol,
                    side: 'BUY',
                    status: 'OPEN',
                    entry_price: pair.price,
                    current_price: pair.price,
                    quantity: qty,
                    invested_usdt: lot,
                    profit_usdt: 0,
                    profit_pct: 0,
                    take_profit_price: Number(
                      (pair.price * (1 + activeCfg.take_profit_pct / 100)).toFixed(4)
                    ),
                    stop_loss_price: Number(
                      (pair.price * (1 - activeCfg.stop_loss_pct / 100)).toFixed(4)
                    ),
                    opened_at: nowIso,
                  };
                  nextTrades = [newOrder, ...nextTrades];
                  mutated = true;
                  soundWin = true;
                  pendingLogs.push({
                    id: createUniqueId('LOG', pair.base),
                    level: 'TRADE',
                    pair: pair.symbol,
                    message: `OBSERVED & ENTERED BUY ${pair.symbol} @ $${pair.price} | RSI ${pair.rsi14.toFixed(1)} · 24h ${pair.change24h >= 0 ? '+' : ''}${pair.change24h.toFixed(2)}% | $${lot} USDT`,
                    created_at: nowIso,
                  });
                  pendingTg.push(`ENTRY BUY ${pair.symbol} @ $${pair.price} (RSI ${pair.rsi14.toFixed(1)})`);
                }
              }
            }
          }

          if (mutated) {
            setTargetTrades(nextTrades);
            if (soundWin !== null) audioSynth.playTradeChime(soundWin);
            pendingLogs.forEach((entry) => appendLog(ws, entry));
            pendingTg.forEach((msg) => void notifyTelegramIfConfigured(msg, ws));
          }
        }
      }

      if (logCycleRef.current % 3 === 0) {
        const ws: TradingMode = activeWorkspace;
        const currentSettings = ws === 'DEMO' ? demoSettings : liveSettings;
        if (currentSettings.bot_enabled) {
          const shieldTag = currentSettings.zero_loss_mode
            ? 'Zero-Loss Shield enforcing profit-only exits.'
            : 'Dynamic TP/SL guard active.';
          const templates: { level: LogLevel; pair: string | null; msg: string }[] = [
            {
              level: 'INFO',
              pair: 'BTCUSDT',
              msg: `Orderbook bid/ask imbalance +1.42% — ${shieldTag}`,
            },
            {
              level: 'INFO',
              pair: 'SOLUSDT',
              msg: `DCA Grid ($${currentSettings.amount_per_trade} USDT / -${currentSettings.dca_step_pct}% step) scanning dips.`,
            },
            {
              level: 'WARNING',
              pair: 'AVAXUSDT',
              msg: currentSettings.zero_loss_mode
                ? 'Drawdown detected — Zero-Loss Shield holding & ready for DCA re-buy.'
                : 'Price probing EMA20 support — holding additional scale-in.',
            },
            {
              level: 'INFO',
              pair: null,
              msg: `Heartbeat ACK synced · Telegram stream ${
                currentSettings.telegram_enabled ? 'ARMED' : 'MUTED'
              }.`,
            },
          ];
          const pick = templates[Math.floor(Math.random() * templates.length)];
          appendLog(ws, {
            id: createUniqueId('LOG'),
            level: pick.level,
            pair: pick.pair,
            message: pick.msg,
            created_at: new Date().toISOString(),
          });
        }
      }
    }, 2800);

    return () => window.clearInterval(interval);
  }, [
    activeWorkspace,
    appendLog,
    binanceFeedLive,
    demoSettings,
    isAuthenticated,
    isDemoMode,
    liveSettings,
    notifyTelegramIfConfigured,
  ]);

  const botStatus: BotStatus = useMemo(() => {
    const hbMs = new Date(settings.last_heartbeat).getTime();
    if (!Number.isFinite(hbMs) || nowTick - hbMs > 120_000) {
      return 'OFFLINE';
    }
    return settings.bot_enabled ? 'RUNNING' : 'STOPPED';
  }, [settings.bot_enabled, settings.last_heartbeat, nowTick]);

  const stats = useMemo(() => {
    const openTradesList = trades.filter((t) => t.status === 'OPEN');
    const closedTradesList = trades.filter((t) => t.status === 'CLOSED');
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const openPnl = openTradesList.reduce((acc, t) => acc + t.profit_usdt, 0);
    const closedPnl = closedTradesList.reduce((acc, t) => acc + t.profit_usdt, 0);
    const totalProfit = Number((openPnl + closedPnl).toFixed(2));

    const todayTrades = trades.filter(
      (t) => new Date(t.closed_at ?? t.opened_at).getTime() >= todayStart.getTime()
    );
    const todayProfit = Number(
      todayTrades.reduce((acc, t) => acc + t.profit_usdt, 0).toFixed(2)
    );

    const wins = closedTradesList.filter((t) => t.profit_usdt > 0).length;
    const winRate =
      closedTradesList.length > 0
        ? Number(((wins / closedTradesList.length) * 100).toFixed(1))
        : 0;

    const lockedCapital = Number(
      openTradesList.reduce((acc, t) => acc + t.invested_usdt, 0).toFixed(2)
    );
    // Every backend now reports the full portfolio in totalPortfolioUsd, so the
    // old USDT-only fallback (which hid coin holdings as $0.00) is no longer needed.
    const liveVerifiedBalance = binanceAccount?.connected
      ? Number(pickPortfolioUsd(binanceAccount).toFixed(2))
      : 0;
    const baseBalance =
      activeWorkspace === 'LIVE'
        ? liveVerifiedBalance
        : (settings.balance_usdt ?? 10000);
    const balance =
      activeWorkspace === 'LIVE'
        ? baseBalance
        : Number((baseBalance + openPnl).toFixed(2));

    const todayLoss = Number(
      Math.abs(
        todayTrades
          .filter((t) => t.profit_usdt < 0)
          .reduce((acc, t) => acc + t.profit_usdt, 0)
      ).toFixed(2)
    );

    const exposureMap = new Map<string, number>();
    openTradesList.forEach((t) => {
      exposureMap.set(t.pair, (exposureMap.get(t.pair) ?? 0) + t.invested_usdt);
    });
    const exposurePerPair = Array.from(exposureMap.entries()).map(([pair, amount]) => ({
      pair: pair.replace('USDT', ''),
      fullPair: pair,
      amount: Number(amount.toFixed(2)),
    }));

    return {
      balance,
      todayProfit,
      totalProfit,
      winRate,
      openTradesCount: openTradesList.length,
      totalTradesCount: trades.length,
      lockedCapital,
      availableBalance: Math.max(0, Number((balance - lockedCapital).toFixed(2))),
      todayLoss,
      exposurePerPair,
    };
  }, [trades, settings.balance_usdt, activeWorkspace, binanceAccount]);

  const speakBalance = useCallback(() => {
    voiceAnnouncer.unlock();
    voiceAnnouncer.speak(balanceSentence(activeWorkspaceRef.current, stats.balance));
  }, [stats.balance]);

  const toggleVoice = useCallback((enabled: boolean) => {
    voiceAnnouncer.setEnabled(enabled);
    setVoiceEnabled(enabled);
    // The switch itself is a user gesture, so enabling it is the natural moment to
    // unlock audio and confirm the announcer works.
    if (enabled) voiceAnnouncer.test();
  }, []);

  const testVoice = useCallback(() => {
    if (!voiceAnnouncer.isEnabled()) {
      voiceAnnouncer.setEnabled(true);
      setVoiceEnabled(true);
    }
    voiceAnnouncer.test();
  }, []);

  // Speaks every new fill once: BUY on arrival, SELL when an open trade closes. The
  // first run only records what is already on screen (reload) and hydrated catch-up
  // batches are pre-marked in fetchSupabaseData so they get one summary instead.
  useEffect(() => {
    const announce = (next: Trade[], workspace: TradingMode) => {
      for (const trade of next) {
        const isNew = !seenTradeIdsRef.current.has(trade.id);
        if (isNew) {
          seenTradeIdsRef.current.add(trade.id);
          if (
            voiceHydratedRef.current &&
            voiceAnnouncer.isEnabled() &&
            trade.side === 'BUY' &&
            trade.status === 'OPEN'
          ) {
            voiceAnnouncer.tradeChime();
            voiceAnnouncer.speak(buySentence(trade.pair, trade.entry_price, trade.invested_usdt));
          }
        }
        if (trade.status === 'CLOSED' && !seenClosedIdsRef.current.has(trade.id)) {
          seenClosedIdsRef.current.add(trade.id);
          if (voiceHydratedRef.current && voiceAnnouncer.isEnabled() && !isNew) {
            const pnl = trade.profit_usdt;
            if (Math.abs(pnl) >= 0.005) {
              if (pnl > 0) voiceAnnouncer.successChime();
              else voiceAnnouncer.lossTone();
            }
            voiceAnnouncer.speak(sellSentence(trade.pair, pnl, balanceForVoice(workspace)));
          }
        }
      }
    };
    announce(demoTrades, 'DEMO');
    announce(liveTrades, 'LIVE');
    voiceHydratedRef.current = true;
  }, [demoTrades, liveTrades, balanceForVoice]);

  const getEquitySeries = useCallback(
    (timeframe: EquityTimeframe): EquityPoint[] => {
      if (activeWorkspace === 'LIVE') {
        const baseVal = settings.balance_usdt ?? 0;
        if (trades.length === 0) {
          return [
            { label: 'Start', equity: baseVal, pnl: 0 },
            { label: 'Now', equity: stats.balance, pnl: stats.totalProfit },
          ];
        }
        return [
          { label: 'Start', equity: baseVal, pnl: 0 },
          {
            label: 'Mid',
            equity: Number(((baseVal + stats.balance) / 2).toFixed(2)),
            pnl: stats.todayProfit,
          },
          { label: 'Now', equity: stats.balance, pnl: stats.totalProfit },
        ];
      }
      const base = EQUITY_SERIES[timeframe];
      if (!base.length) return base;
      const updated = [...base];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        equity: stats.balance,
      };
      return updated;
    },
    [
      activeWorkspace,
      settings.balance_usdt,
      stats.balance,
      stats.todayProfit,
      stats.totalProfit,
      trades.length,
    ]
  );

  const switchWorkspace = useCallback((mode: TradingMode) => {
    audioSynth.playToggle(mode === 'LIVE');
    workspaceTouchedRef.current = true;
    setActiveWorkspace(mode);
    saveJson(STORAGE_WORKSPACE_KEY, mode);
    // Switching tabs is a view action: it must not rewrite the worker's run state.
    // Writing only the legacy `mode` column here left `trading_mode` pointing at the
    // other workspace (UI showing DEMO while the worker kept trading LIVE, then the
    // view flipping back on reload because hydration prefers `trading_mode`). The
    // worker's mode changes only through an explicit Start/Stop on this workspace.
  }, []);

  const updateSettings = useCallback(
    async (patch: Partial<BotSettings>) => {
      setSavingSettings(true);
      setErrorMsg(null);

      const current = activeWorkspace === 'DEMO' ? demoSettings : liveSettings;
      const zeroLoss = patch.zero_loss_mode ?? current.zero_loss_mode;
      const enforcedPatch: Partial<BotSettings> = {
        ...patch,
        amount_per_trade:
          patch.amount_per_trade !== undefined
            ? Math.max(1, patch.amount_per_trade)
            : current.amount_per_trade,
        ...(patch.zero_loss_mode !== undefined
          ? {
              zero_loss_mode: zeroLoss,
              sell_only_in_profit: zeroLoss
                ? true
                : patch.sell_only_in_profit ?? current.sell_only_in_profit,
              stop_loss_enabled: zeroLoss
                ? false
                : patch.stop_loss_enabled ?? current.stop_loss_enabled,
            }
          : {}),
      };

      const next: BotSettings = {
        ...current,
        ...enforcedPatch,
        mode: activeWorkspace,
        updated_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
      };

      if (activeWorkspace === 'DEMO') {
        setDemoSettings(next);
      } else {
        setLiveSettings(next);
      }

      if (
        patch.sound_enabled !== undefined ||
        patch.theme !== undefined ||
        patch.auto_theme_by_time !== undefined ||
        patch.dca_enabled !== undefined ||
        patch.dca_step_pct !== undefined ||
        patch.dca_max_buys !== undefined ||
        patch.core_visual !== undefined ||
        patch.candle_style !== undefined ||
        patch.voice_language !== undefined ||
        patch.trailing_stop_pct !== undefined ||
        patch.daily_max_loss_pct !== undefined ||
        patch.auto_compounding !== undefined ||
        patch.compound_allocation_pct !== undefined ||
        patch.multi_timeframe_filter !== undefined
      ) {
        const uiSync = {
          sound_enabled: next.sound_enabled,
          theme: next.theme,
          auto_theme_by_time: next.auto_theme_by_time,
          dca_enabled: next.dca_enabled,
          dca_step_pct: next.dca_step_pct,
          dca_max_buys: next.dca_max_buys,
          core_visual: next.core_visual,
          candle_style: next.candle_style,
          voice_language: next.voice_language ?? 'en',
          trailing_stop_pct: next.trailing_stop_pct ?? 1.5,
          daily_max_loss_pct: next.daily_max_loss_pct ?? 5,
          auto_compounding: next.auto_compounding ?? false,
          compound_allocation_pct: next.compound_allocation_pct ?? 5,
          multi_timeframe_filter: next.multi_timeframe_filter ?? true,
        };
        setDemoSettings((p) => ({ ...p, ...uiSync }));
        setLiveSettings((p) => ({ ...p, ...uiSync }));
      }

      // The Render worker is the only executor once Supabase is connected, so both
      // workspaces persist their run state (is_running + trading_mode) for it.
      if (!isDemoMode && isAuthenticated && supabase) {
        const targetId = settingsRowIdRef.current ?? next.id;
        // Run state belongs to the worker: persist it only when the operator actually
        // starts or stops this workspace. Writing it on every unrelated save meant a
        // theme toggle on the DEMO tab could flip `trading_mode` and stop LIVE trading.
        const runStateTouched = patch.bot_enabled !== undefined;
        // The other workspace keeps its own switch: toggling VIRTUAL must never start
        // or stop the LIVE Binance engine (and the reverse).
        const otherWorkspaceRunning =
          activeWorkspace === 'LIVE' ? Boolean(demoSettings.bot_enabled) : Boolean(liveSettings.bot_enabled);
        const aggregateRunning = next.bot_enabled || otherWorkspaceRunning;
        const runStatePayload: Record<string, unknown> = runStateTouched
          ? {
              [activeWorkspace === 'LIVE' ? 'live_bot_running' : 'demo_bot_running']: next.bot_enabled,
              // Legacy aggregate stays honest for older worker versions.
              is_running: aggregateRunning,
              bot_running: aggregateRunning,
              trading_mode: activeWorkspace === 'LIVE' ? 'live' : 'virtual',
              mode: activeWorkspace,
            }
          : {};
        const telegramToken = telegramConfig.bot_token.trim();
        const telegramChatId = telegramConfig.chat_id.trim();
        const corePayload = {
          bot_enabled: next.bot_enabled,
          amount_per_trade: next.amount_per_trade,
          take_profit_pct: next.take_profit_pct,
          stop_loss_enabled: next.stop_loss_enabled,
          stop_loss_pct: next.stop_loss_pct,
          sell_only_in_profit: next.sell_only_in_profit,
          max_open_trades: next.max_open_trades,
          max_amount_per_pair: next.max_amount_per_pair,
          daily_loss_limit: next.daily_loss_limit,
          enabled_pairs: next.enabled_pairs,
          telegram_enabled: next.telegram_enabled,
        };
        const extendedPayload = {
          ...corePayload,
          ...runStatePayload,
          ...(telegramToken ? { telegram_bot_token: telegramToken } : {}),
          ...(telegramChatId ? { telegram_chat_id: telegramChatId } : {}),
          zero_loss_mode: next.zero_loss_mode,
          zero_loss_shield: next.zero_loss_mode,
          trailing_stop_pct: next.trailing_stop_pct ?? 1.5,
          daily_max_loss_pct: next.daily_max_loss_pct ?? 5,
          voice_language: next.voice_language ?? 'en',
          auto_compounding: next.auto_compounding ?? false,
          compound_allocation_pct: next.compound_allocation_pct ?? 5,
          multi_timeframe_filter: next.multi_timeframe_filter ?? true,
          dca_enabled: next.dca_enabled,
          dca_step_pct: next.dca_step_pct,
          dca_max_buys: next.dca_max_buys,
          auto_theme_by_time: next.auto_theme_by_time,
        };

        try {
          const { error } = await supabase
            .from('settings')
            .update(extendedPayload)
            .eq('id', targetId);
          if (error) {
            if (error.code === 'PGRST204' || error.code === '42703' || error.code === '42P01') {
              // Pre-upgrade schema: keep the run state (the worker can still read
              // `is_running`/`mode`) and drop only the newer columns.
              const retryPayload = { ...corePayload, ...runStatePayload };
              const { error: retryErr } = await supabase
                .from('settings')
                .update(retryPayload)
                .eq('id', targetId);
              if (retryErr && retryErr.code !== 'PGRST204' && retryErr.code !== '42703' && retryErr.code !== '42P01') {
                console.warn('Supabase settings table/columns not ready yet. Please run the provided SQL setup script in Supabase.');
              }
            } else {
              console.warn('Supabase settings update warning:', error.message);
            }
          }
        } catch (err) {
          console.warn('Failed to save settings to Supabase (using local state):', err);
        }
      } else {
        await new Promise((r) => setTimeout(r, 120));
      }
      setSavingSettings(false);
    },
    [activeWorkspace, demoSettings, isAuthenticated, isDemoMode, liveSettings, telegramConfig]
  );

  /**
   * Executes a real Binance Spot MARKET order through the 24/7 worker, which owns the
   * signed request path. Returns what actually filled, so the UI never records a
   * phantom position when the exchange rejects an order.
   */
  const submitLiveOrder = useCallback(
    async (
      symbol: string,
      side: 'BUY' | 'SELL',
      quoteOrderQty: number,
      quantity: number
    ): Promise<{ ok: boolean; executedQty: number; quoteQty: number; error?: string }> => {
      const apiKey = binanceConfig.api_key.trim();
      const apiSecret = binanceConfig.api_secret.trim();
      // Empty local keys are fine: the worker executes with this workspace's vault.
      try {
        const           res = await fetch(`${WORKER_URL}/api/order`, {
          method: 'POST',
          headers: workerAuthHeaders(),
                      body: JSON.stringify({
              apiKey,
              apiSecret,
              testnet: binanceConfig.use_testnet,
              // Order routing is scoped to this workspace's own vault.
              telegram_user_id: identityRef.current.telegramUserId,
              initData: identityRef.current.initData,
              symbol,
              side,
              quoteOrderQty,
              quantity,
            }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          order?: { executedQty?: string; cummulativeQuoteQty?: string };
        };
        if (!res.ok || data.ok === false) {
          return {
            ok: false,
            executedQty: 0,
            quoteQty: 0,
            error: String(data.error || `Order rejected (HTTP ${res.status})`),
          };
        }
        return {
          ok: true,
          executedQty: Number(data.order?.executedQty ?? 0),
          quoteQty: Number(data.order?.cummulativeQuoteQty ?? 0),
        };
      } catch (err) {
        return {
          ok: false,
          executedQty: 0,
          quoteQty: 0,
          error: err instanceof Error ? err.message : 'Order request failed',
        };
      }
    },
    [binanceConfig]
  );

  const placeQuickTrade = useCallback(
    async (pairSymbol: string, side: 'BUY' | 'SELL', amountUsdt: number) => {
      const pair = marketPairs.find((p) => p.symbol === pairSymbol) ?? marketPairs[0];
      const lot = Math.max(1, amountUsdt);

      // LIVE Spot notional validation before anything is sent to the exchange.
      if (activeWorkspace === 'LIVE' && side === 'BUY') {
        const keysReady = Boolean(
          binanceConfig.api_key.trim() && binanceConfig.api_secret.trim()
        );
        const available = binanceAccountRef.current?.usdtFree ?? 0;
        const reject = (message: string) => {
          audioSynth.playTradeChime(false);
          appendLog('LIVE', {
            id: createUniqueId('LOG'),
            level: 'WARNING',
            pair: pair.symbol,
            message,
            created_at: new Date().toISOString(),
          });
        };
        if (!keysReady) {
          reject('LIVE BUY blocked — Binance API keys are not linked in Settings.');
          return;
        }
        if (lot < MIN_TRADEABLE_USDT) {
          reject(
            `LIVE BUY blocked — $${lot.toFixed(2)} is below Binance's $${MIN_TRADEABLE_USDT.toFixed(
              2
            )} minimum notional.`
          );
          return;
        }
        if (available + 0.01 < lot) {
          reject(
            `LIVE BUY blocked — $${available.toFixed(
              2
            )} spendable Spot USDT is below the $${lot.toFixed(2)} order.`
          );
          return;
        }
      }

      if (side === 'SELL') {
        const existingOpen = trades.find(
          (t) => t.pair === pair.symbol && t.status === 'OPEN'
        );
        if (existingOpen) {
          const estimatedFees = existingOpen.invested_usdt * 0.002;
          const netPnlAfterFees = existingOpen.profit_usdt - estimatedFees;
          if (settings.zero_loss_mode && netPnlAfterFees <= 0) {
            audioSynth.playTradeChime(false);
            appendLog(activeWorkspace, {
              id: createUniqueId('LOG'),
              level: 'WARNING',
              pair: pair.symbol,
              message: `ZERO-LOSS SHIELD BLOCKED SELL: ${pair.symbol} net after 0.2% fee is $${netPnlAfterFees.toFixed(
                2
              )}.`,
              created_at: new Date().toISOString(),
            });
            return;
          }
          if (activeWorkspace === 'LIVE') {
            const sell = await submitLiveOrder(
              pair.symbol,
              'SELL',
              0,
              existingOpen.quantity
            );
            if (!sell.ok) {
              audioSynth.playTradeChime(false);
              appendLog('LIVE', {
                id: createUniqueId('LOG'),
                level: 'ERROR',
                pair: pair.symbol,
                message: `LIVE SELL rejected: ${sell.error ?? 'unknown error'} — position kept open.`,
                created_at: new Date().toISOString(),
              });
              return;
            }
          }
          const closedAt = new Date().toISOString();
          const updater = (prev: Trade[]) =>
            prev.map((t) =>
              t.id === existingOpen.id
                ? { ...t, status: 'CLOSED' as const, exit_price: pair.price, closed_at: closedAt }
                : t
            );
          if (activeWorkspace === 'DEMO') setDemoTrades(updater);
          else setLiveTrades(updater);
          audioSynth.playTradeChime(existingOpen.profit_usdt >= 0);
          appendLog(activeWorkspace, {
            id: createUniqueId('LOG'),
            level: 'TRADE',
            pair: pair.symbol,
            message: `QUICK SELL CLOSED ${pair.symbol} @ $${pair.price} | PnL ${
              existingOpen.profit_usdt >= 0 ? '+' : ''
            }$${existingOpen.profit_usdt.toFixed(2)}`,
            created_at: closedAt,
          });
          await notifyTelegramIfConfigured(
            `QUICK SELL ${pair.symbol} @ $${pair.price} · PnL $${existingOpen.profit_usdt.toFixed(
              2
            )}`,
            activeWorkspace
          );
          return;
        }
      }

      let executedNotional = lot;
      let executedQty = Number((lot / pair.price).toFixed(pair.price > 100 ? 5 : 2));
      if (activeWorkspace === 'LIVE') {
        const buy = await submitLiveOrder(pair.symbol, 'BUY', lot, 0);
        if (!buy.ok) {
          audioSynth.playTradeChime(false);
          appendLog('LIVE', {
            id: createUniqueId('LOG'),
            level: 'ERROR',
            pair: pair.symbol,
            message: `LIVE BUY rejected: ${buy.error ?? 'unknown error'} — no trade recorded.`,
            created_at: new Date().toISOString(),
          });
          return;
        }
        if (buy.executedQty > 0) executedQty = buy.executedQty;
        if (buy.quoteQty > 0) executedNotional = buy.quoteQty;
      }
      const qty = executedQty;
      const newTrade: Trade = {
        id: createUniqueId('ORD', pair.base),
        pair: pair.symbol,
        side,
        status: 'OPEN',
        entry_price: pair.price,
        current_price: pair.price,
        quantity: qty,
        invested_usdt: executedNotional,
        profit_usdt: 0,
        profit_pct: 0,
        take_profit_price: Number(
          (pair.price * (1 + settings.take_profit_pct / 100)).toFixed(pair.price > 10 ? 2 : 4)
        ),
        stop_loss_price: Number(
          (pair.price * (1 - settings.stop_loss_pct / 100)).toFixed(pair.price > 10 ? 2 : 4)
        ),
        opened_at: new Date().toISOString(),
      };

      if (activeWorkspace === 'DEMO') {
        setDemoTrades((prev) => [newTrade, ...prev]);
      } else {
        setLiveTrades((prev) => [newTrade, ...prev]);
      }

      audioSynth.playTradeChime(true);
      appendLog(activeWorkspace, {
        id: createUniqueId('LOG'),
        level: 'TRADE',
        pair: pair.symbol,
        message: `QUICK ${side} ${qty} ${pair.base} ($${lot} USDT) @ $${pair.price}`,
        created_at: new Date().toISOString(),
      });
      await notifyTelegramIfConfigured(
        `QUICK ${side} ${pair.symbol} · $${lot} USDT @ $${pair.price}`,
        activeWorkspace
      );
    },
    [
      activeWorkspace,
      appendLog,
      binanceConfig.api_key,
      binanceConfig.api_secret,
      marketPairs,
      notifyTelegramIfConfigured,
      settings.stop_loss_pct,
      settings.take_profit_pct,
      settings.zero_loss_mode,
      submitLiveOrder,
      trades,
    ]
  );

  const toggleBot = useCallback(async () => {
    const nextEnabled = !settings.bot_enabled;
    audioSynth.playPowerState(nextEnabled);
    await updateSettings({ bot_enabled: nextEnabled });

    appendLog(activeWorkspace, {
      id: createUniqueId('LOG'),
      level: nextEnabled ? 'INFO' : 'WARNING',
      pair: null,
      message: nextEnabled
        ? `ENGINE ENGAGED (${activeWorkspace}) — Spot size $${settings.amount_per_trade} USDT · ${
            settings.zero_loss_mode ? 'Zero-Loss Shield ON' : 'Standard TP/SL'
          }.`
        : `ENGINE HALTED (${activeWorkspace}) — Standby mode.`,
      created_at: new Date().toISOString(),
    });

    if (activeWorkspace === 'LIVE' && nextEnabled && isDemoMode && liveTrades.length === 0) {
      const pair =
        marketPairs.find((p) => settings.enabled_pairs.includes(p.symbol)) ?? marketPairs[0];
      const lot = Math.max(1, settings.amount_per_trade);
      const qty = Number((lot / pair.price).toFixed(pair.price > 100 ? 5 : 2));
      const newTrade: Trade = {
        id: createUniqueId('LIVE', pair.base),
        pair: pair.symbol,
        side: 'BUY',
        status: 'OPEN',
        entry_price: pair.price,
        current_price: pair.price,
        quantity: qty,
        invested_usdt: lot,
        profit_usdt: 0,
        profit_pct: 0,
        take_profit_price: Number((pair.price * (1 + settings.take_profit_pct / 100)).toFixed(4)),
        stop_loss_price: Number((pair.price * (1 - settings.stop_loss_pct / 100)).toFixed(4)),
        opened_at: new Date().toISOString(),
      };
      setLiveTrades([newTrade]);
      appendLog('LIVE', {
        id: createUniqueId('LOG'),
        level: 'TRADE',
        pair: pair.symbol,
        message: `LIVE ORDER ARMED: BUY ${qty} ${pair.base} ($${lot} USDT) @ $${pair.price}`,
        created_at: new Date().toISOString(),
      });
      await notifyTelegramIfConfigured(
        `LIVE ORDER OPENED: ${pair.symbol} · $${lot} USDT @ $${pair.price}`,
        'LIVE'
      );
    } else {
      await notifyTelegramIfConfigured(
        `Bot ${nextEnabled ? 'ENGAGED (ON)' : 'HALTED (OFF)'} in ${activeWorkspace} workspace.`,
        activeWorkspace
      );
    }
  }, [
    activeWorkspace,
    appendLog,
    isDemoMode,
    liveTrades.length,
    marketPairs,
    notifyTelegramIfConfigured,
    settings,
    updateSettings,
  ]);

  const togglePair = useCallback(
    async (symbol: string) => {
      const exists = settings.enabled_pairs.includes(symbol);
      audioSynth.playToggle(!exists);
      const nextPairs = exists
        ? settings.enabled_pairs.filter((p) => p !== symbol)
        : [...settings.enabled_pairs, symbol];
      await updateSettings({ enabled_pairs: nextPairs });
      appendLog(activeWorkspace, {
        id: createUniqueId('LOG'),
        level: 'INFO',
        pair: symbol,
        message: `${symbol} ${exists ? 'removed from' : 'added to'} active trading matrix.`,
        created_at: new Date().toISOString(),
      });
    },
    [activeWorkspace, appendLog, settings.enabled_pairs, updateSettings]
  );

  const closeTrade = useCallback(
    async (tradeId: string) => {
      const target = trades.find((t) => t.id === tradeId);
      if (!target || target.status !== 'OPEN') return;

      const estimatedFees = target.invested_usdt * 0.002;
      const netPnlAfterFees = target.profit_usdt - estimatedFees;
      if (settings.zero_loss_mode && netPnlAfterFees <= 0) {
        audioSynth.playTradeChime(false);
        appendLog(activeWorkspace, {
          id: createUniqueId('LOG'),
          level: 'WARNING',
          pair: target.pair,
          message: `ZERO-LOSS SHIELD BLOCKED EXIT: ${target.pair} net after 0.2% Binance fees is $${netPnlAfterFees.toFixed(
            2
          )}. Waiting for net profit.`,
          created_at: new Date().toISOString(),
        });
        return;
      }

      audioSynth.playTradeChime(target.profit_usdt >= 0);
      const closedAt = new Date().toISOString();

      const updater = (prev: Trade[]) =>
        prev.map((t) =>
          t.id === tradeId
            ? {
                ...t,
                status: 'CLOSED' as const,
                exit_price: t.current_price,
                closed_at: closedAt,
              }
            : t
        );

      if (activeWorkspace === 'DEMO') {
        setDemoTrades(updater);
      } else {
        setLiveTrades(updater);
      }

      // DEMO positions are worker-owned paper trades too, so persist both modes.
      if (!isDemoMode && isAuthenticated && supabase) {
        try {
          await supabase
            .from('trades')
            .update({
              status: 'CLOSED',
              exit_price: target.current_price,
              profit_usdt: target.profit_usdt,
              profit_pct: target.profit_pct,
              closed_at: closedAt,
            })
            .eq('id', tradeId);
        } catch (err) {
          console.error('Close trade error:', err);
        }
      }

      appendLog(activeWorkspace, {
        id: createUniqueId('LOG'),
        level: 'TRADE',
        pair: target.pair,
        message: `CLOSED ${target.pair} @ $${target.current_price} | PnL ${
          target.profit_usdt >= 0 ? '+' : ''
        }$${target.profit_usdt.toFixed(2)} USDT`,
        created_at: closedAt,
      });

      await notifyTelegramIfConfigured(
        `CLOSED ${target.pair} @ $${target.current_price} · PnL: ${
          target.profit_usdt >= 0 ? '+' : ''
        }$${target.profit_usdt.toFixed(2)} USDT`,
        activeWorkspace
      );
    },
    [
      activeWorkspace,
      appendLog,
      isAuthenticated,
      isDemoMode,
      notifyTelegramIfConfigured,
      settings.zero_loss_mode,
      trades,
    ]
  );

  /**
   * Emergency "Close All": market-closes every open position in the active workspace,
   * reports total realized PnL, and returns paper proceeds to the DEMO balance.
   */
  const closeAllPositions = useCallback(async () => {
    const openList = trades.filter((t) => t.status === 'OPEN');
    if (openList.length === 0) {
      audioSynth.playTradeChime(false);
      return { closed: 0, realizedPnl: 0 };
    }

    const closedAt = new Date().toISOString();
    const closedIds = new Set<string>();
    let realized = 0;

    for (const tr of openList) {
      const exitPx = tr.current_price > 0 ? tr.current_price : tr.entry_price;
      if (activeWorkspace === 'LIVE') {
        const sell = await submitLiveOrder(tr.pair, 'SELL', 0, tr.quantity);
        if (!sell.ok) {
          appendLog('LIVE', {
            id: createUniqueId('LOG'),
            level: 'ERROR',
            pair: tr.pair,
            message: `CLOSE ALL skipped ${tr.pair}: ${sell.error ?? 'Binance rejected the sell'} — position kept open.`,
            created_at: new Date().toISOString(),
          });
          continue;
        }
      }
      const pnl = Number(((exitPx - tr.entry_price) * tr.quantity).toFixed(2));
      realized += pnl;
      closedIds.add(tr.id);

      if (!isDemoMode && isAuthenticated && supabase) {
        try {
          await supabase
            .from('trades')
            .update({
              status: 'CLOSED',
              exit_price: exitPx,
              profit_usdt: pnl,
              profit_pct: Number(
                ((pnl / Math.max(0.01, tr.invested_usdt)) * 100).toFixed(2)
              ),
              closed_at: closedAt,
            })
            .eq('id', tr.id);
        } catch (err) {
          console.error('Close-all persistence error:', err);
        }
      }
    }

    if (closedIds.size === 0) {
      audioSynth.playTradeChime(false);
      return { closed: 0, realizedPnl: 0 };
    }

    const updater = (prev: Trade[]) =>
      prev.map((t) => {
        if (!closedIds.has(t.id)) return t;
        const exitPx = t.current_price > 0 ? t.current_price : t.entry_price;
        return {
          ...t,
          status: 'CLOSED' as const,
          exit_price: exitPx,
          profit_usdt: Number(((exitPx - t.entry_price) * t.quantity).toFixed(2)),
          profit_pct: Number(
            ((((exitPx - t.entry_price) * t.quantity) / Math.max(0.01, t.invested_usdt)) * 100).toFixed(
              2
            )
          ),
          closed_at: closedAt,
        };
      });

    setDemoTrades(updater);
    setLiveTrades(updater);

    if (activeWorkspace === 'DEMO') {
      // Paper equity base already excludes open exposure (stats adds open PnL back),
      // so only the realized result moves the DEMO balance.
      const nextBalance = Number(
        ((demoSettingsRef.current.balance_usdt ?? 0) + realized).toFixed(2)
      );
      setDemoSettings((prev) => ({ ...prev, balance_usdt: nextBalance }));
      if (!isDemoMode && isAuthenticated && supabase) {
        const rowId = settingsRowIdRef.current;
        if (rowId !== null) {
          void supabase
            .from('settings')
            .update({ virtual_balance: nextBalance })
            .eq('id', rowId)
            .then(() => {});
        }
      }
    }

    audioSynth.playTradeChime(realized >= 0);
    if (voiceAnnouncer.isEnabled()) {
      if (realized >= 0) voiceAnnouncer.successChime();
      else voiceAnnouncer.lossTone();
      voiceAnnouncer.speak(
        `Emergency close complete. ${closedIds.size} position${
          closedIds.size === 1 ? '' : 's'
        } closed. Net ${realized >= 0 ? 'profit' : 'loss'} ${Math.abs(realized).toFixed(2)} dollars.`
      );
    }

    const summary = `🛑 CLOSE ALL ${activeWorkspace} — ${closedIds.size} position${
      closedIds.size === 1 ? '' : 's'
    } closed · Realized PnL ${realized >= 0 ? '+' : ''}$${realized.toFixed(2)} USDT`;
    appendLog(activeWorkspace, {
      id: createUniqueId('LOG'),
      level: 'TRADE',
      pair: null,
      message: summary,
      created_at: closedAt,
    });
    await notifyTelegramIfConfigured(summary, activeWorkspace);

    return { closed: closedIds.size, realizedPnl: Number(realized.toFixed(2)) };
  }, [
    activeWorkspace,
    appendLog,
    isAuthenticated,
    isDemoMode,
    notifyTelegramIfConfigured,
    submitLiveOrder,
    trades,
  ]);

  const resetVirtualBalance = useCallback(
    (amount = 10000) => {
      audioSynth.playToggle(true);
      setDemoSettings((prev) => ({ ...prev, balance_usdt: amount }));
      setDemoTrades(INITIAL_DEMO_TRADES);
      if (supabase && isAuthenticated && !isDemoMode) {
        supabase
          .from('settings')
          .update({ virtual_balance: amount })
          .eq('id', settingsRowIdRef.current ?? demoSettings.id)
          .then(() => {});
      }
      appendLog('DEMO', {
        id: createUniqueId('LOG'),
        level: 'INFO',
        pair: null,
        message: `Virtual Demo balance reset to $${amount.toLocaleString('en-US')}.00 USDT.`,
        created_at: new Date().toISOString(),
      });
    },
    [appendLog, demoSettings.id, isAuthenticated, isDemoMode]
  );

  const refreshBinanceBalance = useCallback(
    async (
      cfgOverride?: BinanceConfig,
      options?: { announce?: boolean }
    ): Promise<BinanceAccountSummary & { ok: boolean }> => {
      const activeCfg = cfgOverride ?? binanceConfig;
      const apiKey = activeCfg.api_key.trim();
      const apiSecret = activeCfg.api_secret.trim();
      // The worker owns this workspace's key vault, so local keys are only an
      // override — the account is visible without them ever leaving the server.
      const scopeQuery = `?telegram_user_id=${encodeURIComponent(
        identityRef.current.telegramUserId
      )}`;

      if (isGuest) {
        // Never ask the worker for the shared demo vault as an anonymous guest.
        const errSummary: BinanceAccountSummary & { ok: boolean } = {
          ok: false,
          connected: false,
          usdtFree: 0,
          usdtLocked: 0,
          totalUsdt: 0,
          totalPortfolioUsd: 0,
          assets: [],
          canTrade: false,
          lastSyncedAt: new Date().toISOString(),
          errorDetail: 'Create an account to link real Binance keys',
        };
        setBinanceAccount(errSummary);
        return errSummary;
      }

      setSyncingBalance(true);
      try {
        // Always the 24/7 worker: the static frontend origin answers /api/* with
        // index.html (HTTP 200), which used to look like a broken verification.
        const res = await fetch(`${WORKER_URL}/api/balance${scopeQuery}`, {
          method: 'POST',
          headers: workerAuthHeaders(),
          body: JSON.stringify({
            apiKey,
            apiSecret,
            testnet: activeCfg.use_testnet,
          }),
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};

        if (res.ok && (data.ok || data.usdtBalance !== undefined || data.totalUsdt !== undefined)) {
          const usdtBal = pickPortfolioUsd(data);
          // usdtFree is the only spendable cash (Spot USDT). Never fall back to the
          // portfolio total here, or coins/Funding would look like tradeable cash.
          const usdtFree = Number(data.usdtFree ?? 0);
          const summary: BinanceAccountSummary & { ok: boolean } = {
            ok: true,
            connected: true,
            usdtFree,
            usdtLocked: Number(data.usdtLocked ?? 0),
            totalUsdt: usdtBal,
            totalPortfolioUsd: usdtBal,
            spotUsd: Number(data.spotUsd ?? usdtFree),
            spotCoinsUsd: Number(data.spotCoinsUsd ?? 0),
            fundingUsd: Number(data.fundingUsd ?? 0),
            earnUsd: Number(data.earnUsd ?? 0),
            walletBreakdown: Array.isArray(data.walletBreakdown) && data.walletBreakdown.length > 0
              ? data.walletBreakdown
              : [{ walletName: 'Spot', balanceUsd: usdtBal }],
            assets: Array.isArray(data.assets) ? data.assets : [],
            canTrade: usdtFree >= MIN_TRADEABLE_USDT,
            lastSyncedAt: new Date().toISOString(),
            errorDetail: null,
          };
          setBinanceAccount(summary);
          setLiveSettings((prev) => ({ ...prev, balance_usdt: usdtBal }));
          if (options?.announce) {
            voiceAnnouncer.unlock();
            voiceAnnouncer.speak(balanceSentence('LIVE', usdtBal));
          }
          return summary;
        }

        const errSummary: BinanceAccountSummary & { ok: boolean } = {
          ok: false,
          connected: false,
          usdtFree: 0,
          usdtLocked: 0,
          totalUsdt: 0,
          totalPortfolioUsd: 0,
          assets: [],
          canTrade: false,
          lastSyncedAt: new Date().toISOString(),
          errorDetail: data.error || data.detail || `Binance HTTP ${res.status}`,
        };
        setBinanceAccount(errSummary);
        setLiveSettings((prev) => ({ ...prev, balance_usdt: 0 }));
        return errSummary;
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Live balance service unreachable — check VITE_WORKER_URL and that the worker is awake';
        console.warn('[useTradingTerminal] Binance balance fetch failed:', msg);
        const errSummary: BinanceAccountSummary & { ok: boolean } = {
          ok: false,
          connected: false,
          usdtFree: 0,
          usdtLocked: 0,
          totalUsdt: 0,
          totalPortfolioUsd: 0,
          assets: [],
          canTrade: false,
          lastSyncedAt: new Date().toISOString(),
          errorDetail: msg,
        };
        setBinanceAccount(errSummary);
        setLiveSettings((prev) => ({ ...prev, balance_usdt: 0 }));
        return errSummary;
      } finally {
        setSyncingBalance(false);
      }
    },
    [binanceConfig, isDemoMode, isGuest, liveSettings.id]
  );

  // Auto-sync the real Binance portfolio on mount and every 30s. Keys saved to the
  // worker vault count too: the browser never needs the secret back to see money.
  useEffect(() => {
    const hasLocalKeys = Boolean(
      binanceConfig.api_key.trim() && binanceConfig.api_secret.trim()
    );
    if (isGuest || (!hasLocalKeys && !apiKeyStatus.linked)) {
      setBinanceAccount(null);
      setLiveSettings((prev) => (prev.balance_usdt !== 0 ? { ...prev, balance_usdt: 0 } : prev));
      return;
    }
    void refreshBinanceBalance();
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void refreshBinanceBalance();
      }
    }, 30_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    binanceConfig.api_key,
    binanceConfig.api_secret,
    binanceConfig.use_testnet,
    apiKeyStatus.linked,
    isGuest,
  ]);

  const testTelegramConnection = useCallback(
    async (cfg: TelegramConfig) => {
      setTelegramConfig(cfg);
      const token = cfg.bot_token.trim();
      const chatId = cfg.chat_id.trim();
      console.info('[useTradingTerminal] testTelegramConnection initiated:', {
        workspace: activeWorkspace,
        hasToken: Boolean(token),
        chatId,
        notifyBalance: cfg.notify_balance !== false,
      });

      if (!token || !chatId) {
        const detail = !token ? 'Missing Telegram Bot Token' : 'Missing Telegram Chat ID';
        console.error('[useTradingTerminal] testTelegramConnection aborted:', { detail });
        appendLog(activeWorkspace, {
          id: createUniqueId('LOG'),
          level: 'ERROR',
          pair: null,
          message: `Telegram test aborted: ${detail}`,
          created_at: new Date().toISOString(),
        });
        return { ok: false, detail };
      }

      const currentBalance = stats.balance;
      const bdtBalance = Math.round(currentBalance * BDT_PER_USD);
      const messageText =
        `<b>[AEGIS QUANT TERMINAL — ${activeWorkspace}]</b>\n` +
        `🟢 <b>Telegram Test Notification Verified!</b>\n` +
        `💰 <b>Current Balance (${activeWorkspace}):</b> $${currentBalance.toFixed(2)} USD (৳${bdtBalance.toLocaleString('en-US')} BDT)\n` +
        `📊 <b>Active Positions:</b> ${stats.openTradesCount}\n` +
        `⚡ <b>Bot Status:</b> ${botStatus}\n` +
        `🔑 <b>Binance Keys:</b> ${binanceConfig.api_key.trim() ? 'Linked ✓' : 'Not Set'}`;

      const res = await dispatchTelegramAlert(cfg, messageText);
      if (res.ok) {
        console.info('[useTradingTerminal] testTelegramConnection succeeded:', res);
      } else {
        console.error('[useTradingTerminal] testTelegramConnection failed:', res);
      }

      appendLog(activeWorkspace, {
        id: createUniqueId('LOG'),
        level: res.ok ? 'INFO' : 'ERROR',
        pair: null,
        message: res.ok
          ? `Telegram test alert delivered! Balance: $${currentBalance.toFixed(2)} (৳${bdtBalance.toLocaleString('en-US')})`
          : `Telegram test failed: ${res.detail}`,
        created_at: new Date().toISOString(),
      });
      return res;
    },
    [activeWorkspace, appendLog, binanceConfig.api_key, botStatus, stats.balance, stats.openTradesCount]
  );

  const sendTelegramBalanceSnapshot = useCallback(
    async (cfgOverride?: TelegramConfig, bnCfgOverride?: BinanceConfig) => {
      const activeTg = cfgOverride ?? telegramConfig;
      const activeBn = bnCfgOverride ?? binanceConfig;
      setTelegramConfig(activeTg);
      if (bnCfgOverride) {
        setBinanceConfig(bnCfgOverride);
      }

      console.info('[useTradingTerminal] sendTelegramBalanceSnapshot initiated:', {
        workspace: activeWorkspace,
        hasTgToken: Boolean(activeTg.bot_token.trim()),
        chatId: activeTg.chat_id.trim(),
        hasBinanceKeys: Boolean(activeBn.api_key.trim() && activeBn.api_secret.trim()),
      });

      let liveUsd = stats.balance;
      let usdtFree = binanceAccount?.usdtFree ?? 0;
      let spotUsd = binanceAccount?.spotUsd ?? 0;
      let fundingUsd = binanceAccount?.fundingUsd ?? 0;
      let earnUsd = binanceAccount?.earnUsd ?? 0;
      let assetsLines = '';
      let syncNote = '';

      if (activeBn.api_key.trim() && activeBn.api_secret.trim()) {
        const synced = await refreshBinanceBalance(activeBn);
        if (synced.ok) {
          liveUsd = pickPortfolioUsd(synced);
          usdtFree = synced.usdtFree;
          spotUsd = synced.spotUsd ?? 0;
          fundingUsd = synced.fundingUsd ?? 0;
          earnUsd = synced.earnUsd ?? 0;
          if (synced.assets.length > 0) {
            assetsLines =
              '\n🪙 <b>Binance Holdings:</b>\n' +
              synced.assets
                .slice(0, 6)
                .map((a) => `• ${a.asset}: ${a.total} ($${a.usdValue.toFixed(2)})`)
                .join('\n');
          }
          syncNote = `\n🏦 <b>Wallets:</b> Spot $${spotUsd.toFixed(2)} · Funding $${fundingUsd.toFixed(2)} · Earn $${earnUsd.toFixed(2)}`;
        } else {
          syncNote = `\n⚠️ <b>Binance Sync Note:</b> ${synced.errorDetail || 'Unable to sync'}`;
        }
      }

      const bdtTotal = Math.round(liveUsd * BDT_PER_USD);
      const payloadText =
        `<b>[AEGIS REAL MONEY SNAPSHOT — ${activeWorkspace}]</b>\n` +
        `💵 <b>Total Real Balance:</b> $${liveUsd.toFixed(2)} USD\n` +
        `🇧🇩 <b>Bangladeshi Taka:</b> ৳${bdtTotal.toLocaleString('en-US')} BDT\n` +
        `🟢 <b>Available USDT:</b> $${usdtFree.toFixed(2)} USDT\n` +
        `📈 <b>Today Profit:</b> ${stats.todayProfit >= 0 ? '+' : ''}$${stats.todayProfit.toFixed(2)}\n` +
        `📊 <b>Open Trades:</b> ${stats.openTradesCount} · <b>Bot:</b> ${botStatus}` +
        syncNote +
        assetsLines;

      const res = await dispatchTelegramAlert(activeTg, payloadText);
      voiceAnnouncer.unlock();
      voiceAnnouncer.speak(balanceSentence(activeWorkspace, liveUsd));
      if (res.ok) {
        console.info('[useTradingTerminal] sendTelegramBalanceSnapshot succeeded:', res);
      } else {
        console.error('[useTradingTerminal] sendTelegramBalanceSnapshot failed:', res);
      }

      appendLog(activeWorkspace, {
        id: createUniqueId('LOG'),
        level: res.ok ? 'INFO' : 'ERROR',
        pair: null,
        message: res.ok
          ? `Sent Real Balance Snapshot to Telegram ($${liveUsd.toFixed(2)} / ৳${bdtTotal.toLocaleString('en-US')})`
          : `Telegram balance snapshot failed: ${res.detail}`,
        created_at: new Date().toISOString(),
      });
      return res;
    },
    [
      activeWorkspace,
      appendLog,
      binanceAccount?.earnUsd,
      binanceAccount?.fundingUsd,
      binanceAccount?.spotUsd,
      binanceAccount?.usdtFree,
      binanceConfig,
      botStatus,
      refreshBinanceBalance,
      stats.balance,
      stats.openTradesCount,
      stats.todayProfit,
      telegramConfig,
    ]
  );

  const sendSignalToTelegram = useCallback(
    async (title: string, detail: string, options?: { force?: boolean }) => {
      const token = telegramConfig.bot_token.trim();
      const chatId = telegramConfig.chat_id.trim();
      console.info('[useTradingTerminal] sendSignalToTelegram invoked:', {
        workspace: activeWorkspace,
        telegramEnabled: settings.telegram_enabled,
        force: Boolean(options?.force),
        hasToken: Boolean(token),
        chatId,
        title,
      });

      if (!settings.telegram_enabled && !options?.force) {
        console.warn('[useTradingTerminal] sendSignalToTelegram skipped: telegram_enabled is false in settings');
        return { ok: false, detail: 'Telegram signal switch is OFF' };
      }

      if (!token || !chatId) {
        console.error('[useTradingTerminal] sendSignalToTelegram failed: missing credentials', {
          hasToken: Boolean(token),
          hasChatId: Boolean(chatId),
        });
        return { ok: false, detail: 'Missing Telegram Bot Token or Chat ID' };
      }

      const bdtVal = Math.round(stats.balance * BDT_PER_USD);
      const balanceLine =
        telegramConfig.notify_balance !== false
          ? `\n💰 <b>Balance:</b> $${stats.balance.toFixed(2)} (৳${bdtVal.toLocaleString('en-US')})`
          : '';
      const payloadText = `<b>[AEGIS SIGNAL — ${activeWorkspace}]</b>\n${title}\n${detail}${balanceLine}`;

      const res = await dispatchTelegramAlert(telegramConfig, payloadText);
      if (res.ok) {
        console.info('[useTradingTerminal] sendSignalToTelegram succeeded:', res);
      } else {
        console.error('[useTradingTerminal] sendSignalToTelegram delivery error:', res);
        appendLog(activeWorkspace, {
          id: createUniqueId('LOG'),
          level: 'ERROR',
          pair: null,
          message: `Telegram signal delivery failed: ${res.detail}`,
          created_at: new Date().toISOString(),
        });
      }
      return res;
    },
    [activeWorkspace, appendLog, settings.telegram_enabled, stats.balance, telegramConfig]
  );

  const togglePairAlert = useCallback((symbol: string) => {
    setAlertEnabledPairs((prev) => {
      const exists = prev.includes(symbol);
      audioSynth.playToggle(!exists);
      return exists ? prev.filter((s) => s !== symbol) : [...prev, symbol];
    });
  }, []);

  const verifyBinanceCredentials = useCallback(
    async (cfg: BinanceConfig) => {
      const trimmedCfg: BinanceConfig = {
        ...cfg,
        api_key: cfg.api_key.trim(),
        api_secret: cfg.api_secret.trim(),
      };
      if (trimmedCfg.api_key.length < 16 || trimmedCfg.api_secret.length < 16) {
        setBinanceConfig({ ...trimmedCfg, verified: false });
        appendLog('LIVE', {
          id: createUniqueId('LOG'),
          level: 'ERROR',
          pair: null,
          message: 'Binance verification failed: API Key and Secret must be at least 16 characters.',
          created_at: new Date().toISOString(),
        });
        return {
          ok: false,
          detail: 'Invalid key or secret length (min 16 chars)',
        };
      }

      setBinanceConfig(trimmedCfg);
      try {
        // Worker-only: verifying against the static origin returns index.html (HTTP 200).
        const res = await fetch(`${WORKER_URL}/api/verify-keys`, {
          method: 'POST',
          headers: workerAuthHeaders(),
          body: JSON.stringify({
            apiKey: trimmedCfg.api_key,
            apiSecret: trimmedCfg.api_secret,
            testnet: trimmedCfg.use_testnet,
            telegram_user_id: identityRef.current.telegramUserId,
            initData: identityRef.current.initData,
          }),
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (res.ok && (data.ok || data.usdtBalance !== undefined || data.totalUsdt !== undefined)) {
          const usdtBalance = pickPortfolioUsd(data);
          const bdtVal = Math.round(usdtBalance * BDT_PER_USD);
          setBinanceConfig({ ...trimmedCfg, verified: true });
          setLiveSettings((prev) => ({ ...prev, balance_usdt: usdtBalance }));
          appendLog('LIVE', {
            id: createUniqueId('LOG'),
            level: 'INFO',
            pair: null,
            message: `Binance API verified (${
              trimmedCfg.use_testnet ? 'TESTNET' : 'MAINNET'
            })! USDT Balance: $${usdtBalance.toFixed(2)} USD (৳${bdtVal.toLocaleString('en-US')} BDT)`,
            created_at: new Date().toISOString(),
          });
          return {
            ok: true,
            detail: `Connected ✓ USDT Balance: $${usdtBalance.toFixed(2)} (৳${bdtVal.toLocaleString('en-US')})`,
          };
        }
        const errDetail = data.error || data.detail || `Verification failed (HTTP ${res.status})`;
        appendLog('LIVE', {
          id: createUniqueId('LOG'),
          level: 'ERROR',
          pair: null,
          message: `Binance verification error: ${errDetail}`,
          created_at: new Date().toISOString(),
        });
        return { ok: false, detail: errDetail };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Network error verifying keys';
        appendLog('LIVE', {
          id: createUniqueId('LOG'),
          level: 'ERROR',
          pair: null,
          message: `Binance verification exception: ${msg}`,
          created_at: new Date().toISOString(),
        });
        return { ok: false, detail: msg };
      }
    },
    [appendLog, refreshBinanceBalance]
  );

  /* --------------------------------------------------------------------- *
   * Per-user Binance key vault: the worker stores secrets that the browser can
   * never read back, and only ever returns a mask.
   * --------------------------------------------------------------------- */

  const saveUserBinanceKeys = useCallback(async (cfg: BinanceConfig) => {
    const me = identityRef.current;
    const apiKey = cfg.api_key.trim();
    const apiSecret = cfg.api_secret.trim();
    if (apiKey.length < 16 || apiSecret.length < 16) {
      return { ok: false, detail: 'API key and secret must be at least 16 characters' };
    }
    try {
      const res = await fetch(`${WORKER_URL}/api/user/keys`, {
        method: 'POST',
        headers: workerAuthHeaders(),
        body: JSON.stringify({
          telegram_user_id: me.telegramUserId,
          initData: me.initData,
          api_key: apiKey,
          api_secret: apiSecret,
          use_testnet: cfg.use_testnet,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        api_key_masked?: string;
        use_testnet?: boolean;
      };
      if (!res.ok || data.ok === false) {
        return { ok: false, detail: String(data.error || `Vault write failed (HTTP ${res.status})`) };
      }
      setApiKeyStatus({
        linked: true,
        api_key_masked: data.api_key_masked ?? null,
        use_testnet: Boolean(data.use_testnet),
      });
      return { ok: true, detail: 'Saved to your private key vault' };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : 'Could not reach the key vault',
      };
    }
  }, []);

  const loadUserApiKeyStatus = useCallback(async () => {
    const me = identityRef.current;
    try {
      const query = new URLSearchParams({ telegram_user_id: me.telegramUserId });
      if (me.initData) query.set('initData', me.initData);
      const res = await fetch(`${WORKER_URL}/api/user/keys?${query.toString()}`, {
        headers: workerAuthHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as Partial<UserApiKeyStatus>;
      setApiKeyStatus({
        linked: Boolean(data.linked),
        api_key_masked: data.api_key_masked ?? null,
        use_testnet: Boolean(data.use_testnet),
        updated_at: data.updated_at ?? null,
      });
    } catch {
      // Worker asleep — keep the last known vault state.
    }
  }, []);

  const testUserBinanceConnection = useCallback(async () => {
    const me = identityRef.current;
    setSyncingBalance(true);
    try {
      const res = await fetch(`${WORKER_URL}/api/user/keys/test`, {
        method: 'POST',
        headers: workerAuthHeaders(),
        body: JSON.stringify({ telegram_user_id: me.telegramUserId, initData: me.initData }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        totalPortfolioUsd?: number;
        usdtFree?: number;
        usdtLocked?: number;
        spotUsd?: number;
        spotCoinsUsd?: number;
        fundingUsd?: number;
        earnUsd?: number;
        assets?: BinanceAccountSummary['assets'];
        api_key_masked?: string;
        use_testnet?: boolean;
      };
      if (!res.ok || data.ok === false) {
        return { ok: false, detail: String(data.error || `Test failed (HTTP ${res.status})`) };
      }
      const usdtBal = pickPortfolioUsd(data);
      const spotUsd = Number(data.spotUsd ?? data.usdtFree ?? 0);
      const fundingUsd = Number(data.fundingUsd ?? 0);
      const earnUsd = Number(data.earnUsd ?? 0);
      setApiKeyStatus({
        linked: true,
        api_key_masked: data.api_key_masked ?? null,
        use_testnet: Boolean(data.use_testnet),
      });
      setBinanceAccount({
        connected: true,
        usdtFree: Number(data.usdtFree ?? 0),
        usdtLocked: Number(data.usdtLocked ?? 0),
        totalUsdt: usdtBal,
        totalPortfolioUsd: usdtBal,
        spotUsd,
        spotCoinsUsd: Number(data.spotCoinsUsd ?? 0),
        fundingUsd,
        earnUsd,
        walletBreakdown: [
          { walletName: 'Spot', balanceUsd: spotUsd },
          { walletName: 'Funding', balanceUsd: fundingUsd },
          { walletName: 'Earn', balanceUsd: earnUsd },
        ].filter((wallet) => wallet.balanceUsd > 0),
        assets: Array.isArray(data.assets) ? data.assets : [],
        canTrade: Number(data.usdtFree ?? 0) >= MIN_TRADEABLE_USDT,
        lastSyncedAt: new Date().toISOString(),
        errorDetail: null,
      });
      setLiveSettings((prev) => ({ ...prev, balance_usdt: usdtBal }));
      return {
        ok: true,
        detail: `Connected ✓ Portfolio $${usdtBal.toFixed(2)} · Spot $${Number(
          data.usdtFree ?? 0
        ).toFixed(2)} (৳${Math.round(usdtBal * BDT_PER_USD).toLocaleString('en-US')})`,
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : 'Could not reach Binance',
      };
    } finally {
      setSyncingBalance(false);
    }
  }, []);

  /**
   * One click in Settings: write both keys to the worker vault, then immediately
   * test them and load the real portfolio so the header + card update without a
   * page reload and the badge flips to LINKED.
   */
  const saveAndVerifyUserBinanceKeys = useCallback(
    async (cfg: BinanceConfig) => {
      const saved = await saveUserBinanceKeys(cfg);
      if (!saved.ok) return saved;
      const tested = await testUserBinanceConnection();
      if (!tested.ok) {
        return { ok: true, detail: `${saved.detail} · balance sync: ${tested.detail}` };
      }
      await refreshBinanceBalance();
      return { ok: true, detail: `${saved.detail} · ${tested.detail}` };
    },
    [refreshBinanceBalance, saveUserBinanceKeys, testUserBinanceConnection]
  );

  /** Change password for the signed-in account (Supabase Auth owns the hash). */
  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (!supabase) return { ok: false, detail: 'Supabase is not configured' };
      const email = accountRef.current?.email;
      if (!email) return { ok: false, detail: 'Sign in again to change your password' };
      if (newPassword.length < 8) {
        return { ok: false, detail: 'New password must be at least 8 characters' };
      }
      const { data, error: verifyError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      });
      if (verifyError) return { ok: false, detail: 'Current password is incorrect' };
      if (data.session) accessTokenRef.current = data.session.access_token;
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) return { ok: false, detail: error.message };
      return { ok: true, detail: 'Password updated — use it next time you sign in.' };
    },
    []
  );

  /** Step 1 of Telegram reset: the worker DMs a 6-digit code via @TaseenMarketBot. */
  const requestPasswordResetCode = useCallback(async (email: string) => {
    try {
      const res = await fetch(`${WORKER_URL}/api/auth/reset-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || data.ok === false) {
        return { ok: false, detail: String(data.error || `Reset request failed (HTTP ${res.status})`) };
      }
      return {
        ok: true,
        detail: String(data.message || 'Code sent. Check @TaseenMarketBot on Telegram.'),
      };
    } catch {
      return {
        ok: false,
        detail: 'Could not reach the reset service — the worker may be waking up. Try again.',
      };
    }
  }, []);

  /** Step 2 of Telegram reset: verify the code and set the new password. */
  const confirmPasswordResetCode = useCallback(
    async (email: string, code: string, newPassword: string) => {
      try {
        const res = await fetch(`${WORKER_URL}/api/auth/reset-confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), code: code.trim(), new_password: newPassword }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
        if (!res.ok || data.ok === false) {
          return { ok: false, detail: String(data.error || `Reset failed (HTTP ${res.status})`) };
        }
        return { ok: true, detail: String(data.message || 'Password updated. Sign in now.') };
      } catch {
        return { ok: false, detail: 'Could not reach the reset service. Try again.' };
      }
    },
    []
  );

  const refreshLeaderboard = useCallback(async () => {
    setLeaderboardLoading(true);
    try {
      const res = await fetch(`${WORKER_URL}/api/leaderboard`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as { entries?: LeaderboardEntry[] };
      setLeaderboard(Array.isArray(data.entries) ? data.entries : []);
    } catch {
      // Leaderboard is informational; a sleeping worker must not break the UI.
    } finally {
      setLeaderboardLoading(false);
    }
  }, []);

  // Hydrate the vault badge and the public board once signed in, then refresh the
  // board periodically so ranks stay live without a websocket.
  useEffect(() => {
    if (!isAuthenticated) return;
    void loadUserApiKeyStatus();
    void refreshLeaderboard();
    const timer = window.setInterval(() => void refreshLeaderboard(), 120_000);
    return () => window.clearInterval(timer);
  }, [isAuthenticated, loadUserApiKeyStatus, refreshLeaderboard]);

  /** Re-reads the approval status so the pending screen can flip to the terminal. */
  const refreshAccount = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    accessTokenRef.current = data.session?.access_token ?? null;
    if (data.session?.user) await loadAccountProfile(data.session.user);
  }, [loadAccountProfile]);

  /** Edits the signed-in user's own name/photo (RLS restricts it to their row). */
  const updateUserProfile = useCallback(
    async (patch: { full_name?: string; avatar_url?: string | null }) => {
      if (!supabase || !accountRef.current?.id) {
        return { ok: false, detail: 'Sign in to edit your profile' };
      }
      const payload: Record<string, unknown> = {};
      if (patch.full_name !== undefined) {
        const name = patch.full_name.trim();
        if (!name) return { ok: false, detail: 'Full name cannot be empty' };
        payload.full_name = name;
      }
      if (patch.avatar_url !== undefined) {
        const avatar = String(patch.avatar_url || '').trim();
        if (
          avatar &&
          !/^data:image\/(png|jpeg|webp);base64,/.test(avatar) &&
          !/^https?:\/\//.test(avatar)
        ) {
          return { ok: false, detail: 'Unsupported image format' };
        }
        if (avatar.length > 400_000) return { ok: false, detail: 'Image is too large' };
        payload.avatar_url = avatar || null;
      }
      if (Object.keys(payload).length === 0) return { ok: true, detail: 'Nothing to update' };

      const { data, error } = await supabase
        .from('users')
        .update(payload)
        .eq('id', accountRef.current.id)
        .select('*')
        .maybeSingle();
      if (error) return { ok: false, detail: error.message };
      if (data) {
        const profile = normalizeAccount(data as Record<string, unknown>);
        accountRef.current = profile;
        setAccount(profile);
      }
      return { ok: true, detail: 'Profile updated' };
    },
    []
  );

  /** Admin panel: every account with aggregates (worker verifies the session). */
  const refreshAdminUsers = useCallback(async () => {
    if (!accessTokenRef.current) return;
    setAdminLoading(true);
    setAdminError(null);
    try {
      const res = await fetch(`${WORKER_URL}/api/admin/users`, {
        headers: workerAuthHeaders(),
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        entries?: AdminUserRow[];
        totals?: {
          users: number;
          pending: number;
          approved: number;
          rejected: number;
          pnl_usd: number;
          pnl_bdt: number;
        };
      };
      if (!res.ok || data.ok === false) {
        setAdminError(String(data.error || `Admin API HTTP ${res.status}`));
        setAdminUsers([]);
        return;
      }
      setAdminUsers(Array.isArray(data.entries) ? data.entries : []);
      setAdminTotals(data.totals ?? null);
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Admin service unreachable');
    } finally {
      setAdminLoading(false);
    }
  }, [workerAuthHeaders]);

  const reviewUser = useCallback(
    async (userId: string, decision: 'approve' | 'reject') => {
      try {
        const res = await fetch(`${WORKER_URL}/api/admin/approval`, {
          method: 'POST',
          headers: workerAuthHeaders(),
          body: JSON.stringify({ user_id: userId, decision }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          email?: string;
        };
        if (!res.ok || data.ok === false) {
          return { ok: false, detail: String(data.error || `HTTP ${res.status}`) };
        }
        await refreshAdminUsers();
        return {
          ok: true,
          detail: `${decision === 'approve' ? 'Approved' : 'Rejected'} ${data.email ?? 'user'}`,
        };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : 'Approval request failed',
        };
      }
    },
    [refreshAdminUsers, workerAuthHeaders]
  );

  useEffect(() => {
    if (!isAdmin) return;
    void refreshAdminUsers();
  }, [isAdmin, refreshAdminUsers]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) {
      setIsDemoMode(true);
      setIsAuthenticated(true);
      return { error: null };
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error && data.session) {
      accessTokenRef.current = data.session.access_token;
      setIsDemoMode(false);
      setIsGuest(false);
      setUserEmail(data.session.user.email ?? null);
      // This account starts from an EMPTY vault until its own keys are read back.
      resetLocalApiKeys();
      await loadAccountProfile(data.session.user);
      setIsAuthenticated(true);
    }
    return { error: error ? error.message : null };
  }, [loadAccountProfile, resetLocalApiKeys]);

  const signUp = useCallback(
    async (
      email: string,
      password: string,
      profile?: {
        fullName?: string;
        avatarUrl?: string | null;
        telegramChatId?: string | null;
        telegramUsername?: string | null;
      }
    ) => {
      if (!supabase) {
        return { error: null, message: 'Preview mode active — connect Supabase keys to register real operator account.' };
      }
      const me = identityRef.current;
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          // Read by the `handle_new_user` trigger to create the pending profile.
          data: {
            full_name: profile?.fullName?.trim() || me.displayName,
            avatar_url: String(profile?.avatarUrl ?? me.photoUrl ?? '').trim(),
            telegram_chat_id: String(profile?.telegramChatId ?? me.chatId ?? '').trim(),
            telegram_username: String(profile?.telegramUsername ?? me.username ?? '').trim(),
          },
        },
      });
      if (error) {
        return { error: error.message };
      }
      if (data.session) {
        accessTokenRef.current = data.session.access_token;
        setIsDemoMode(false);
        setIsGuest(false);
        setUserEmail(data.session.user.email ?? null);
        resetLocalApiKeys();
        await loadAccountProfile(data.session.user);
        setIsAuthenticated(true);
        return { error: null };
      }
      return {
        error: null,
        message:
          'Account created and submitted for admin approval. Confirm your email if Supabase asks, then sign in to see your approval status.',
      };
    },
    [loadAccountProfile, resetLocalApiKeys]
  );

  const resetPassword = useCallback(async (email: string) => {
    if (!supabase) {
      return { error: null, message: 'Connect Supabase keys to send password reset email.' };
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) return { error: error.message };
    return { error: null, message: 'Password reset link sent to your email.' };
  }, []);

  const signOut = useCallback(async () => {
    if (supabase && !isDemoMode) {
      await supabase.auth.signOut();
    }
    accessTokenRef.current = null;
    accountRef.current = null;
    setAccount(null);
    setIsAuthenticated(false);
    setIsGuest(false);
    setIsDemoMode(false);
    // Leaving the session must leave no trace of this trader's exchange keys.
    resetLocalApiKeys();
  }, [isDemoMode, resetLocalApiKeys]);

  const enterDemoMode = useCallback(() => {
    setIsDemoMode(true);
    setIsAuthenticated(true);
    setIsGuest(false);
    setUserEmail('demo-operator@aegis.local');
  }, []);

  /** Browse the terminal without an account: DEMO only, nothing persisted. */
  const enterGuestMode = useCallback(() => {
    setIsDemoMode(true);
    setIsGuest(true);
    setIsAuthenticated(false);
    setUserEmail(null);
    setActiveWorkspace('DEMO');
    saveJson(STORAGE_WORKSPACE_KEY, 'DEMO');
  }, []);

  const exitGuestMode = useCallback(() => {
    setIsGuest(false);
    setIsDemoMode(false);
  }, []);

  const hasBinanceKeys = Boolean(
    !isGuest &&
      ((binanceConfig.api_key.trim().length >= 16 &&
        binanceConfig.api_secret.trim().length >= 16) ||
        // Keys saved to this trader's private vault count even though the browser
        // never receives the secret back.
        apiKeyStatus.linked)
  );

  const hasTelegramKeys = Boolean(
    telegramConfig.bot_token.trim().length >= 10 && telegramConfig.chat_id.trim().length > 0
  );

  return {
    isSupabaseConfigured,
    isDemoMode,
    isAuthenticated,
    isGuest,
    enterGuestMode,
    exitGuestMode,
    userEmail,
    authLoading,
    dataLoading,
    errorMsg,
    activeWorkspace,
    switchWorkspace,
    settings,
    effectiveTheme,
    botStatus,
    trades,
    logs,
    marketPairs,
    smartAlerts,
    binanceFeedLive,
    stats,
    savingSettings,
    telegramConfig,
    setTelegramConfig,
    hasTelegramKeys,
    binanceConfig,
    setBinanceConfig,
    binanceAccount,
    syncingBalance,
    hasBinanceKeys,
    alertEnabledPairs,
    togglePairAlert,
    refreshBinanceBalance,
    getEquitySeries,
    toggleBot,
    updateSettings,
    togglePair,
    closeTrade,
    placeQuickTrade,
    closeAllPositions,
    resetVirtualBalance,
    voiceEnabled,
    audioReady,
    crashGuards,
    account,
    accountApproved,
    isAdmin,
    refreshAccount,
    updateUserProfile,
    adminUsers,
    adminTotals,
    adminLoading,
    adminError,
    refreshAdminUsers,
    reviewUser,
    workspaceUser,
    apiKeyStatus,
    saveUserBinanceKeys,
    saveAndVerifyUserBinanceKeys,
    testUserBinanceConnection,
    changePassword,
    requestPasswordResetCode,
    confirmPasswordResetCode,
    leaderboard,
    leaderboardLoading,
    refreshLeaderboard,
    toggleVoice,
    testVoice,
    speakBalance,
    testTelegramConnection,
    sendTelegramBalanceSnapshot,
    sendSignalToTelegram,
    verifyBinanceCredentials,
    signIn,
    signUp,
    resetPassword,
    signOut,
    enterDemoMode,
    refreshData: fetchSupabaseData,
  };
}
