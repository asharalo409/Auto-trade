import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  Bell,
  BellOff,
  BellRing,
  Power,
  Radio,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SUPPORTED_PAIRS } from '../../data/demoData';
import { audioSynth } from '../../lib/audioSynth';
import {
  DesktopNotificationPermission,
  getDesktopNotificationPermission,
  requestDesktopNotificationPermission,
  sendDesktopNotification,
} from '../../lib/desktopNotifications';
import { TERMINAL_THEMES } from '../../lib/themes';
import {
  BotSettings,
  BotStatus,
  CandleStyle,
  CoreVisualMode,
  EquityPoint,
  EquityTimeframe,
  LogEntry,
  PairMarketData,
  SmartAlert,
  ThemeId,
  Trade,
  TradingMode,
} from '../../types/trading';
import { CandlestickChart } from '../charts/CandlestickChart';
import { QuantumCore3D } from '../three/QuantumCore3D';
import { AnimatedNumber } from '../ui/AnimatedNumber';
import { InfoTip } from '../ui/InfoTip';
import { NeonButton, SkeletonBlock } from '../ui/MotionPrimitives';
import { TerminalPanel } from '../ui/TerminalPanel';
import { BinanceOrderBook } from '../widgets/BinanceOrderBook';
import { MarketSentimentWidget } from '../widgets/MarketSentimentWidget';
import { SmartTrackerWidget } from '../widgets/SmartTrackerWidget';

interface CommandCenterProps {
  t: Record<string, string>;
  workspace: TradingMode;
  settings: BotSettings;
  effectiveTheme: ThemeId;
  botStatus: BotStatus;
  loading: boolean;
  stats: {
    balance: number;
    todayProfit: number;
    totalProfit: number;
    winRate: number;
    openTradesCount: number;
    totalTradesCount: number;
    lockedCapital: number;
    availableBalance: number;
  };
  trades: Trade[];
  logs: LogEntry[];
  marketPairs: PairMarketData[];
  smartAlerts: SmartAlert[];
  binanceFeedLive: boolean;
  getEquitySeries: (tf: EquityTimeframe) => EquityPoint[];
  onToggleBot: () => Promise<void>;
  onChangeCoreVisual: (mode: CoreVisualMode) => Promise<void>;
  onChangeCandleStyle: (style: CandleStyle) => Promise<void>;
  onQuickTrade: (pairSymbol: string, side: 'BUY' | 'SELL', amountUsdt: number) => Promise<void>;
  onResetVirtual: () => void;
  onNavigateTab: (tab: 'trades' | 'feed' | 'market' | 'settings') => void;
}

const TIMEFRAMES: EquityTimeframe[] = ['1D', '1W', '1M', 'ALL'];
const DESKTOP_ALERTS_STORAGE_KEY = 'aegis_desktop_alerts_enabled_v1';

interface LiveSignalNotice {
  id: string;
  pair: string;
  signal: 'BUY' | 'SELL';
  price: number;
  title: string;
  detail: string;
  time: string;
  desktopDelivered: boolean;
}

