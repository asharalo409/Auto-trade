import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Cpu,
  Flame,
  Languages,
  Layers,
  LineChart,
  Lock,
  Power,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import { CommandCenter } from './components/screens/CommandCenter';
import { LiveEngineFeed } from './components/screens/LiveEngineFeed';
import { LoginScreen } from './components/screens/LoginScreen';
import { MarketHeatmap } from './components/screens/MarketHeatmap';
import { PerformanceScreen } from './components/screens/PerformanceScreen';
import { RiskPanel } from './components/screens/RiskPanel';
import { SettingsPanel } from './components/screens/SettingsPanel';
import { TradesScreen } from './components/screens/TradesScreen';
import { AudioStatusPill } from './components/ui/AudioStatusPill';
import { BootSequence } from './components/ui/BootSequence';
import { NeonButton } from './components/ui/MotionPrimitives';
import { TelegramProfileBadge } from './components/ui/TelegramProfileBadge';
import { TickerBar } from './components/ui/TickerBar';
import { BDT_PER_USD } from './data/demoData';
import { MIN_TRADEABLE_USDT } from './lib/tradeLimits';
import { useTradingTerminal } from './hooks/useTradingTerminal';
import { translations } from './i18n/translations';
import { audioSynth } from './lib/audioSynth';
import { initTelegramMiniApp, telegramHaptic } from './lib/telegramWebApp';
import { TERMINAL_THEMES } from './lib/themes';
import { BackgroundPresetId, Language, TabId, TradingMode } from './types/trading';

const STORAGE_BG_PREDATOR_KEY = 'aegis_bg_predator_v1';

const PREDATOR_BG_SRC: Record<Exclude<BackgroundPresetId, 'none'>, string> = {
  tiger: '/src/assets/images/predator_tiger_red_eyes_1795118033481.jpg',
  lion: '/src/assets/images/predator_lion_red_eyes_1795118034764.jpg',
  eagle: '/src/assets/images/predator_eagle_red_eyes_1795118034989.jpg',
};

