import React, { useCallback, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Cpu,
  Flame,
  Languages,
  Layers,
  Lock,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import { CommandCenter } from './components/screens/CommandCenter';
import { LiveEngineFeed } from './components/screens/LiveEngineFeed';
import { LoginScreen } from './components/screens/LoginScreen';
import { MarketHeatmap } from './components/screens/MarketHeatmap';
import { RiskPanel } from './components/screens/RiskPanel';
import { SettingsPanel } from './components/screens/SettingsPanel';
import { TradesScreen } from './components/screens/TradesScreen';
import { BootSequence } from './components/ui/BootSequence';
import { NeonButton } from './components/ui/MotionPrimitives';
import { TickerBar } from './components/ui/TickerBar';
import { useTradingTerminal } from './hooks/useTradingTerminal';
import { translations } from './i18n/translations';
import { audioSynth } from './lib/audioSynth';
import { TERMINAL_THEMES } from './lib/themes';
import { Language, TabId, TradingMode } from './types/trading';

export default function App() {
  const reducedMotion = useReducedMotion();
  const [lang, setLang] = useState<Language>('en');
  const [activeTab, setActiveTab] = useState<TabId>('command');
  const [bootComplete, setBootComplete] = useState(false);
  const [pendingLiveConfirm, setPendingLiveConfirm] = useState(false);

  const terminal = useTradingTerminal();
  const t = translations[lang];
  const activeTheme = TERMINAL_THEMES[terminal.effectiveTheme];

  const handleBootDone = useCallback(() => {
    setBootComplete(true);
  }, []);

  const navItems: {
    id: TabId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    { id: 'command', label: t.navCommand, icon: Cpu },
    { id: 'market', label: t.navMarket, icon: Flame },
    { id: 'feed', label: t.navFeed, icon: Terminal },
    { id: 'trades', label: t.navTrades, icon: Layers },
    { id: 'risk', label: t.navRisk, icon: BarChart3 },
    { id: 'settings', label: t.navSettings, icon: SettingsIcon },
  ];

  const toggleLanguage = () => {
    audioSynth.playClick();
    setLang((prev) => (prev === 'en' ? 'bn' : 'en'));
  };

  const handleTabChange = (tab: TabId) => {
    if (tab !== activeTab) {
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

  return (
    <div
      className="relative flex min-h-screen flex-col text-slate-100 transition-colors duration-500"
      style={{ backgroundColor: activeTheme.bgCanvas }}
    >
      {/* Ambient Animated Background Layers (Theme-synced, GPU compositor-only) */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div
          className="terminal-grid-bg absolute -inset-10 opacity-75"
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
            <span
              className={`hidden font-mono-tech text-[10px] tracking-widest uppercase sm:inline ${activeTheme.accentText}`}
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

          {/* Right Controls: Isolated VIRTUAL / LIVE Switcher + Language + Lock */}
          <div className="flex items-center gap-2 shrink-0">
            {terminal.isAuthenticated && (
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
            )}

            <button
              type="button"
              onClick={toggleLanguage}
              className="flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700/80 bg-[#090d16] px-2.5 py-1 font-mono-tech text-[11px] font-semibold text-slate-200 transition-colors hover:border-cyan-400/60 hover:text-cyan-300 whitespace-nowrap"
            >
              <Languages className="h-3.5 w-3.5 text-cyan-400" />
              <span>{lang === 'en' ? 'বাংলা' : 'EN'}</span>
            </button>

            {terminal.isAuthenticated && (
              <button
                type="button"
                onClick={() => {
                  audioSynth.playClick();
                  terminal.signOut();
                }}
                title={t.signOutBtn}
                className="flex min-h-[36px] cursor-pointer items-center gap-1 rounded-lg border border-slate-700/80 bg-[#090d16] px-2.5 py-1 font-mono-tech text-[11px] text-slate-300 transition-colors hover:border-rose-400/60 hover:text-rose-300 whitespace-nowrap"
              >
                <Lock className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t.signOutBtn}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-3 py-4 pb-24 sm:px-6 lg:pb-6">
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
                  getEquitySeries={terminal.getEquitySeries}
                  onToggleBot={terminal.toggleBot}
                  onChangeCoreVisual={(mode) =>
                    terminal.updateSettings({ core_visual: mode })
                  }
                  onChangeCandleStyle={(style) =>
                    terminal.updateSettings({ candle_style: style })
                  }
                  onQuickTrade={terminal.placeQuickTrade}
                  onResetVirtual={() => terminal.resetVirtualBalance(10000)}
                  onNavigateTab={(tab) => handleTabChange(tab)}
                />
              )}

              {activeTab === 'market' && (
                <MarketHeatmap
                  t={t}
                  pairs={terminal.marketPairs}
                  enabledPairs={terminal.settings.enabled_pairs}
                  openTrades={terminal.trades}
                  candleStyle={terminal.settings.candle_style}
                  binanceFeedLive={terminal.binanceFeedLive}
                  defaultLot={terminal.settings.amount_per_trade}
                  onChangeCandleStyle={(style) =>
                    terminal.updateSettings({ candle_style: style })
                  }
                  onTogglePair={terminal.togglePair}
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

              {activeTab === 'risk' && (
                <RiskPanel
                  t={t}
                  settings={terminal.settings}
                  stats={terminal.stats}
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
                  onSave={terminal.updateSettings}
                  onRequestWorkspaceSwitch={handleRequestWorkspaceSwitch}
                  onSaveTelegram={terminal.setTelegramConfig}
                  onTestTelegram={terminal.testTelegramConnection}
                  onSaveBinance={terminal.setBinanceConfig}
                  onVerifyBinance={terminal.verifyBinanceCredentials}
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
      <footer className="relative z-10 mt-auto pb-16 lg:pb-0">
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

      {/* Mobile-First Spring Bottom Tab Bar */}
      {terminal.isAuthenticated && (
        <nav
          aria-label="Mobile Navigation"
          className="fixed right-0 bottom-0 left-0 z-40 border-t border-cyan-500/25 bg-[#060911]/95 px-1 pb-safe lg:hidden"
        >
          <div className="grid h-14 grid-cols-6 items-center">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleTabChange(item.id)}
                  className={`relative flex h-full min-h-[44px] cursor-pointer flex-col items-center justify-center gap-0.5 transition-colors ${
                    active ? activeTheme.accentText : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="mobileBottomIndicator"
                      transition={
                        reducedMotion
                          ? { duration: 0 }
                          : { type: 'spring', stiffness: 460, damping: 30 }
                      }
                      className="absolute top-0 h-0.5 w-8 rounded-full"
                      style={{
                        backgroundColor: activeTheme.primaryHex,
                        boxShadow: `0 0 10px ${activeTheme.primaryHex}`,
                      }}
                    />
                  )}
                  <Icon className="h-4 w-4" />
                  <span className="font-mono-tech text-[9px] font-semibold tracking-tight uppercase truncate max-w-full px-0.5">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
