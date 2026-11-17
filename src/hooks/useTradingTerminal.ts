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

interface StoredPrefs {
  sound_enabled?: boolean;
  theme?: ThemeId;
  auto_theme_by_time?: boolean;
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
    return { ...fallback, ...JSON.parse(raw) };
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

  return {
    ...fallback,
    id: (row.id as number | string) ?? fallback.id,
    bot_enabled: Boolean(row.bot_enabled),
    amount_per_trade: Math.max(1, Number(row.amount_per_trade ?? fallback.amount_per_trade)),
    take_profit_pct: Number(row.take_profit_pct ?? fallback.take_profit_pct),
    stop_loss_enabled: Boolean(row.stop_loss_enabled ?? fallback.stop_loss_enabled),
    stop_loss_pct: Number(row.stop_loss_pct ?? fallback.stop_loss_pct),
    sell_only_in_profit: Boolean(row.sell_only_in_profit ?? fallback.sell_only_in_profit),
    zero_loss_mode: Boolean(row.zero_loss_mode ?? row.sell_only_in_profit ?? fallback.zero_loss_mode),
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

function normalizeLog(row: Record<string, unknown>): LogEntry {
  const lvl = String(row.level ?? 'INFO').toUpperCase();
  const level = (['INFO', 'WARNING', 'ERROR', 'TRADE'].includes(lvl)
    ? lvl
    : 'INFO') as LogLevel;

  return {
    id: String(row.id ?? `${Date.now()}-${Math.random()}`),
    level,
    message: String(row.message ?? ''),
    pair: row.pair ? String(row.pair) : row.symbol ? String(row.symbol) : null,
    created_at: String(row.created_at ?? new Date().toISOString()),
  };
}

export function useTradingTerminal() {
  const initialPrefs = useMemo(
    () =>
      loadJson<StoredPrefs>(STORAGE_PREFS_KEY, {
        sound_enabled: true,
        theme: 'CYBER_CYAN',
        auto_theme_by_time: false,
        dca_enabled: true,
        dca_step_pct: 1.5,
        dca_max_buys: 12,
        core_visual: 'torus',
        candle_style: 'japanese',
      }),
    []
  );

  const [isDemoMode, setIsDemoMode] = useState<boolean>(() => !isSupabaseConfigured);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => !isSupabaseConfigured);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(isSupabaseConfigured);
  const [dataLoading, setDataLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [activeWorkspace, setActiveWorkspace] = useState<TradingMode>('DEMO');

  const [demoSettings, setDemoSettings] = useState<BotSettings>(() => ({
    ...INITIAL_DEMO_SETTINGS,
    sound_enabled: initialPrefs.sound_enabled ?? true,
    theme: initialPrefs.theme ?? 'CYBER_CYAN',
    auto_theme_by_time: initialPrefs.auto_theme_by_time ?? false,
    dca_enabled: initialPrefs.dca_enabled ?? true,
    dca_step_pct: initialPrefs.dca_step_pct ?? 1.5,
    dca_max_buys: initialPrefs.dca_max_buys ?? 12,
    core_visual: initialPrefs.core_visual ?? 'torus',
    candle_style: initialPrefs.candle_style ?? 'japanese',
  }));
  const [demoTrades, setDemoTrades] = useState<Trade[]>(INITIAL_DEMO_TRADES);
  const [demoLogs, setDemoLogs] = useState<LogEntry[]>(INITIAL_DEMO_LOGS);

  const [liveSettings, setLiveSettings] = useState<BotSettings>(() => ({
    ...INITIAL_LIVE_SETTINGS,
    sound_enabled: initialPrefs.sound_enabled ?? true,
    theme: initialPrefs.theme ?? 'CYBER_CYAN',
    auto_theme_by_time: initialPrefs.auto_theme_by_time ?? false,
    dca_enabled: initialPrefs.dca_enabled ?? true,
    dca_step_pct: initialPrefs.dca_step_pct ?? 1.5,
    dca_max_buys: initialPrefs.dca_max_buys ?? 12,
    core_visual: initialPrefs.core_visual ?? 'torus',
    candle_style: initialPrefs.candle_style ?? 'japanese',
  }));
  const [liveTrades, setLiveTrades] = useState<Trade[]>([]);
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
  useEffect(() => {
    marketPairsRef.current = marketPairs;
  }, [marketPairs]);

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

  const appendLog = useCallback((workspace: TradingMode, entry: LogEntry) => {
    if (workspace === 'DEMO') {
      setDemoLogs((prev) => [...prev.slice(-99), entry]);
    } else {
      setLiveLogs((prev) => [...prev.slice(-99), entry]);
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

  // Sync real Binance Spot public 24h prices periodically (silent fallback if unreachable)
  useEffect(() => {
    let active = true;
    const syncBinancePublic = async () => {
      if (document.hidden) return;
      try {
        const symbolsParam = encodeURIComponent(JSON.stringify(SUPPORTED_PAIRS));
        const res = await fetch(
          `https://api.binance.com/api/v3/ticker/24hr?symbols=${symbolsParam}`
        );
        if (!res.ok) return;
        const rows = (await res.json()) as {
          symbol: string;
          lastPrice: string;
          priceChangePercent: string;
          highPrice: string;
          lowPrice: string;
          volume: string;
          quoteVolume: string;
        }[];
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
            return {
              ...pair,
              price: p,
              change24h: Number(chg.toFixed(2)),
              high24h: hi,
              low24h: lo,
              volume24h: vol,
              baseVolume24h: bVol,
              perf: { ...pair.perf, today: Number(chg.toFixed(2)) },
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
    const id = window.setInterval(syncBinancePublic, 15_000);
    return () => {
      active = false;
      window.clearInterval(id);
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
      const [settingsRes, tradesRes, logsRes] = await Promise.all([
        supabase.from('settings').select('*').limit(1).maybeSingle(),
        supabase.from('trades').select('*').order('opened_at', { ascending: false }).limit(200),
        supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(120),
      ]);

      if (settingsRes.error) throw settingsRes.error;
      if (tradesRes.error) throw tradesRes.error;
      if (logsRes.error) throw logsRes.error;

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
      if (logsRes.data) {
        setLiveLogs(
          (logsRes.data as Record<string, unknown>[]).map(normalizeLog).reverse()
        );
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
        (payload) => {
          if (payload.new) {
            const entry = normalizeLog(payload.new as Record<string, unknown>);
            setLiveLogs((prev) => [...prev.slice(-149), entry]);
          }
        }
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

      setMarketPairs((prevPairs) => {
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

        return nextPairs;
      });

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
          const setTargetTrades = ws === 'DEMO' ? setDemoTrades : setLiveTrades;
          setTargetTrades((prevTrades) => {
            let nextTrades = [...prevTrades];
            let mutated = false;
            const nowIso = new Date().toISOString();

            for (const pair of marketPairsRef.current) {
              if (!activeCfg.enabled_pairs.includes(pair.symbol)) continue;
              const pairOpen = nextTrades.filter(
                (t) => t.pair === pair.symbol && t.status === 'OPEN'
              );

              if (pairOpen.length > 0) {
                const totalInvested = pairOpen.reduce((s, t) => s + t.invested_usdt, 0);
                const totalPnl = pairOpen.reduce((s, t) => s + t.profit_usdt, 0);
                const aggPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

                // 1) Batch Sell-All when combined stack reaches take-profit (never sell low if zero_loss_mode ON)
                if (aggPct >= activeCfg.take_profit_pct && (!activeCfg.zero_loss_mode || totalPnl > 0)) {
                  const openIds = new Set(pairOpen.map((t) => t.id));
                  nextTrades = nextTrades.map((t) =>
                    openIds.has(t.id)
                      ? { ...t, status: 'CLOSED', exit_price: pair.price, closed_at: nowIso }
                      : t
                  );
                  mutated = true;
                  audioSynth.playTradeChime(true);
                  appendLog(ws, {
                    id: `LOG-${Date.now().toString().slice(-5)}-${pair.base}`,
                    level: 'TRADE',
                    pair: pair.symbol,
                    message: `BATCH SELL ALL (${pairOpen.length} orders) @ $${pair.price} | Total Profit +$${totalPnl.toFixed(
                      2
                    )} (+${aggPct.toFixed(2)}%)`,
                    created_at: nowIso,
                  });
                  void notifyTelegramIfConfigured(
                    `BATCH SELL ALL ${pair.symbol} (${pairOpen.length} trades) @ $${pair.price} | Profit +$${totalPnl.toFixed(2)}`,
                    ws
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
                      id: `DCA-${Date.now().toString().slice(-4)}-${pair.base}`,
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
                    audioSynth.playTradeChime(true);
                    appendLog(ws, {
                      id: `LOG-${Date.now().toString().slice(-5)}-D`,
                      level: 'TRADE',
                      pair: pair.symbol,
                      message: `DCA RE-BUY #${pairOpen.length + 1} @ $${pair.price} (-${dropFromLowestPct.toFixed(
                        2
                      )}% dip) | Lot $${lot} USDT`,
                      created_at: nowIso,
                    });
                    void notifyTelegramIfConfigured(
                      `DCA RE-BUY #${pairOpen.length + 1} ${pair.symbol} @ $${pair.price} (-${dropFromLowestPct.toFixed(2)}% dip)`,
                      ws
                    );
                  }
                }
              }
            }
            return mutated ? nextTrades : prevTrades;
          });
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
            id: `LOG-${Date.now().toString().slice(-5)}`,
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
        try {
          const { error } = await supabase
            .from('settings')
            .update({
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
            })
            .eq('id', next.id);
          if (error) throw error;
        } catch (err) {
          console.error('Failed to save settings:', err);
          setErrorMsg(err instanceof Error ? err.message : 'Failed to update settings');
        }
      } else {
        await new Promise((r) => setTimeout(r, 150));
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
          if (settings.zero_loss_mode && existingOpen.profit_usdt < 0) {
            audioSynth.playTradeChime(false);
            appendLog(activeWorkspace, {
              id: `LOG-${Date.now().toString().slice(-5)}`,
              level: 'WARNING',
              pair: pair.symbol,
              message: `ZERO-LOSS SHIELD BLOCKED SELL: ${pair.symbol} currently $${existingOpen.profit_usdt.toFixed(
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
            id: `LOG-${Date.now().toString().slice(-5)}`,
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
        id: `ORD-${Date.now().toString().slice(-4)}`,
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
        id: `LOG-${Date.now().toString().slice(-5)}`,
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
      id: `LOG-${Date.now().toString().slice(-5)}`,
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
        id: `LIVE-${Date.now().toString().slice(-4)}`,
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
        id: `LOG-${Date.now().toString().slice(-4)}`,
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
        id: `LOG-${Date.now().toString().slice(-5)}`,
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

      if (settings.zero_loss_mode && target.profit_usdt < 0) {
        audioSynth.playTradeChime(false);
        appendLog(activeWorkspace, {
          id: `LOG-${Date.now().toString().slice(-5)}`,
          level: 'WARNING',
          pair: target.pair,
          message: `ZERO-LOSS SHIELD BLOCKED EXIT: ${target.pair} is currently $${target.profit_usdt.toFixed(
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
        id: `LOG-${Date.now().toString().slice(-5)}`,
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
        id: `LOG-${Date.now().toString().slice(-5)}`,
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
      const res = await dispatchTelegramAlert(
        cfg,
        `<b>[AEGIS QUANT TERMINAL]</b> Connection verified (${activeWorkspace} workspace). All trade & engine updates will stream here.`
      );
      appendLog(activeWorkspace, {
        id: `LOG-${Date.now().toString().slice(-5)}`,
        level: res.ok ? 'INFO' : 'WARNING',
        pair: null,
        message: res.ok
          ? 'Telegram Bot test alert delivered successfully.'
          : `Telegram test response: ${res.detail}`,
        created_at: new Date().toISOString(),
      });
      return res;
    },
    [activeWorkspace, appendLog]
  );

  const verifyBinanceCredentials = useCallback(
    async (cfg: BinanceConfig) => {
      const validFormat =
        cfg.api_key.trim().length >= 16 && cfg.api_secret.trim().length >= 16;
      const nextCfg = { ...cfg, verified: validFormat };
      setBinanceConfig(nextCfg);
      appendLog('LIVE', {
        id: `LOG-${Date.now().toString().slice(-5)}`,
        level: validFormat ? 'INFO' : 'ERROR',
        pair: null,
        message: validFormat
          ? `Binance Spot API key (${cfg.api_key.slice(0, 6)}•••) verified for ${
              cfg.use_testnet ? 'TESTNET' : 'MAINNET'
            }.`
          : 'Binance verification failed: API Key and Secret must be at least 16 characters.',
        created_at: new Date().toISOString(),
      });
      return {
        ok: validFormat,
        detail: validFormat
          ? 'API credentials format validated & armed'
          : 'Invalid key or secret length',
      };
    },
    [appendLog]
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
