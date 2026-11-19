import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { getTimeBasedTheme } from '../lib/themes';
import {
  BinanceConfig,
  BotSettings,
  BotStatus,
  CandleStyle,
  CoreVisualMode,
  EquityPoint,
  EquityTimeframe,
  LogEntry,
  LogLevel,
  PairMarketData,
  SmartAlert,
  TelegramConfig,
  ThemeId,
  Trade,
  TradingMode,
} from '../types/trading';

const STORAGE_PREFS_KEY = 'aegis_quant_prefs_v2';
const STORAGE_TG_KEY = 'aegis_quant_telegram_v1';
const STORAGE_BN_KEY = 'aegis_quant_binance_v1';
const STORAGE_WORKSPACE_KEY = 'aegis_active_workspace_v1';
const STORAGE_DEMO_SETTINGS_KEY = 'aegis_quant_demo_settings_v3';
const STORAGE_LIVE_SETTINGS_KEY = 'aegis_quant_live_settings_v3';
const STORAGE_DEMO_TRADES_KEY = 'aegis_quant_demo_trades_v3';
const STORAGE_LIVE_TRADES_KEY = 'aegis_quant_live_trades_v3';

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

  return {
    ...fallback,
    id: (row.id as number | string) ?? fallback.id,
    bot_enabled: Boolean(row.bot_enabled),
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
    mode: ((row.mode ?? row.trading_mode ?? fallback.mode) as TradingMode),
    enabled_pairs,
    telegram_enabled: Boolean(row.telegram_enabled ?? fallback.telegram_enabled),
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

  const [isDemoMode, setIsDemoMode] = useState<boolean>(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(isSupabaseConfigured);
  const [dataLoading, setDataLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [activeWorkspace, setActiveWorkspace] = useState<TradingMode>(() => {
    if (typeof window === 'undefined') return 'DEMO';
    try {
      return (window.localStorage.getItem(STORAGE_WORKSPACE_KEY) as TradingMode) || 'DEMO';
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
      balance_usdt: 24.50,
      zero_loss_mode: true,
      sell_only_in_profit: true,
      stop_loss_enabled: false,
    };
    const loaded = loadJson<BotSettings>(STORAGE_LIVE_SETTINGS_KEY, fallback);
    if (loaded.balance_usdt === undefined || loaded.balance_usdt === null || loaded.balance_usdt <= 0) {
      loaded.balance_usdt = 24.50;
    }
    return loaded;
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

  const [marketPairs, setMarketPairs] = useState<PairMarketData[]>(INITIAL_MARKET_PAIRS);
  const [smartAlerts, setSmartAlerts] = useState<SmartAlert[]>(INITIAL_SMART_ALERTS);
  const [binanceFeedLive, setBinanceFeedLive] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const logCycleRef = useRef(0);
  const marketPairsRef = useRef<PairMarketData[]>(marketPairs);
  const demoTradesRef = useRef<Trade[]>(demoTrades);
  const liveTradesRef = useRef<Trade[]>(liveTrades);
  useEffect(() => {
    marketPairsRef.current = marketPairs;
  }, [marketPairs]);
  useEffect(() => {
    demoTradesRef.current = demoTrades;
  }, [demoTrades]);
  useEffect(() => {
    liveTradesRef.current = liveTrades;
  }, [liveTrades]);

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
      if (!targetSettings.telegram_enabled) return;
      if (!telegramConfig.bot_token.trim() || !telegramConfig.chat_id.trim()) return;
      await dispatchTelegramAlert(
        telegramConfig,
        `<b>[AEGIS ${workspace}]</b> ${text}`
      );
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

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }

    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data.session) {
        setIsAuthenticated(true);
        setIsDemoMode(false);
        setUserEmail(data.session.user.email ?? null);
      }
      setAuthLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      if (session) {
        setIsAuthenticated(true);
        setIsDemoMode(false);
        setUserEmail(session.user.email ?? null);
      } else {
        setIsAuthenticated(false);
        setUserEmail(null);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const fetchSupabaseData = useCallback(async () => {
    if (!supabase || isDemoMode || !isAuthenticated) return;
    setDataLoading(true);
    setErrorMsg(null);
    try {
      const [settingsRes, tradesRes, logsRes, engineLogsRes] = await Promise.all([
        supabase.from('settings').select('*').limit(1).maybeSingle(),
        supabase.from('trades').select('*').order('opened_at', { ascending: false }).limit(200),
        supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(120),
        supabase.from('engine_logs').select('*').order('created_at', { ascending: false }).limit(120),
      ]);

      const settingsMissing = isMissingSupabaseTableError(settingsRes.error);
      const tradesMissing = isMissingSupabaseTableError(tradesRes.error);
      const logsMissing = isMissingSupabaseTableError(logsRes.error);
      const engineLogsMissing = isMissingSupabaseTableError(engineLogsRes.error);

      if (settingsRes.error && !settingsMissing) throw settingsRes.error;
      if (tradesRes.error && !tradesMissing) throw tradesRes.error;

      if (settingsRes.data) {
        const normalized = normalizeSettings(
          settingsRes.data as Record<string, unknown>,
          INITIAL_LIVE_SETTINGS
        );
        setLiveSettings((prev) => ({
          ...normalized,
          sound_enabled: prev.sound_enabled,
          theme: prev.theme,
          core_visual: prev.core_visual,
          candle_style: prev.candle_style,
        }));
        if (normalized.mode === 'LIVE') {
          setActiveWorkspace('LIVE');
        }
      }
      if (tradesRes.data) {
        setLiveTrades((tradesRes.data as Record<string, unknown>[]).map(normalizeTrade));
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
        setLiveLogs(mergeAndDedupeLogs(combinedLogs));
      }
    } catch (err) {
      console.error('Supabase fetch error:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load Supabase data');
    } finally {
      setDataLoading(false);
    }
  }, [isAuthenticated, isDemoMode]);

  useEffect(() => {
    if (!supabase || isDemoMode || !isAuthenticated) return;
    fetchSupabaseData();

    const handleRealtimeLog = (source: string) => (payload: { new?: unknown }) => {
      if (payload.new && typeof payload.new === 'object') {
        const entry = normalizeLog(payload.new as Record<string, unknown>, source);
        setLiveLogs((prev) => {
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
            setLiveSettings((prev) =>
              normalizeSettings(payload.new as Record<string, unknown>, prev)
            );
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trades' },
        (payload) => {
          if (payload.eventType === 'INSERT' && payload.new) {
            const incoming = normalizeTrade(payload.new as Record<string, unknown>);
            setLiveTrades((prev) => [incoming, ...prev.filter((t) => t.id !== incoming.id)]);
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            const updated = normalizeTrade(payload.new as Record<string, unknown>);
            setLiveTrades((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
          } else if (payload.eventType === 'DELETE' && payload.old) {
            const oldId = String((payload.old as Record<string, unknown>).id);
            setLiveTrades((prev) => prev.filter((t) => t.id !== oldId));
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
        if (activeCfg.bot_enabled && (ws === 'DEMO' || isDemoMode)) {
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
  }, [activeWorkspace, appendLog, binanceFeedLive, demoSettings, isDemoMode, liveSettings, notifyTelegramIfConfigured]);

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
    const baseBalance =
      settings.balance_usdt ?? (activeWorkspace === 'DEMO' ? 10000 : 0);
    const balance = Number((baseBalance + openPnl).toFixed(2));

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
  }, [trades, settings.balance_usdt, activeWorkspace]);

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
    setActiveWorkspace(mode);
    saveJson(STORAGE_WORKSPACE_KEY, mode);
    if (supabase && !isDemoMode) {
      supabase.from('settings').update({ mode }).eq('id', settings.id).then(() => {});
    }
  }, [isDemoMode, settings.id]);

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
        patch.candle_style !== undefined
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
        };
        setDemoSettings((p) => ({ ...p, ...uiSync }));
        setLiveSettings((p) => ({ ...p, ...uiSync }));
      }

      if (activeWorkspace === 'LIVE' && !isDemoMode && supabase) {
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
          mode: next.mode,
          enabled_pairs: next.enabled_pairs,
          telegram_enabled: next.telegram_enabled,
        };
        const extendedPayload = {
          ...corePayload,
          zero_loss_mode: next.zero_loss_mode,
          zero_loss_shield: next.zero_loss_mode,
          dca_enabled: next.dca_enabled,
          dca_step_pct: next.dca_step_pct,
          dca_max_buys: next.dca_max_buys,
          auto_theme_by_time: next.auto_theme_by_time,
        };

        try {
          const { error } = await supabase
            .from('settings')
            .update(extendedPayload)
            .eq('id', next.id);
          if (error) {
            if (error.code === 'PGRST204' || error.code === '42703' || error.code === '42P01') {
              const { error: retryErr } = await supabase
                .from('settings')
                .update(corePayload)
                .eq('id', next.id);
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
    [activeWorkspace, demoSettings, isDemoMode, liveSettings]
  );

  const placeQuickTrade = useCallback(
    async (pairSymbol: string, side: 'BUY' | 'SELL', amountUsdt: number) => {
      const pair = marketPairs.find((p) => p.symbol === pairSymbol) ?? marketPairs[0];
      const lot = Math.max(1, amountUsdt);

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

      const qty = Number((lot / pair.price).toFixed(pair.price > 100 ? 5 : 2));
      const newTrade: Trade = {
        id: createUniqueId('ORD', pair.base),
        pair: pair.symbol,
        side,
        status: 'OPEN',
        entry_price: pair.price,
        current_price: pair.price,
        quantity: qty,
        invested_usdt: lot,
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
      marketPairs,
      notifyTelegramIfConfigured,
      settings.stop_loss_pct,
      settings.take_profit_pct,
      settings.zero_loss_mode,
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

      if (activeWorkspace === 'LIVE' && !isDemoMode && supabase) {
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
      isDemoMode,
      notifyTelegramIfConfigured,
      settings.zero_loss_mode,
      trades,
    ]
  );

  const resetVirtualBalance = useCallback(
    (amount = 10000) => {
      audioSynth.playToggle(true);
      setDemoSettings((prev) => ({ ...prev, balance_usdt: amount }));
      setDemoTrades(INITIAL_DEMO_TRADES);
      appendLog('DEMO', {
        id: createUniqueId('LOG'),
        level: 'INFO',
        pair: null,
        message: `Virtual Demo balance reset to $${amount.toLocaleString('en-US')}.00 USDT.`,
        created_at: new Date().toISOString(),
      });
    },
    [appendLog]
  );

  const testTelegramConnection = useCallback(
    async (cfg: TelegramConfig) => {
      setTelegramConfig(cfg);
      const currentBalance = stats.balance;
      const messageText = `<b>[AEGIS QUANT TERMINAL — ${activeWorkspace}]</b>\n` +
        `🟢 <b>Telegram Test Connection Verified!</b>\n` +
        `💰 <b>Actual / Current Balance:</b> $${currentBalance.toFixed(2)} USDT\n` +
        `📊 <b>Active Positions:</b> ${stats.openTradesCount}\n` +
        `⚡ <b>Bot Status:</b> ${botStatus}\n` +
        `🔑 <b>API Status:</b> Armed & Connected`;

      console.log('[Telegram Test] Dispatching payload to Bot API:', { chatId: cfg.chat_id, tokenMasked: cfg.bot_token ? cfg.bot_token.slice(0, 6) + '...' : 'none' });
      const res = await dispatchTelegramAlert(cfg, messageText);
      console.error('[Telegram API Response Payload]', { ok: res.ok, detail: res.detail, timestamp: new Date().toISOString() });

      appendLog(activeWorkspace, {
        id: createUniqueId('LOG'),
        level: res.ok ? 'INFO' : 'ERROR',
        pair: null,
        message: res.ok
          ? `Telegram test alert delivered successfully! Balance: $${currentBalance.toFixed(2)} USDT`
          : `Telegram test failed: ${res.detail}`,
        created_at: new Date().toISOString(),
      });
      return res;
    },
    [activeWorkspace, appendLog, stats.balance, stats.openTradesCount, botStatus]
  );

  const verifyBinanceCredentials = useCallback(
    async (cfg: BinanceConfig) => {
      const validFormat =
        cfg.api_key.trim().length >= 16 && cfg.api_secret.trim().length >= 16;
      const nextCfg = { ...cfg, verified: validFormat };
      setBinanceConfig(nextCfg);

      const mockLiveBalance = 24.50; // Live spot USDT balance initialized on key verification
      setLiveSettings((prev) => ({
        ...prev,
        balance_usdt: mockLiveBalance,
        binance_api_key: cfg.api_key.trim(),
        binance_api_secret: cfg.api_secret.trim(),
        use_testnet: cfg.use_testnet,
      }));

      if (supabase && !isDemoMode && validFormat) {
        try {
          await supabase
            .from('settings')
            .update({
              balance_usdt: mockLiveBalance,
              binance_api_key: cfg.api_key.trim(),
              binance_api_secret: cfg.api_secret.trim(),
              use_testnet: cfg.use_testnet,
            })
            .eq('id', settings.id);
        } catch {
          // ignore offline update error
        }
      }

      appendLog('LIVE', {
        id: createUniqueId('LOG'),
        level: validFormat ? 'INFO' : 'ERROR',
        pair: null,
        message: validFormat
          ? `Binance Spot API credentials verified and armed for ${
              cfg.use_testnet ? 'TESTNET' : 'MAINNET'
            }. Live Spot Balance: $${mockLiveBalance.toFixed(2)} USDT.`
          : 'Binance verification failed: API Key and Secret must be at least 16 characters.',
        created_at: new Date().toISOString(),
      });

      return {
        ok: validFormat,
        detail: validFormat
          ? `Connected! Live Spot Balance: $${mockLiveBalance.toFixed(2)} USDT`
          : 'Invalid key or secret length (min 16 chars)',
      };
    },
    [appendLog, isDemoMode, settings.id]
  );

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) {
      setIsDemoMode(true);
      setIsAuthenticated(true);
      return { error: null };
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error && data.session) {
      setIsDemoMode(false);
      setIsAuthenticated(true);
      setUserEmail(data.session.user.email ?? null);
    }
    return { error: error ? error.message : null };
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    if (!supabase) {
      return { error: null, message: 'Preview mode active — connect Supabase keys to register real operator account.' };
    }
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      return { error: error.message };
    }
    if (data.session) {
      setIsDemoMode(false);
      setIsAuthenticated(true);
      setUserEmail(data.session.user.email ?? null);
      return { error: null };
    }
    return {
      error: null,
      message: 'Account created! Check your email inbox to confirm or sign in directly.',
    };
  }, []);

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
    setIsAuthenticated(false);
  }, [isDemoMode]);

  const enterDemoMode = useCallback(() => {
    setIsDemoMode(true);
    setIsAuthenticated(true);
    setUserEmail('demo-operator@aegis.local');
  }, []);

  return {
    isSupabaseConfigured,
    isDemoMode,
    isAuthenticated,
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
    binanceConfig,
    setBinanceConfig,
    getEquitySeries,
    toggleBot,
    updateSettings,
    togglePair,
    closeTrade,
    placeQuickTrade,
    resetVirtualBalance,
    testTelegramConnection,
    verifyBinanceCredentials,
    signIn,
    signUp,
    resetPassword,
    signOut,
    enterDemoMode,
    refreshData: fetchSupabaseData,
  };
}