export const CommandCenter: React.FC<CommandCenterProps> = ({
  t,
  workspace,
  settings,
  effectiveTheme,
  botStatus,
  loading,
  stats,
  trades,
  logs,
  marketPairs,
  smartAlerts,
  binanceFeedLive,
  getEquitySeries,
  onToggleBot,
  onChangeCoreVisual,
  onChangeCandleStyle,
  onQuickTrade,
  onResetVirtual,
  onNavigateTab,
}) => {
  const reducedMotion = useReducedMotion();
  const [timeframe, setTimeframe] = useState<EquityTimeframe>('1D');
  const [chartPair, setChartPair] = useState<string>('BTCUSDT');
  const [toggling, setToggling] = useState(false);

  const [desktopAlertsEnabled, setDesktopAlertsEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const saved = window.localStorage.getItem(DESKTOP_ALERTS_STORAGE_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [notifPermission, setNotifPermission] = useState<DesktopNotificationPermission>(() =>
    getDesktopNotificationPermission()
  );
  const [activeSignalNotice, setActiveSignalNotice] = useState<LiveSignalNotice | null>(null);

  const [customAlerts, setCustomAlerts] = useState<{
    id: string;
    pair: string;
    condition: 'ABOVE' | 'BELOW';
    targetPrice: number;
    active: boolean;
    createdAt: string;
  }[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const saved = window.localStorage.getItem('aegis_custom_price_alerts_v1');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [
      { id: 'al-1', pair: 'BTCUSDT', condition: 'ABOVE', targetPrice: 98000, active: true, createdAt: new Date().toISOString() },
      { id: 'al-2', pair: 'ETHUSDT', condition: 'BELOW', targetPrice: 2800, active: true, createdAt: new Date().toISOString() },
    ];
  });
  const [alertPairInput, setAlertPairInput] = useState('BTCUSDT');
  const [alertCondInput, setAlertCondInput] = useState<'ABOVE' | 'BELOW'>('ABOVE');
  const [alertPriceInput, setAlertPriceInput] = useState('');

  const handleAddPriceAlert = (e: React.FormEvent) => {
    e.preventDefault();
    const priceNum = parseFloat(alertPriceInput);
    if (!Number.isFinite(priceNum) || priceNum <= 0) return;
    audioSynth.playClick();
    const newAlert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      pair: alertPairInput,
      condition: alertCondInput,
      targetPrice: priceNum,
      active: true,
      createdAt: new Date().toISOString(),
    };
    const next = [newAlert, ...customAlerts];
    setCustomAlerts(next);
    setAlertPriceInput('');
    try {
      window.localStorage.setItem('aegis_custom_price_alerts_v1', JSON.stringify(next));
    } catch {}
  };

  const handleRemoveAlert = (id: string) => {
    audioSynth.playClick();
    const next = customAlerts.filter((a) => a.id !== id);
    setCustomAlerts(next);
    try {
      window.localStorage.setItem('aegis_custom_price_alerts_v1', JSON.stringify(next));
    } catch {}
  };

  const prevSignalsRef = useRef<Map<string, PairMarketData['signal']> | null>(null);
  const seenAlertIdsRef = useRef<Set<string> | null>(null);
  const seenTradeStatesRef = useRef<Map<string, Trade['status']> | null>(null);
  const pairCooldownRef = useRef<Map<string, number>>(new Map());

  const equityData = getEquitySeries(timeframe);
  const isRunning = botStatus === 'RUNNING';
  const isOffline = botStatus === 'OFFLINE';
  const theme = TERMINAL_THEMES[effectiveTheme];

  const dispatchTradeSignalNotification = useCallback(
    (payload: {
      pair: string;
      signal: 'BUY' | 'SELL';
      price: number;
      title: string;
      detail: string;
      bypassCooldown?: boolean;
    }) => {
      const nowMs = Date.now();
      const lastSent = pairCooldownRef.current.get(`${payload.pair}:${payload.signal}`) ?? 0;
      if (!payload.bypassCooldown && nowMs - lastSent < 25_000) {
        return;
      }
      pairCooldownRef.current.set(`${payload.pair}:${payload.signal}`, nowMs);

      const desktopDelivered = desktopAlertsEnabled
        ? sendDesktopNotification({
            title: payload.title,
            body: `${payload.detail} · Click to inspect ${payload.pair}`,
            tag: `aegis-signal-${payload.pair}`,
            onClick: () => setChartPair(payload.pair),
          })
        : false;

      if (desktopAlertsEnabled) {
        audioSynth.playTradeChime(payload.signal === 'BUY');
      }

      setActiveSignalNotice({
        id: `${payload.pair}-${nowMs}`,
        pair: payload.pair,
        signal: payload.signal,
        price: payload.price,
        title: payload.title,
        detail: payload.detail,
        time: new Date(nowMs).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        desktopDelivered,
      });
    },
    [desktopAlertsEnabled]
  );

  useEffect(() => {
    if (customAlerts.length === 0) return;
    let mutated = false;
    const nextAlerts = customAlerts.map((alert) => {
      if (!alert.active) return alert;
      const pairData = marketPairs.find((p) => p.symbol === alert.pair);
      if (!pairData) return alert;
      const crossed =
        alert.condition === 'ABOVE'
          ? pairData.price >= alert.targetPrice
          : pairData.price <= alert.targetPrice;
      if (crossed) {
        mutated = true;
        dispatchTradeSignalNotification({
          pair: alert.pair,
          signal: alert.condition === 'ABOVE' ? 'BUY' : 'SELL',
          price: pairData.price,
          title: `🎯 Price Alert Triggered: ${alert.pair}`,
          detail: `Price @ $${pairData.price.toLocaleString()} crossed ${alert.condition} $${alert.targetPrice.toLocaleString()}`,
          bypassCooldown: true,
        });
        return { ...alert, active: false };
      }
      return alert;
    });

    if (mutated) {
      setCustomAlerts(nextAlerts);
      try {
        window.localStorage.setItem('aegis_custom_price_alerts_v1', JSON.stringify(nextAlerts));
      } catch {}
    }
  }, [marketPairs, customAlerts, dispatchTradeSignalNotification]);

  // Auto-clear in-app signal toast banner after 12 seconds
  useEffect(() => {
    if (!activeSignalNotice) return;
    const timer = window.setTimeout(() => {
      setActiveSignalNotice((prev) => (prev?.id === activeSignalNotice.id ? null : prev));
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [activeSignalNotice]);

  // Watch real-time market pair signal transitions (HOLD/SELL -> BUY or HOLD/BUY -> SELL)
  useEffect(() => {
    if (!prevSignalsRef.current) {
      prevSignalsRef.current = new Map(marketPairs.map((p) => [p.symbol, p.signal]));
      return;
    }

    const prevMap = prevSignalsRef.current;
    for (const pair of marketPairs) {
      const prevSig = prevMap.get(pair.symbol);
      if (prevSig && prevSig !== pair.signal && (pair.signal === 'BUY' || pair.signal === 'SELL')) {
        if (desktopAlertsEnabled) {
          dispatchTradeSignalNotification({
            pair: pair.symbol,
            signal: pair.signal,
            price: pair.price,
            title: `${pair.signal === 'BUY' ? '▲ BUY' : '▼ SELL'} Trade Signal: ${pair.symbol}`,
            detail: `@ $${pair.price.toLocaleString('en-US', { maximumFractionDigits: 5 })} · RSI ${pair.rsi14.toFixed(1)} · 24h ${pair.change24h >= 0 ? '+' : ''}${pair.change24h.toFixed(2)}%`,
          });
        }
      }
      prevMap.set(pair.symbol, pair.signal);
    }
  }, [marketPairs, desktopAlertsEnabled, dispatchTradeSignalNotification]);

  // Watch real-time Smart Tracker signal alerts
  useEffect(() => {
    if (!seenAlertIdsRef.current) {
      seenAlertIdsRef.current = new Set(smartAlerts.map((a) => a.id));
      return;
    }
    const seen = seenAlertIdsRef.current;
    for (const alert of smartAlerts) {
      if (!seen.has(alert.id)) {
        seen.add(alert.id);
        if (desktopAlertsEnabled) {
          const matchedPair = marketPairs.find((p) => p.symbol === alert.pair);
          const sig: 'BUY' | 'SELL' =
            alert.title.toUpperCase().includes('SELL') || alert.deltaPct < 0 ? 'SELL' : 'BUY';
          dispatchTradeSignalNotification({
            pair: alert.pair,
            signal: sig,
            price: matchedPair?.price ?? 0,
            title: `${sig === 'BUY' ? '▲' : '▼'} ${alert.pair}: ${alert.title}`,
            detail: alert.desc,
          });
        }
      }
    }
  }, [smartAlerts, marketPairs, desktopAlertsEnabled, dispatchTradeSignalNotification]);

  // Watch new or closed bot trades in real time
  useEffect(() => {
    if (!seenTradeStatesRef.current) {
      seenTradeStatesRef.current = new Map(trades.map((tr) => [tr.id, tr.status]));
      return;
    }
    const seen = seenTradeStatesRef.current;
    for (const tr of trades) {
      const prevStatus = seen.get(tr.id);
      if (!prevStatus) {
        seen.set(tr.id, tr.status);
        if (desktopAlertsEnabled && tr.status === 'OPEN') {
          dispatchTradeSignalNotification({
            pair: tr.pair,
            signal: tr.side,
            price: tr.entry_price,
            title: `⚡ ${tr.side} Trigger Executed: ${tr.pair}`,
            detail: `Entry $${tr.entry_price} · Lot $${tr.invested_usdt} USDT (${workspace})`,
            bypassCooldown: true,
          });
        }
      } else if (prevStatus === 'OPEN' && tr.status === 'CLOSED') {
        seen.set(tr.id, tr.status);
        if (desktopAlertsEnabled) {
          dispatchTradeSignalNotification({
            pair: tr.pair,
            signal: 'SELL',
            price: tr.exit_price ?? tr.current_price,
            title: `✓ Trade Closed: ${tr.pair} (${tr.profit_usdt >= 0 ? '+' : ''}$${tr.profit_usdt.toFixed(2)})`,
            detail: `Exit @ $${tr.exit_price ?? tr.current_price} · Return ${tr.profit_pct >= 0 ? '+' : ''}${tr.profit_pct.toFixed(2)}%`,
            bypassCooldown: true,
          });
        }
      }
    }
  }, [trades, workspace, desktopAlertsEnabled, dispatchTradeSignalNotification]);

  const handleToggleDesktopAlerts = async () => {
    audioSynth.playClick();
    const currentPerm = getDesktopNotificationPermission();
    setNotifPermission(currentPerm);

    if (currentPerm === 'default') {
      const nextPerm = await requestDesktopNotificationPermission();
      setNotifPermission(nextPerm);
      if (nextPerm === 'granted') {
        setDesktopAlertsEnabled(true);
        sendDesktopNotification({
          title: 'Aegis Quant — Desktop Signal Alerts Active',
          body: 'You will now receive instant browser alerts when BUY/SELL trade signals fire.',
          tag: 'aegis-alerts-armed',
        });
      }
      return;
    }

    setDesktopAlertsEnabled((prev) => !prev);
  };

  const handleTestSignalAlert = async () => {
    audioSynth.playClick();
    let perm = getDesktopNotificationPermission();
    if (perm === 'default') {
      perm = await requestDesktopNotificationPermission();
    }
    setNotifPermission(perm);
    if (!desktopAlertsEnabled) {
      setDesktopAlertsEnabled(true);
    }

    const activePair = marketPairs.find((p) => p.symbol === chartPair) ?? marketPairs[0];
    const sig: 'BUY' | 'SELL' = activePair.signal === 'SELL' ? 'SELL' : 'BUY';

    const title = `${sig === 'BUY' ? '▲ BUY' : '▼ SELL'} Signal Alert: ${activePair.symbol}`;
    const detail = `@ $${activePair.price.toLocaleString('en-US', { maximumFractionDigits: 5 })} · RSI ${activePair.rsi14.toFixed(1)} · 24h ${activePair.change24h >= 0 ? '+' : ''}${activePair.change24h.toFixed(2)}%`;

    const desktopDelivered = sendDesktopNotification({
      title,
      body: `${detail} · Click to view chart`,
      tag: `aegis-test-${activePair.symbol}`,
      onClick: () => setChartPair(activePair.symbol),
    });

    audioSynth.playTradeChime(sig === 'BUY');
    setActiveSignalNotice({
      id: `test-${Date.now()}`,
      pair: activePair.symbol,
      signal: sig,
      price: activePair.price,
      title,
      detail,
      time: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      desktopDelivered,
    });
  };

  const handlePowerClick = async () => {
    setToggling(true);
    await onToggleBot();
    setToggling(false);
  };

  const statusLabel = isOffline
    ? t.statusOffline
    : isRunning
      ? t.statusRunning
      : t.statusStopped;

  const statusHint = isOffline
    ? t.botStatusHintOffline
    : isRunning
      ? t.botStatusHintRunning
      : t.botStatusHintStopped;

  const openTrades = trades.filter((tr) => tr.status === 'OPEN').slice(0, 3);
  const recentLogs = logs.slice(-4).reverse();

  const coreStyles: { id: CoreVisualMode; label: string }[] = [
    { id: 'torus', label: t.coreStyleTorus },
    { id: 'lorenz', label: t.coreStyleLorenz },
    { id: 'vortex', label: t.coreStyleVortex },
    { id: 'depth', label: t.coreStyleDepth },
  ];

  const kpis = [
    {
      label: t.balance,
      value: stats.balance,
      prefix: '$',
      decimals: 2,
      showSign: false,
      colorClass: 'text-cyan-300',
      accent: 'cyan' as const,
    },
    {
      label: t.todayProfit,
      value: stats.todayProfit,
      prefix: '$',
      decimals: 2,
      showSign: true,
      colorClass: stats.todayProfit >= 0 ? 'text-emerald-400' : 'text-rose-400',
      accent: (stats.todayProfit >= 0 ? 'emerald' : 'crimson') as 'emerald' | 'crimson',
    },
    {
      label: t.totalProfit,
      value: stats.totalProfit,
      prefix: '$',
      decimals: 2,
      showSign: true,
      colorClass: stats.totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400',
      accent: (stats.totalProfit >= 0 ? 'emerald' : 'crimson') as 'emerald' | 'crimson',
    },
    {
      label: t.winRate,
      value: stats.winRate,
      suffix: '%',
      decimals: 1,
      showSign: false,
      colorClass: 'text-amber-300',
      accent: 'amber' as const,
    },
    {
      label: t.openTrades,
      value: stats.openTradesCount,
      decimals: 0,
      showSign: false,
      colorClass: 'text-cyan-300',
      accent: 'cyan' as const,
    },
    {
      label: t.totalTrades,
      value: stats.totalTradesCount,
      decimals: 0,
      showSign: false,
      colorClass: 'text-slate-100',
      accent: 'neutral' as const,
    },
  ];

  const renderLatestDot = (props: { cx?: number; cy?: number; index?: number }) => {
    const { cx, cy, index } = props;
    if (cx == null || cy == null || index !== equityData.length - 1)
      return <g key={`dot-${index}`} />;
    return (
      <g key="latest-pulse-dot">
        {!reducedMotion && (
          <circle cx={cx} cy={cy} r={9} fill={theme.secondaryHex} opacity={0.28}>
            <animate
              attributeName="r"
              values="5;13;5"
              dur="2.2s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.45;0;0.45"
              dur="2.2s"
              repeatCount="indefinite"
            />
          </circle>
        )}
        <circle
          cx={cx}
          cy={cy}
          r={4.5}
          fill={theme.primaryHex}
          stroke="#05060a"
          strokeWidth={2}
        />
      </g>
    );
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <SkeletonBlock className="h-72 lg:col-span-5" />
          <SkeletonBlock className="h-72 lg:col-span-7" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Workspace Banner (Virtual vs Live Isolated Pages) */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-2.5 ${
          workspace === 'LIVE'
            ? 'border-rose-500/45 bg-rose-500/10'
            : 'border-cyan-500/30 bg-cyan-500/8'
        }`}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5 font-display text-sm font-bold tracking-wider uppercase">
            <span className={workspace === 'LIVE' ? 'text-rose-300' : 'text-cyan-300'}>
              {workspace === 'LIVE' ? t.liveBannerTitle : t.virtualBannerTitle}
            </span>
            {settings.zero_loss_mode && (
              <span className="inline-flex items-center gap-1 font-mono-tech text-[10px] font-semibold text-emerald-400">
                <ShieldCheck className="h-3.5 w-3.5" />
                {t.zeroLossBadge}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {workspace === 'LIVE' ? t.liveBannerSub : t.virtualBannerSub}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <span className="font-mono-tech text-[11px] text-slate-300">
            LOT: <strong className="text-emerald-300">${settings.amount_per_trade}</strong>
          </span>
          {workspace === 'DEMO' ? (
            <button
              type="button"
              onClick={onResetVirtual}
              className="flex min-h-[34px] cursor-pointer items-center gap-1.5 rounded-lg border border-cyan-400/45 bg-cyan-500/12 px-2.5 py-1 font-mono-tech text-[11px] font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/20"
            >
              <RotateCcw className="h-3 w-3" />
              {t.resetVirtualBtn}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigateTab('settings')}
              className="min-h-[34px] cursor-pointer rounded-lg border border-rose-400/50 bg-rose-500/15 px-2.5 py-1 font-mono-tech text-[11px] font-semibold text-rose-200 transition-colors hover:bg-rose-500/25"
            >
              API & Keys →
            </button>
          )}
        </div>
      </div>

      {/* Real-Time Desktop Trade Signal Notification Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/90 bg-[#070a12]/90 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
              notifPermission === 'denied'
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                : desktopAlertsEnabled && notifPermission === 'granted'
                  ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
            }`}
          >
            {desktopAlertsEnabled && notifPermission !== 'denied' ? (
              <BellRing className="h-4 w-4" />
            ) : (
              <BellOff className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-display text-xs font-bold tracking-wider text-slate-100 uppercase">
              <span>{t.desktopAlertsTitle}</span>
              <InfoTip text={t.helpDesktopAlerts} label={t.desktopAlertsTitle} />
            </div>
            <p className="truncate font-mono-tech text-[11px] text-slate-400">
              {notifPermission === 'unsupported'
                ? t.desktopAlertsUnsupported
                : notifPermission === 'denied'
                  ? t.desktopAlertsBlockedHint
                  : notifPermission === 'default'
                    ? t.desktopAlertsGrantHint
                    : t.desktopAlertsReadyHint}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={notifPermission === 'unsupported'}
            onClick={handleToggleDesktopAlerts}
            className={`flex min-h-[34px] cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1 font-mono-tech text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              notifPermission === 'denied'
                ? 'border-rose-500/45 bg-rose-500/10 text-rose-300'
                : notifPermission === 'default'
                  ? 'border-amber-400/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                  : desktopAlertsEnabled
                    ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                    : 'border-slate-700 bg-slate-900/70 text-slate-400 hover:text-slate-200'
            }`}
          >
            {desktopAlertsEnabled && notifPermission === 'granted' ? (
              <Bell className="h-3.5 w-3.5" />
            ) : (
              <BellOff className="h-3.5 w-3.5" />
            )}
            <span>
              {notifPermission === 'unsupported'
                ? t.desktopAlertsUnsupported
                : notifPermission === 'denied'
                  ? t.desktopAlertsBlocked
                  : notifPermission === 'default'
                    ? t.desktopAlertsEnableBtn
                    : desktopAlertsEnabled
                      ? t.desktopAlertsOn
                      : t.desktopAlertsOff}
            </span>
          </button>

          <button
            type="button"
            onClick={handleTestSignalAlert}
            className="flex min-h-[34px] cursor-pointer items-center gap-1.5 rounded-lg border border-cyan-500/45 bg-cyan-500/12 px-3 py-1 font-mono-tech text-[11px] font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/22"
          >
            <BellRing className="h-3.5 w-3.5" />
            <span>{t.desktopAlertsTestBtn}</span>
          </button>
        </div>
      </div>

      {/* Live Triggered Signal Notification Toast Banner */}
      <AnimatePresence>
        {activeSignalNotice && (
          <motion.div
            key={activeSignalNotice.id}
            initial={reducedMotion ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 ${
              activeSignalNotice.signal === 'BUY'
                ? 'border-emerald-400/55 bg-emerald-500/12 shadow-[0_0_20px_rgba(16,185,129,0.18)]'
                : 'border-rose-400/55 bg-rose-500/12 shadow-[0_0_20px_rgba(244,63,94,0.18)]'
            }`}
          >
            <button
              type="button"
              onClick={() => {
                audioSynth.playClick();
                setChartPair(activeSignalNotice.pair);
              }}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
            >
              <BellRing
                className={`h-4 w-4 shrink-0 ${
                  activeSignalNotice.signal === 'BUY' ? 'text-emerald-300' : 'text-rose-300'
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 font-display text-xs font-bold tracking-wider uppercase">
                  <span
                    className={
                      activeSignalNotice.signal === 'BUY' ? 'text-emerald-300' : 'text-rose-300'
                    }
                  >
                    {activeSignalNotice.title}
                  </span>
                  <span className="font-mono-tech text-[10px] font-normal text-slate-400">
                    {activeSignalNotice.time} ·{' '}
                    {activeSignalNotice.desktopDelivered ? 'Desktop + Terminal' : 'Terminal Alert'}
                  </span>
                </div>
                <p className="truncate font-mono-tech text-[11px] text-slate-200">
                  {activeSignalNotice.detail}
                </p>
              </div>
            </button>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setActiveSignalNotice(null)}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-slate-700/70 text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {workspace === 'LIVE' && !settings.bot_enabled && (
        <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-2.5 font-mono-tech text-xs text-amber-200">
          {t.liveIdleNotice}
        </div>
      )}

      {/* Row 1: Giant Bot Power Button + 3D Quantum Core + Equity Curve */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <TerminalPanel
          accent={isOffline ? 'crimson' : isRunning ? 'emerald' : 'neutral'}
          title={t.quantumCoreTitle}
          subtitle={statusHint}
          rightSlot={
            <div className="flex items-center gap-2">
              <InfoTip text={t.helpQuantumCore} label={t.quantumCoreTitle} />
              <span
                className={`font-mono-tech text-[11px] font-bold tracking-widest uppercase ${
                  isOffline
                    ? 'text-rose-400'
                    : isRunning
                      ? 'text-emerald-400'
                      : 'text-slate-400'
                }`}
              >
                {statusLabel}
              </span>
            </div>
          }
          className="lg:col-span-5"
          delay={0.04}
        >
          <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-2">
            {/* Giant Glowing Circular Bot Power Button */}
            <div className="flex flex-col items-center justify-center py-2">
              <div className="relative flex h-44 w-44 items-center justify-center">
                {isRunning && !reducedMotion && (
                  <>
                    <motion.div
                      animate={{ scale: [1, 1.12, 1], opacity: [0.35, 0.08, 0.35] }}
                      transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
                      className="pointer-events-none absolute inset-0 rounded-full border border-emerald-400/50 shadow-[0_0_40px_rgba(16,185,129,0.4)]"
                    />
                    <div
                      aria-hidden="true"
                      className="animate-orbit-slow pointer-events-none absolute inset-2 rounded-full border border-dashed border-cyan-400/45"
                    />
                    <div
                      aria-hidden="true"
                      className="animate-orbit-fast pointer-events-none absolute inset-4 rounded-full opacity-45"
                      style={{
                        background:
                          'conic-gradient(from 0deg, rgba(16,185,129,0.55) 0deg, transparent 70deg, transparent 360deg)',
                      }}
                    />
                  </>
                )}

                {isOffline && (
                  <div className="pointer-events-none absolute inset-2 rounded-full border border-dashed border-rose-500/50" />
                )}

                <motion.button
                  type="button"
                  disabled={toggling}
                  onClick={handlePowerClick}
                  onMouseEnter={() => audioSynth.playHover()}
                  whileTap={reducedMotion ? undefined : { scale: 0.94 }}
                  whileHover={reducedMotion ? undefined : { scale: 1.03 }}
                  aria-label={settings.bot_enabled ? t.botPowerOff : t.botPowerOn}
                  className={`relative z-10 flex h-32 w-32 cursor-pointer flex-col items-center justify-center rounded-full border-2 transition-all focus-visible:outline-2 focus-visible:outline-cyan-400 ${
                    isRunning
                      ? 'border-emerald-400 bg-gradient-to-b from-emerald-500/25 to-[#050b09] text-emerald-300 shadow-[0_0_35px_rgba(16,185,129,0.5),inset_0_0_20px_rgba(16,185,129,0.25)]'
                      : isOffline
                        ? 'border-rose-500/70 bg-gradient-to-b from-rose-500/15 to-[#0d0608] text-rose-300 shadow-[0_0_24px_rgba(244,63,94,0.3)]'
                        : 'border-slate-700 bg-gradient-to-b from-slate-800/40 to-[#07090f] text-slate-400 hover:border-slate-500 hover:text-slate-200'
                  }`}
                >
                  <Power
                    className={`h-9 w-9 transition-transform duration-300 ${
                      isRunning ? 'drop-shadow-[0_0_10px_rgba(52,211,153,0.9)]' : ''
                    }`}
                  />
                  <span className="mt-1.5 font-display text-sm font-bold tracking-widest uppercase">
                    {settings.bot_enabled ? 'ON' : 'OFF'}
                  </span>
                </motion.button>
              </div>

              <div className="mt-2 flex items-center gap-2 font-mono-tech text-[11px] text-slate-400">
                <Radio
                  className={`h-3.5 w-3.5 ${
                    isOffline
                      ? 'text-rose-400'
                      : isRunning
                        ? 'text-emerald-400'
                        : 'text-slate-500'
                  }`}
                />
                <span>
                  {t.heartbeatLabel}:{' '}
                  {new Date(settings.last_heartbeat).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              </div>
            </div>

            {/* 3D Core Radar Centerpiece + Trade Nodes + Design Switcher */}
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-800/70 bg-[#05070d] p-2">
              <QuantumCore3D
                status={botStatus}
                openTradesCount={stats.openTradesCount}
                visualMode={settings.core_visual}
                themeId={effectiveTheme}
                trades={trades}
                t={t}
              />
              <div className="mt-1.5 flex w-full flex-wrap items-center justify-center gap-1 px-1">
                {coreStyles.map((cs) => (
                  <button
                    key={cs.id}
                    type="button"
                    onClick={() => {
                      audioSynth.playClick();
                      onChangeCoreVisual(cs.id);
                    }}
                    className={`cursor-pointer rounded px-2 py-0.5 font-mono-tech text-[10px] uppercase transition-colors ${
                      settings.core_visual === cs.id
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {cs.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </TerminalPanel>

        {/* Equity Curve Chart */}
        <TerminalPanel
          accent="cyan"
          title={t.equityCurve}
          subtitle={`${workspace} · ${t.availableCapital}: $${stats.availableBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
          rightSlot={
            <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#05060a] p-1">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => {
                    audioSynth.playClick();
                    setTimeframe(tf);
                  }}
                  className={`min-h-[32px] cursor-pointer rounded px-2.5 py-1 font-mono-tech text-[11px] font-semibold transition-colors ${
                    timeframe === tf
                      ? 'bg-cyan-500/20 text-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.25)]'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          }
          className="lg:col-span-7"
          delay={0.1}
        >
          <div className="h-60 w-full sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={equityData} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="equityGlowGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.secondaryHex} stopOpacity={0.45} />
                    <stop offset="55%" stopColor={theme.primaryHex} stopOpacity={0.14} />
                    <stop offset="100%" stopColor="#05060a" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  stroke="rgba(51,65,85,0.28)"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  fontFamily="JetBrains Mono"
                />
                <YAxis
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  domain={['auto', 'auto']}
                  tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
                  fontFamily="JetBrains Mono"
                  width={68}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#090d16',
                    border: `1px solid ${theme.borderGlow}`,
                    borderRadius: '8px',
                    fontFamily: 'JetBrains Mono',
                    fontSize: '12px',
                    color: '#f1f5f9',
                  }}
                  formatter={(value: unknown) => [
                    `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
                    'Equity',
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="equity"
                  stroke={theme.primaryHex}
                  strokeWidth={2.2}
                  fill="url(#equityGlowGrad)"
                  isAnimationActive={!reducedMotion}
                  animationDuration={850}
                  dot={renderLatestDot as never}
                  activeDot={{ r: 5, fill: theme.primaryHex, stroke: '#05060a', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </TerminalPanel>
      </div>

      {/* Row 2: 6 Big Count-Up Stat Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {kpis.map((kpi, idx) => (
          <TerminalPanel
            key={kpi.label}
            accent={kpi.accent}
            delay={0.14 + idx * 0.03}
            sweep={false}
          >
            <div className="space-y-1.5">
              <div className="font-display text-[11px] font-semibold tracking-wider text-slate-400 uppercase truncate">
                {kpi.label}
              </div>
              <div className={`text-xl font-bold sm:text-2xl ${kpi.colorClass}`}>
                <AnimatedNumber
                  value={kpi.value}
                  decimals={kpi.decimals}
                  prefix={kpi.prefix}
                  suffix={kpi.suffix}
                  showSign={kpi.showSign}
                />
              </div>
            </div>
          </TerminalPanel>
        ))}
      </div>

      {/* Row 3: Pro Multi-Mode Candlestick Chart + Live Order Book / Depth / Quick Trade */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <TerminalPanel
          accent="cyan"
          title={t.candlestickTitle}
          subtitle="OHLCV · MA / EMA / BOLL / VWAP · Trade Markers (Buy & Profit/Loss)"
          rightSlot={<InfoTip text={t.helpCandlestick} label={t.candlestickTitle} />}
          className="lg:col-span-8"
        >
          <CandlestickChart
            pairs={marketPairs}
            selectedSymbol={chartPair}
            onSelectSymbol={setChartPair}
            candleStyle={settings.candle_style}
            onChangeCandleStyle={onChangeCandleStyle}
            t={t}
            binanceFeedLive={binanceFeedLive}
            trades={trades}
          />
        </TerminalPanel>

        <div className="lg:col-span-4">
          <BinanceOrderBook
            t={t}
            pair={marketPairs.find((p) => p.symbol === chartPair) ?? marketPairs[0]}
            defaultLot={settings.amount_per_trade}
            onQuickTrade={onQuickTrade}
          />
        </div>
      </div>

      {/* Row 4: Market Sentiment (Fear & Greed Gauge) + Smart Tracker */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <MarketSentimentWidget t={t} />
        </div>
        <div className="lg:col-span-6">
          <SmartTrackerWidget
            t={t}
            alerts={smartAlerts}
            selectedSymbol={chartPair}
            onSelectPair={setChartPair}
          />
        </div>
      </div>

      {/* Row 4.5: Custom Price Alert Rules Manager */}
      <TerminalPanel
        accent="cyan"
        title={t.priceAlertsTitle}
        subtitle={t.priceAlertsSub}
        rightSlot={<InfoTip text={t.priceAlertsSub} label={t.priceAlertsTitle} />}
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Add Price Alert Form */}
          <form onSubmit={handleAddPriceAlert} className="space-y-3 rounded-xl border border-slate-800/80 bg-[#05070d] p-4 lg:col-span-5">
            <div className="font-mono-tech text-xs font-bold text-cyan-300 uppercase">
              {t.addPriceAlert}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block font-mono-tech text-[10px] text-slate-400">{t.alertPair}</label>
                <select
                  value={alertPairInput}
                  onChange={(e) => setAlertPairInput(e.target.value)}
                  className="min-h-[38px] w-full rounded-lg border border-slate-700/80 bg-[#090d16] px-2 font-mono-tech text-xs text-slate-200 focus:border-cyan-400 focus:outline-none"
                >
                  {SUPPORTED_PAIRS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block font-mono-tech text-[10px] text-slate-400">{t.alertCondition}</label>
                <select
                  value={alertCondInput}
                  onChange={(e) => setAlertCondInput(e.target.value as 'ABOVE' | 'BELOW')}
                  className="min-h-[38px] w-full rounded-lg border border-slate-700/80 bg-[#090d16] px-2 font-mono-tech text-xs text-slate-200 focus:border-cyan-400 focus:outline-none"
                >
                  <option value="ABOVE">{t.abovePrice}</option>
                  <option value="BELOW">{t.belowPrice}</option>
                </select>
              </div>
            </div>
            <div>
              <label className="mb-1 block font-mono-tech text-[10px] text-slate-400">{t.alertTarget}</label>
              <input
                type="number"
                step="any"
                required
                placeholder="e.g. 98500"
                value={alertPriceInput}
                onChange={(e) => setAlertPriceInput(e.target.value)}
                className="min-h-[38px] w-full rounded-lg border border-slate-700/80 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-cyan-400 focus:outline-none"
              />
            </div>
            <NeonButton type="submit" variant="cyan" className="w-full min-h-[36px] py-1 text-xs">
              + {t.addPriceAlert}
            </NeonButton>
          </form>

          {/* Active / Triggered Alert Rules List */}
          <div className="space-y-2 rounded-xl border border-slate-800/80 bg-[#05070d] p-4 lg:col-span-7">
            <div className="flex items-center justify-between font-mono-tech text-xs font-semibold text-slate-200">
              <span>Active Rules ({customAlerts.filter(a => a.active).length})</span>
              <span className="text-slate-500">{customAlerts.length} Total</span>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
              {customAlerts.length === 0 ? (
                <div className="py-6 text-center font-mono-tech text-xs text-slate-500">
                  No price alerts configured yet. Add one on the left.
                </div>
              ) : (
                customAlerts.map((alert) => {
                  const pairData = marketPairs.find((p) => p.symbol === alert.pair);
                  const currentPrice = pairData?.price ?? 0;
                  return (
                    <div
                      key={alert.id}
                      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 font-mono-tech text-xs ${
                        alert.active
                          ? 'border-slate-800 bg-[#090d16]'
                          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      }`}
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white">{alert.pair}</span>
                          <span className={alert.condition === 'ABOVE' ? 'text-emerald-400' : 'text-rose-400'}>
                            {alert.condition === 'ABOVE' ? '≥' : '≤'} ${alert.targetPrice.toLocaleString()}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-400">
                          Current: ${currentPrice.toLocaleString()} · {alert.active ? 'Monitoring...' : 'Triggered ✓'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveAlert(alert.id)}
                        className="cursor-pointer rounded p-1 text-slate-500 hover:text-rose-400 transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </TerminalPanel>

      {/* Row 5: Open Positions + Live Feed Preview */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <TerminalPanel
          accent="emerald"
          title={t.openPositionsTitle}
          rightSlot={
            <button
              type="button"
              onClick={() => onNavigateTab('trades')}
              className="min-h-[36px] cursor-pointer rounded border border-emerald-500/35 px-2.5 py-1 font-mono-tech text-[11px] text-emerald-300 transition-colors hover:bg-emerald-500/15"
            >
              {t.navTrades} →
            </button>
          }
          className="lg:col-span-6"
          delay={0.22}
        >
          {openTrades.length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-xs text-slate-400">
              <TrendingUp className="h-4 w-4 text-slate-500" />
              <span>{t.noOpenTrades}</span>
            </div>
          ) : (
            <div className="space-y-2.5">
              {openTrades.map((trade) => {
                const isPos = trade.profit_usdt >= 0;
                const progress = Math.max(
                  4,
                  Math.min(
                    100,
                    ((trade.current_price - trade.entry_price) /
                      Math.max(0.0001, trade.take_profit_price - trade.entry_price)) *
                      100
                  )
                );
                return (
                  <div
                    key={trade.id}
                    className="rounded-lg border border-slate-800/80 bg-[#05070c] px-3 py-2.5"
                  >
                    <div className="flex items-center justify-between gap-2 font-mono-tech text-xs">
                      <span className="font-semibold text-slate-100">{trade.pair}</span>
                      <span className="text-slate-400">${trade.invested_usdt}</span>
                      <span className={isPos ? 'text-emerald-400' : 'text-rose-400'}>
                        {isPos ? '+' : ''}${trade.profit_usdt.toFixed(2)} ({isPos ? '+' : ''}
                        {trade.profit_pct.toFixed(2)}%)
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        className={`relative h-full overflow-hidden rounded-full transition-all duration-500 ${
                          isPos ? 'bg-emerald-400' : 'bg-rose-500'
                        }`}
                        style={{ width: `${progress}%` }}
                      >
                        {!reducedMotion && (
                          <div className="animate-tp-shimmer absolute inset-0 w-1/2 bg-gradient-to-r from-transparent via-white/50 to-transparent" />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TerminalPanel>

        <TerminalPanel
          accent="cyan"
          title={t.liveFeedTitle}
          rightSlot={
            <button
              type="button"
              onClick={() => onNavigateTab('feed')}
              className="min-h-[36px] cursor-pointer rounded border border-cyan-500/35 px-2.5 py-1 font-mono-tech text-[11px] text-cyan-300 transition-colors hover:bg-cyan-500/15"
            >
              {t.navFeed} →
            </button>
          }
          className="lg:col-span-6"
          delay={0.26}
        >
          <div className="space-y-2 font-mono-tech text-xs">
            {recentLogs.map((log) => {
              const lvlCls =
                log.level === 'TRADE'
                  ? 'text-emerald-400'
                  : log.level === 'WARNING'
                    ? 'text-amber-300'
                    : log.level === 'ERROR'
                      ? 'text-rose-400'
                      : 'text-cyan-300';
              return (
                <div
                  key={log.id}
                  className="flex items-start gap-2 rounded border border-slate-800/70 bg-[#05070c] px-2.5 py-2"
                >
                  <span className={`shrink-0 font-semibold ${lvlCls}`}>[{log.level}]</span>
                  <span className="min-w-0 flex-1 text-slate-300 truncate">
                    {log.pair ? `${log.pair}: ` : ''}
                    {log.message}
                  </span>
                </div>
              );
            })}
            {recentLogs.length === 0 && (
              <div className="flex items-center gap-2 py-4 text-slate-400">
                <Activity className="h-4 w-4" />
                <span>{t.emptyFeed}</span>
              </div>
            )}
          </div>
        </TerminalPanel>
      </div>

      {isOffline && (
        <div className="flex items-center gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-mono-tech text-xs text-rose-200">
          <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
          <span>{t.botStatusHintOffline}</span>
        </div>
      )}
    </div>
  );
};