export default function App() {
  const reducedMotion = useReducedMotion();
  const [lang, setLang] = useState<Language>('en');
  const [activeTab, setActiveTab] = useState<TabId>('command');
  const [bootComplete, setBootComplete] = useState(false);
  const [pendingLiveConfirm, setPendingLiveConfirm] = useState(false);
  const [bgPredator, setBgPredator] = useState<BackgroundPresetId>(() => {
    if (typeof window === 'undefined') return 'tiger';
    try {
      const saved = window.localStorage.getItem(STORAGE_BG_PREDATOR_KEY);
      if (saved === 'tiger' || saved === 'lion' || saved === 'eagle' || saved === 'none') {
        return saved;
      }
    } catch {
      // ignore storage errors
    }
    return 'tiger';
  });

  const handleChangeBgPredator = useCallback((bg: BackgroundPresetId) => {
    setBgPredator(bg);
    try {
      window.localStorage.setItem(STORAGE_BG_PREDATOR_KEY, bg);
    } catch {
      // ignore storage errors
    }
  }, []);

  const terminal = useTradingTerminal();
  const [engineToggling, setEngineToggling] = useState(false);
  const engineRunning = terminal.botStatus === 'RUNNING';

  // Full-screen Telegram Mini App bootstrap (no-op in a normal browser tab).
  useEffect(() => {
    initTelegramMiniApp();
  }, []);
  const t = translations[lang];
  const activeTheme = TERMINAL_THEMES[terminal.effectiveTheme];
  // Headline = full portfolio; only Spot USDT can actually fund orders.
  const tradeableUsdt = terminal.binanceAccount?.usdtFree ?? 0;

  const handleBootDone = useCallback(() => {
    setBootComplete(true);
  }, []);

  const navItems: {
    id: TabId;
    label: string;
    shortLabel?: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    { id: 'command', label: t.navCommand, icon: Cpu },
    { id: 'market', label: t.navMarket, icon: Flame },
    { id: 'feed', label: t.navFeed, icon: Terminal },
    { id: 'trades', label: t.navTrades, icon: Layers },
    {
      id: 'performance',
      label: t.navPerformance,
      shortLabel: t.navPerformanceShort,
      icon: LineChart,
    },
    { id: 'risk', label: t.navRisk, icon: BarChart3 },
    { id: 'settings', label: t.navSettings, icon: SettingsIcon },
  ];

  const toggleLanguage = () => {
    audioSynth.playClick();
    setLang((prev) => (prev === 'en' ? 'bn' : 'en'));
  };

  const handleTabChange = (tab: TabId) => {
    if (tab !== activeTab) {
      telegramHaptic('light');
      audioSynth.playTabSwitch();
      setActiveTab(tab);
    }
  };

  const handleRequestWorkspaceSwitch = (target: TradingMode) => {
    if (target === terminal.activeWorkspace) return;
    if (target === 'LIVE') {
      audioSynth.playClick();
      setPendingLiveConfirm(true);
    } else {
      terminal.switchWorkspace('DEMO');
    }
  };

  const handleEngineToggle = useCallback(async () => {
    if (engineToggling) return;
    telegramHaptic('light');
    audioSynth.playToggle(!engineRunning);
    setEngineToggling(true);
    try {
      await terminal.toggleBot();
    } finally {
      setEngineToggling(false);
    }
  }, [engineToggling, engineRunning, terminal.toggleBot]);

  const handleDockWorkspace = (target: TradingMode) => {
    if (target === terminal.activeWorkspace) return;
    telegramHaptic('light');
    handleRequestWorkspaceSwitch(target);
  };

  const dockTabClass = (active: boolean) =>
    `relative flex min-h-[44px] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl transition-colors ${
      active ? activeTheme.accentText : 'text-slate-500 active:text-slate-200'
    }`;

  const renderDockTab = (item: (typeof navItems)[number]) => {
    const Icon = item.icon;
    const active = activeTab === item.id;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => handleTabChange(item.id)}
        aria-current={active ? 'page' : undefined}
        className={dockTabClass(active)}
      >
        {active && (
          <motion.span
            layoutId="miniDockActive"
            transition={
              reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 460, damping: 30 }
            }
            className="absolute inset-x-1 inset-y-0.5 rounded-xl bg-white/[0.07] ring-1 ring-inset ring-white/10"
          />
        )}
        <Icon className="relative z-10 h-[17px] w-[17px]" />
        <span className="relative z-10 max-w-full truncate px-0.5 font-mono-tech text-[8px] font-semibold tracking-tight uppercase">
          {item.shortLabel ?? item.label}
        </span>
      </button>
    );
  };

  return (
    <div
      className="relative flex min-h-screen flex-col text-slate-100 transition-colors duration-500"
      style={{ backgroundColor: activeTheme.bgCanvas }}
    >
      {/* Ambient Animated Background Layers + Cyber Mesh HUD + Predator Red-Eye Backdrop */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div aria-hidden="true" className="cyber-mesh-bg absolute inset-0 opacity-90" />
        <div aria-hidden="true" className="hud-radial-glow absolute inset-0" />
        {bgPredator !== 'none' && (
          <>
            <img
              src={PREDATOR_BG_SRC[bgPredator]}
              alt=""
              aria-hidden="true"
              referrerPolicy="no-referrer"
              className="absolute inset-0 h-full w-full object-cover object-center opacity-45 select-none transition-opacity duration-500"
            />
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-b from-[#040509]/70 via-[#040509]/45 to-[#040509]/85"
            />
          </>
        )}
        <div
          className={`terminal-grid-bg absolute -inset-10 ${
            bgPredator === 'none' ? 'opacity-75' : 'opacity-40'
          }`}
          style={{
            backgroundImage: `linear-gradient(to right, ${activeTheme.gridRgba} 1px, transparent 1px), linear-gradient(to bottom, ${activeTheme.gridRgba} 1px, transparent 1px)`,
          }}
        />
        <div
          className={`animate-blob-a absolute -top-24 -left-24 h-96 w-96 rounded-full blur-3xl ${activeTheme.blobAClass}`}
        />
        <div
          className={`animate-blob-b absolute top-1/3 -right-24 h-96 w-96 rounded-full blur-3xl ${activeTheme.blobBClass}`}
        />
        <div className="animate-blob-a absolute bottom-0 left-1/3 h-80 w-80 rounded-full bg-amber-500/10 blur-3xl" />
        <div className="scanline-overlay absolute inset-0 opacity-30" />
      </div>

      {/* Cinematic Boot Sequence */}
      <AnimatePresence>
        {!bootComplete && (
          <BootSequence onComplete={handleBootDone} skipLabel={t.skipBoot} />
        )}
      </AnimatePresence>

      {/* Top Live Ticker */}
      <div className="relative z-30">
        <TickerBar
          pairs={terminal.marketPairs}
          botStatus={terminal.botStatus}
          mode={terminal.activeWorkspace}
          position="top"
          balance={terminal.stats.balance}
          openCount={terminal.stats.openTradesCount}
        />
      </div>

      {/* Top Header Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#05060a]/92 px-3 sm:px-6">
        <div className="mx-auto flex h-12 max-w-7xl items-center justify-between gap-3 sm:h-14">
          {/* Brand Wordmark */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="font-display text-lg font-bold tracking-widest text-white uppercase whitespace-nowrap sm:text-xl">
              {t.brandTitle}
            </span>
            <TelegramProfileBadge />
            <span
              className={`hidden font-mono-tech text-[10px] tracking-widest uppercase xl:inline ${activeTheme.accentText}`}
            >
              {t.brandSub}
            </span>
          </div>

          {/* Desktop Navigation Tabs */}
          {terminal.isAuthenticated && (
            <nav
              aria-label="Primary Navigation"
              className="hidden lg:flex items-center gap-1"
            >
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => audioSynth.playHover()}
                    onClick={() => handleTabChange(item.id)}
                    className={`relative flex min-h-[38px] cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono-tech text-xs font-medium tracking-wide uppercase transition-colors whitespace-nowrap shrink-0 ${
                      active ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="desktopActiveTab"
                        transition={
                          reducedMotion
                            ? { duration: 0 }
                            : { type: 'spring', stiffness: 420, damping: 32 }
                        }
                        className={`absolute inset-0 rounded-lg border ${activeTheme.accentBorder} ${activeTheme.accentBg}`}
                      />
                    )}
                    <Icon className="relative z-10 h-3.5 w-3.5" />
                    <span className="relative z-10">{item.label}</span>
                  </button>
                );
              })}
            </nav>
          )}

          {/* Right Controls: Isolated VIRTUAL / LIVE Switcher + Live Balance Pill + Audio + Language + Lock */}
          <div className="flex items-center gap-2 shrink-0">
            {terminal.isAuthenticated && (
              <div className="hidden sm:flex">
                <AudioStatusPill
                  ready={terminal.audioReady}
                  voiceEnabled={terminal.voiceEnabled}
                  onUnlock={terminal.testVoice}
                />
              </div>
            )}
            {terminal.isAuthenticated && (
              <div className="hidden items-center gap-1.5 md:flex">
                <div className="flex items-center rounded-lg border border-slate-800 bg-[#080b12] p-0.5">
                  <button
                    type="button"
                    onClick={() => handleRequestWorkspaceSwitch('DEMO')}
                    className={`min-h-[30px] cursor-pointer rounded px-2 py-0.5 font-mono-tech text-[10px] font-bold tracking-wider uppercase transition-all whitespace-nowrap ${
                      terminal.activeWorkspace === 'DEMO'
                        ? 'bg-cyan-500/25 text-cyan-200'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {t.modeDemo}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRequestWorkspaceSwitch('LIVE')}
                    className={`min-h-[30px] cursor-pointer rounded px-2 py-0.5 font-mono-tech text-[10px] font-bold tracking-wider uppercase transition-all whitespace-nowrap ${
                      terminal.activeWorkspace === 'LIVE'
                        ? 'bg-rose-500/30 text-rose-200 shadow-[0_0_12px_rgba(244,63,94,0.35)]'
                        : 'text-slate-500 hover:text-rose-300'
                    }`}
                  >
                    {t.modeLive}
                  </button>
                </div>

                {/* Live / Virtual Real Money Balance Pill (USD + BDT) */}
                <button
                  type="button"
                  onClick={() =>
                    handleTabChange(
                      terminal.activeWorkspace === 'LIVE' && !terminal.hasBinanceKeys
                        ? 'settings'
                        : 'command'
                    )
                  }
                  title={
                    terminal.activeWorkspace === 'LIVE'
                      ? !terminal.hasBinanceKeys
                        ? 'Binance API Keys Not Linked ($0.00)'
                        : terminal.binanceAccount?.errorDetail
                          ? `Binance Sync Error: ${terminal.binanceAccount.errorDetail}`
                          : terminal.syncingBalance
                            ? 'Syncing Live Binance Balance...'
                            : 'Live Binance portfolio — coins + Spot/Funding/Earn. Tradeable cash is Spot USDT only.'
                      : 'Virtual Demo USDT Balance (USD & BDT)'
                  }
                  className={`flex min-h-[32px] cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono-tech text-[11px] font-bold tracking-tight transition-all whitespace-nowrap ${
                    terminal.activeWorkspace === 'LIVE'
                      ? terminal.binanceAccount?.errorDetail
                        ? 'border-rose-500/60 bg-rose-500/15 text-rose-200'
                        : !terminal.hasBinanceKeys
                          ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                          : 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.28)]'
                      : 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200 shadow-[0_0_10px_rgba(34,211,238,0.18)]'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full animate-pulse ${
                      terminal.activeWorkspace === 'LIVE'
                        ? terminal.binanceAccount?.errorDetail
                          ? 'bg-rose-400'
                          : !terminal.hasBinanceKeys
                            ? 'bg-amber-400'
                            : 'bg-emerald-400'
                        : 'bg-cyan-400'
                    }`}
                  />
                  <span className="flex flex-col items-start leading-tight">
                    <span>
                      {terminal.activeWorkspace === 'LIVE' ? 'LIVE' : 'DEMO'}:{' '}
                      {terminal.activeWorkspace === 'LIVE' && terminal.syncingBalance
                        ? 'SYNCING...'
                        : `$${terminal.stats.balance.toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}`}
                      {terminal.activeWorkspace === 'LIVE' && !terminal.hasBinanceKeys && (
                        <span className="ml-1 text-[10px] text-amber-300">(NO KEYS)</span>
                      )}
                      {terminal.activeWorkspace === 'LIVE' && terminal.binanceAccount?.errorDetail && (
                        <span className="ml-1 text-[10px] text-rose-300">(API ERR)</span>
                      )}
                      <span className="hidden text-emerald-200/90 sm:inline">
                        {' '}
                        · ৳{Math.round(terminal.stats.balance * BDT_PER_USD).toLocaleString('en-US')}
                      </span>
                    </span>
                    {terminal.activeWorkspace === 'LIVE' && terminal.binanceAccount?.connected && (
                      <span
                        className={`text-[9px] font-semibold tracking-tight ${
                          tradeableUsdt >= MIN_TRADEABLE_USDT
                            ? 'text-emerald-300/85'
                            : 'text-amber-300'
                        }`}
                      >
                        {t.tradeableUsdtShort}: ${tradeableUsdt.toFixed(2)}
                      </span>
                    )}
                  </span>
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={toggleLanguage}
              className="tap-target flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700/80 bg-[#090d16] px-2.5 py-1 font-mono-tech text-[11px] font-semibold text-slate-200 transition-colors hover:border-cyan-400/60 hover:text-cyan-300 whitespace-nowrap"
            >
              <Languages className="h-3.5 w-3.5 text-cyan-400" />
              <span className="hidden sm:inline">{lang === 'en' ? 'বাংলা' : 'EN'}</span>
            </button>

            {terminal.isAuthenticated && (
              <button
                type="button"
                onClick={() => {
                  audioSynth.playClick();
                  terminal.signOut();
                }}
                title={t.signOutBtn}
                className="tap-target flex min-h-[36px] cursor-pointer items-center gap-1 rounded-lg border border-slate-700/80 bg-[#090d16] px-2.5 py-1 font-mono-tech text-[11px] text-slate-300 transition-colors hover:border-rose-400/60 hover:text-rose-300 whitespace-nowrap"
              >
                <Lock className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t.signOutBtn}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-3 py-4 pb-40 sm:px-6 lg:pb-6">
        {terminal.errorMsg && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/45 bg-rose-500/10 px-4 py-3 font-mono-tech text-xs text-rose-200">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
              <span>
                {t.errorLoading} ({terminal.errorMsg})
              </span>
            </div>
            <button
              type="button"
              onClick={terminal.refreshData}
              className="flex items-center gap-1.5 rounded border border-rose-400/50 px-2.5 py-1 text-rose-200 hover:bg-rose-500/20"
            >
              <RefreshCw className="h-3 w-3" />
              {t.retry}
            </button>
          </div>
        )}

        {terminal.authLoading ? (
          <div className="flex min-h-[50vh] items-center justify-center font-mono-tech text-xs text-cyan-300">
            <Activity className="mr-2 h-4 w-4 animate-spin" />
            SYNCING AUTH SESSION...
          </div>
        ) : !terminal.isAuthenticated ? (
          <LoginScreen
            t={t}
            isSupabaseConfigured={terminal.isSupabaseConfigured}
            onSignIn={terminal.signIn}
            onSignUp={terminal.signUp}
            onResetPassword={terminal.resetPassword}
            onEnterDemo={terminal.enterDemoMode}
            onReplayBoot={() => setBootComplete(false)}
          />
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={`${terminal.activeWorkspace}-${activeTab}`}
              initial={reducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reducedMotion ? undefined : { opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              {activeTab === 'command' && (
                <CommandCenter
                  t={t}
                  workspace={terminal.activeWorkspace}
                  settings={terminal.settings}
                  effectiveTheme={terminal.effectiveTheme}
                  botStatus={terminal.botStatus}
                  loading={terminal.dataLoading}
                  stats={terminal.stats}
                  trades={terminal.trades}
                  logs={terminal.logs}
                  marketPairs={terminal.marketPairs}
                  smartAlerts={terminal.smartAlerts}
                  binanceFeedLive={terminal.binanceFeedLive}
                  hasBinanceKeys={terminal.hasBinanceKeys}
                  hasTelegramKeys={terminal.hasTelegramKeys}
                  binanceAccount={terminal.binanceAccount}
                  syncingBalance={terminal.syncingBalance}
                  alertEnabledPairs={terminal.alertEnabledPairs}
                  getEquitySeries={terminal.getEquitySeries}
                  onToggleBot={terminal.toggleBot}
                  onToggleTelegram={(enabled) =>
                    terminal.updateSettings({ telegram_enabled: enabled })
                  }
                  onChangeCoreVisual={(mode) =>
                    terminal.updateSettings({ core_visual: mode })
                  }
                  onChangeCandleStyle={(style) =>
                    terminal.updateSettings({ candle_style: style })
                  }
                  onQuickTrade={terminal.placeQuickTrade}
                  onResetVirtual={() => terminal.resetVirtualBalance(10000)}
                  voiceEnabled={terminal.voiceEnabled}
                  audioReady={terminal.audioReady}
                  onToggleVoice={terminal.toggleVoice}
                  onTestVoice={terminal.testVoice}
                  onCloseAll={terminal.closeAllPositions}
                  liveUsdtFree={tradeableUsdt}
                  onRefreshBalance={() =>
                    terminal.refreshBinanceBalance(undefined, { announce: true })
                  }
                  onSendSignalTelegram={terminal.sendSignalToTelegram}
                  onSendBalanceTelegram={terminal.sendTelegramBalanceSnapshot}
                  onNavigateTab={(tab) => handleTabChange(tab)}
                />
              )}

              {activeTab === 'market' && (
                <MarketHeatmap
                  t={t}
                  pairs={terminal.marketPairs}
                  enabledPairs={terminal.settings.enabled_pairs}
                  alertEnabledPairs={terminal.alertEnabledPairs}
                  openTrades={terminal.trades}
                  candleStyle={terminal.settings.candle_style}
                  binanceFeedLive={terminal.binanceFeedLive}
                  defaultLot={terminal.settings.amount_per_trade}
                  onChangeCandleStyle={(style) =>
                    terminal.updateSettings({ candle_style: style })
                  }
                  onTogglePair={terminal.togglePair}
                  onTogglePairAlert={terminal.togglePairAlert}
                  onQuickTrade={terminal.placeQuickTrade}
                />
              )}

              {activeTab === 'feed' && (
                <LiveEngineFeed
                  t={t}
                  logs={terminal.logs}
                  loading={terminal.dataLoading}
                />
              )}

              {activeTab === 'trades' && (
                <TradesScreen
                  t={t}
                  trades={terminal.trades}
                  zeroLossMode={terminal.settings.zero_loss_mode}
                  loading={terminal.dataLoading}
                  onCloseTrade={terminal.closeTrade}
                />
              )}

              {activeTab === 'performance' && (
                <PerformanceScreen
                  t={t}
                  trades={terminal.trades}
                  stats={terminal.stats}
                />
              )}

              {activeTab === 'risk' && (
                <RiskPanel
                  t={t}
                  settings={terminal.settings}
                  stats={terminal.stats}
                  trades={terminal.trades}
                />
              )}

              {activeTab === 'settings' && (
                <SettingsPanel
                  t={t}
                  workspace={terminal.activeWorkspace}
                  settings={terminal.settings}
                  saving={terminal.savingSettings}
                  telegramConfig={terminal.telegramConfig}
                  binanceConfig={terminal.binanceConfig}
                  binanceAccount={terminal.binanceAccount}
                  syncingBalance={terminal.syncingBalance}
                  bgPredator={bgPredator}
                  onChangeBgPredator={handleChangeBgPredator}
                  onSave={terminal.updateSettings}
                  onRequestWorkspaceSwitch={handleRequestWorkspaceSwitch}
                  onSaveTelegram={terminal.setTelegramConfig}
                  onTestTelegram={terminal.testTelegramConnection}
                  onSendBalanceTelegram={terminal.sendTelegramBalanceSnapshot}
                  onSaveBinance={terminal.setBinanceConfig}
                  onVerifyBinance={terminal.verifyBinanceCredentials}
                  voiceEnabled={terminal.voiceEnabled}
                  onToggleVoice={terminal.toggleVoice}
                  onTestVoice={terminal.testVoice}
                  onSpeakBalance={terminal.speakBalance}
                />
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </main>

      {/* Red Warning Confirm Dialog for Switching to Isolated LIVE Account Workspace */}
      <AnimatePresence>
        {pendingLiveConfirm && (
          <motion.div
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reducedMotion ? undefined : { opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4"
          >
            <motion.div
              initial={reducedMotion ? false : { scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={reducedMotion ? undefined : { scale: 0.94, opacity: 0 }}
              className="w-full max-w-md rounded-2xl border border-rose-500/70 bg-[#0d0609] p-6 shadow-[0_0_50px_rgba(244,63,94,0.45)]"
            >
              <div className="flex items-center gap-3 text-rose-400">
                <AlertTriangle className="h-6 w-6 shrink-0" />
                <h3 className="font-display text-lg font-bold tracking-wider uppercase">
                  {t.liveWarningTitle}
                </h3>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-300">
                {t.liveWarningBody}
              </p>
              <div className="mt-5 flex items-center justify-end gap-3">
                <NeonButton
                  variant="ghost"
                  onClick={() => setPendingLiveConfirm(false)}
                >
                  {t.cancel}
                </NeonButton>
                <NeonButton
                  variant="rose"
                  onClick={() => {
                    terminal.switchWorkspace('LIVE');
                    setPendingLiveConfirm(false);
                  }}
                >
                  {t.liveWarningConfirm}
                </NeonButton>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer + Bottom Ticker */}
      <footer className="relative z-10 mt-auto pb-28 lg:pb-0">
        <div className="border-t border-slate-800/70 bg-[#05060a]/90 px-4 py-3 text-center font-mono-tech text-[11px] tracking-wider text-slate-400">
          {t.footerCredit}
        </div>
        <div className="hidden lg:block">
          <TickerBar
            pairs={terminal.marketPairs}
            botStatus={terminal.botStatus}
            mode={terminal.activeWorkspace}
            position="bottom"
            balance={terminal.stats.balance}
            openCount={terminal.stats.openTradesCount}
          />
        </div>
      </footer>

      {/* Floating Mini App Dock — workspace switch + center engine action */}
      {terminal.isAuthenticated && (
        <div className="fixed inset-x-0 bottom-0 z-40 lg:hidden">
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-[#070b10] via-[#070b10]/80 to-transparent" />
          <div className="relative mx-auto w-full max-w-md px-3">
            {/* Workspace switch pill */}
            <div className="mb-2 flex justify-center">
              <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-[#0a0f16]/90 p-0.5 backdrop-blur-xl">
                <button
                  type="button"
                  onClick={() => handleDockWorkspace('DEMO')}
                  className={`min-h-[26px] cursor-pointer rounded-full px-3 font-mono-tech text-[9px] font-bold tracking-widest uppercase transition-colors ${
                    terminal.activeWorkspace === 'DEMO'
                      ? 'bg-cyan-500/25 text-cyan-200'
                      : 'text-slate-500 active:text-slate-300'
                  }`}
                >
                  Virtual
                </button>
                <button
                  type="button"
                  onClick={() => handleDockWorkspace('LIVE')}
                  className={`min-h-[26px] cursor-pointer rounded-full px-3 font-mono-tech text-[9px] font-bold tracking-widest uppercase transition-colors ${
                    terminal.activeWorkspace === 'LIVE'
                      ? 'bg-rose-500/30 text-rose-200'
                      : 'text-slate-500 active:text-rose-300'
                  }`}
                >
                  Live
                </button>
              </div>
            </div>

            <nav
              aria-label="Mobile Navigation"
              className="mini-dock relative mb-2 flex items-center gap-1 rounded-[26px] border border-white/10 px-1.5 py-2 backdrop-blur-2xl"
            >
              <div className="flex flex-1 items-center justify-around">
                {navItems.slice(0, 3).map(renderDockTab)}
              </div>

              {/* Highlighted center engine action */}
              <button
                type="button"
                onClick={() => void handleEngineToggle()}
                disabled={engineToggling}
                aria-label={engineRunning ? 'Stop trading engine' : 'Start trading engine'}
                aria-pressed={engineRunning}
                className={`relative -my-5 flex h-14 w-14 shrink-0 cursor-pointer flex-col items-center justify-center gap-0 rounded-full border transition-all active:scale-95 disabled:opacity-70 ${
                  engineRunning
                    ? 'dock-fab-on border-emerald-300/70 bg-gradient-to-br from-emerald-300 via-emerald-400 to-teal-600 text-[#04120c]'
                    : 'dock-fab-off border-white/15 bg-gradient-to-br from-slate-700 to-slate-900 text-slate-300'
                }`}
              >
                {engineRunning && !reducedMotion && (
                  <motion.span
                    aria-hidden="true"
                    animate={{ scale: [1, 1.35, 1], opacity: [0.45, 0, 0.45] }}
                    transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                    className="pointer-events-none absolute inset-0 rounded-full border border-emerald-300/60"
                  />
                )}
                <Power className="h-[18px] w-[18px]" />
                <span className="font-mono-tech text-[8px] font-black tracking-widest">
                  {engineToggling ? '···' : engineRunning ? 'ON' : 'OFF'}
                </span>
              </button>

              <div className="flex flex-1 items-center justify-around">
                {navItems.slice(3).map(renderDockTab)}
              </div>
            </nav>
          </div>
        </div>
      )}
    </div>
  );
}
