import React, { useEffect, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  Moon,
  Palette,
  Save,
  Send,
  ShieldCheck,
  Sun,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { SUPABASE_SQL_SCHEMA, SUPPORTED_PAIRS } from '../../data/demoData';
import { audioSynth } from '../../lib/audioSynth';
import { getTimeBasedTheme, TERMINAL_THEMES } from '../../lib/themes';
import {
  BinanceConfig,
  BotSettings,
  CoreVisualMode,
  TelegramConfig,
  ThemeId,
  TradingMode,
} from '../../types/trading';
import { InfoTip } from '../ui/InfoTip';
import { NeonButton, SciFiSwitch } from '../ui/MotionPrimitives';
import { TerminalPanel } from '../ui/TerminalPanel';

interface SettingsPanelProps {
  t: Record<string, string>;
  workspace: TradingMode;
  settings: BotSettings;
  saving: boolean;
  telegramConfig: TelegramConfig;
  binanceConfig: BinanceConfig;
  onSave: (patch: Partial<BotSettings>) => Promise<void>;
  onRequestWorkspaceSwitch: (mode: TradingMode) => void;
  onSaveTelegram: (cfg: TelegramConfig) => void;
  onTestTelegram: (cfg: TelegramConfig) => Promise<{ ok: boolean; detail: string }>;
  onSaveBinance: (cfg: BinanceConfig) => void;
  onVerifyBinance: (cfg: BinanceConfig) => Promise<{ ok: boolean; detail: string }>;
}

const LOT_PRESETS = [1, 5, 10, 25, 50, 100, 250];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  t,
  workspace,
  settings,
  saving,
  telegramConfig,
  binanceConfig,
  onSave,
  onRequestWorkspaceSwitch,
  onSaveTelegram,
  onTestTelegram,
  onSaveBinance,
  onVerifyBinance,
}) => {
  const [draft, setDraft] = useState<BotSettings>(settings);
  const [tgDraft, setTgDraft] = useState<TelegramConfig>(telegramConfig);
  const [bnDraft, setBnDraft] = useState<BinanceConfig>(binanceConfig);
  const [showSecrets, setShowSecrets] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [tgFeedback, setTgFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [bnFeedback, setBnFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [testingTg, setTestingTg] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);
  const [showGuideSql, setShowGuideSql] = useState(false);

  // Sync draft only when switching workspace/settings row or explicit settings update (ignore last_heartbeat ticks)
  useEffect(() => {
    setDraft(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.id, settings.mode, settings.updated_at, settings.zero_loss_mode, settings.bot_enabled]);

  useEffect(() => {
    setTgDraft(telegramConfig);
  }, [telegramConfig]);

  useEffect(() => {
    setBnDraft(binanceConfig);
  }, [binanceConfig]);

  const handleSave = async () => {
    onSaveTelegram(tgDraft);
    onSaveBinance(bnDraft);
    await onSave({
      amount_per_trade: Math.max(1, draft.amount_per_trade),
      take_profit_pct: draft.take_profit_pct,
      stop_loss_enabled: draft.zero_loss_mode ? false : draft.stop_loss_enabled,
      stop_loss_pct: draft.stop_loss_pct,
      sell_only_in_profit: draft.zero_loss_mode ? true : draft.sell_only_in_profit,
      zero_loss_mode: draft.zero_loss_mode,
      dca_enabled: draft.dca_enabled,
      dca_step_pct: draft.dca_step_pct,
      dca_max_buys: draft.dca_max_buys,
      auto_theme_by_time: draft.auto_theme_by_time,
      max_open_trades: draft.max_open_trades,
      max_amount_per_pair: draft.max_amount_per_pair,
      daily_loss_limit: draft.daily_loss_limit,
      enabled_pairs: draft.enabled_pairs,
      telegram_enabled: draft.telegram_enabled,
      sound_enabled: draft.sound_enabled,
      theme: draft.theme,
      core_visual: draft.core_visual,
    });
    setSavedToast(true);
    window.setTimeout(() => setSavedToast(false), 2400);
  };

  const toggleDraftPair = (symbol: string) => {
    const exists = draft.enabled_pairs.includes(symbol);
    audioSynth.playToggle(!exists);
    setDraft((prev) => ({
      ...prev,
      enabled_pairs: exists
        ? prev.enabled_pairs.filter((p) => p !== symbol)
        : [...prev.enabled_pairs, symbol],
    }));
  };

  const handleTestTg = async () => {
    setTestingTg(true);
    setTgFeedback(null);
    const res = await onTestTelegram(tgDraft);
    setTestingTg(false);
    setTgFeedback({ ok: res.ok, text: res.detail });
  };

  const handleVerifyBn = async () => {
    const res = await onVerifyBinance(bnDraft);
    setBnFeedback({ ok: res.ok, text: res.detail });
  };

  const handleCopySql = async () => {
    audioSynth.playClick();
    try {
      await navigator.clipboard.writeText(SUPABASE_SQL_SCHEMA);
      setCopiedSql(true);
      window.setTimeout(() => setCopiedSql(false), 2200);
    } catch {
      setShowGuideSql(true);
    }
  };

  const themeList = Object.values(TERMINAL_THEMES);
  const coreModes: { id: CoreVisualMode; label: string }[] = [
    { id: 'torus', label: t.coreStyleTorus },
    { id: 'lorenz', label: t.coreStyleLorenz },
    { id: 'vortex', label: t.coreStyleVortex },
    { id: 'depth', label: t.coreStyleDepth },
  ];
  const timeThemeInfo = getTimeBasedTheme();

  return (
    <div className="space-y-4">
      {/* Section 1: Global Sound FX, Auto Time Theme, 7 Premium Themes & 3D Design */}
      <TerminalPanel
        accent="cyan"
        title={`${t.themeSelectorTitle} // ${t.soundToggleTitle}`}
        rightSlot={
          <NeonButton
            variant={savedToast ? 'emerald' : 'cyan'}
            onClick={handleSave}
            disabled={saving}
          >
            {savedToast ? (
              <>
                <Check className="h-3.5 w-3.5" />
                {t.settingsSaved}
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5" />
                {saving ? t.savingSettings : t.saveSettings}
              </>
            )}
          </NeonButton>
        }
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Global Sound + Auto Day/Night Theme */}
          <div className="space-y-3 lg:col-span-4">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-[#05070d] p-3.5">
              <div className="flex items-start gap-2.5">
                {draft.sound_enabled ? (
                  <Volume2 className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                ) : (
                  <VolumeX className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                )}
                <div>
                  <div className="flex items-center gap-1.5 font-mono-tech text-xs font-bold text-slate-100 uppercase">
                    <span>{t.soundToggleTitle}</span>
                    <InfoTip text={t.helpSound} label={t.soundToggleTitle} />
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">{t.soundToggleHint}</p>
                </div>
              </div>
              <SciFiSwitch
                checked={draft.sound_enabled}
                onChange={(v) => {
                  audioSynth.setEnabled(v);
                  if (v) audioSynth.playToggle(true);
                  setDraft((p) => ({ ...p, sound_enabled: v }));
                  onSave({ sound_enabled: v });
                }}
                label={t.soundToggleTitle}
                accent="cyan"
              />
            </div>

            {/* Auto Day/Night Time-Based High-Contrast Theme Switch */}
            <div className="rounded-xl border border-amber-500/35 bg-[#05070d] p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <div>
                    <div className="flex items-center gap-1.5 font-mono-tech text-xs font-bold text-amber-200 uppercase">
                      <span>{t.autoThemeTitle}</span>
                      <InfoTip text={t.helpAutoTheme} label={t.autoThemeTitle} />
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400">{t.autoThemeHint}</p>
                  </div>
                </div>
                <SciFiSwitch
                  checked={draft.auto_theme_by_time}
                  onChange={(v) => {
                    audioSynth.playToggle(v);
                    setDraft((p) => ({ ...p, auto_theme_by_time: v }));
                    onSave({ auto_theme_by_time: v });
                  }}
                  label={t.autoThemeTitle}
                  accent="amber"
                />
              </div>

              {draft.auto_theme_by_time && (
                <div className="mt-2 flex items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-mono-tech text-[10px] font-semibold text-amber-200">
                  {timeThemeInfo.isDay ? (
                    <Sun className="h-3.5 w-3.5 text-yellow-300" />
                  ) : (
                    <Moon className="h-3.5 w-3.5 text-sky-300" />
                  )}
                  <span>
                    {timeThemeInfo.isDay ? t.autoThemeActiveDay : t.autoThemeActiveNight}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* 7 Premium Terminal Themes (Including Deep Space & Solar Flare) */}
          <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4 lg:col-span-5">
            <div className="mb-2.5 flex items-center gap-2 font-mono-tech text-xs font-semibold text-slate-200">
              <Palette className="h-3.5 w-3.5 text-cyan-400" />
              <span>{t.themeSelectorTitle}</span>
              <InfoTip text={t.helpTheme} label={t.themeSelectorTitle} />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {themeList.map((th) => {
                const active = draft.theme === th.id && !draft.auto_theme_by_time;
                return (
                  <button
                    key={th.id}
                    type="button"
                    onClick={() => {
                      audioSynth.playClick();
                      setDraft((p) => ({
                        ...p,
                        theme: th.id as ThemeId,
                        auto_theme_by_time: false,
                      }));
                      onSave({ theme: th.id as ThemeId, auto_theme_by_time: false });
                    }}
                    className={`flex min-h-[44px] cursor-pointer flex-col items-start justify-between rounded-lg border p-2 text-left transition-all ${
                      active
                        ? 'border-white/75 bg-white/12 shadow-[0_0_16px_rgba(255,255,255,0.14)]'
                        : 'border-slate-800 bg-slate-900/50 hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center gap-1">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: th.primaryHex }}
                      />
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: th.secondaryHex }}
                      />
                    </div>
                    <span className="mt-1 w-full truncate font-mono-tech text-[10px] font-bold text-slate-100">
                      {th.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3D Core Visual Design Selector */}
          <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4 lg:col-span-3">
            <div className="mb-2.5 flex items-center gap-1.5 font-mono-tech text-xs font-semibold text-slate-200">
              <span>{t.coreVisualTitle}</span>
              <InfoTip text={t.helpQuantumCore} label={t.coreVisualTitle} />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {coreModes.map((cm) => (
                <button
                  key={cm.id}
                  type="button"
                  onClick={() => {
                    audioSynth.playClick();
                    setDraft((p) => ({ ...p, core_visual: cm.id }));
                    onSave({ core_visual: cm.id });
                  }}
                  className={`min-h-[38px] cursor-pointer rounded border px-2 font-mono-tech text-[11px] font-semibold uppercase transition-colors ${
                    draft.core_visual === cm.id
                      ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-200'
                      : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {cm.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </TerminalPanel>

      {/* Section 2: Zero-Loss Shield, Auto Dip Re-Buy (DCA) & $1+ Lot Controls */}
      <TerminalPanel accent="emerald" title={t.settingsTitle} subtitle={t.minTradeNote}>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            {/* Never-Lose / Zero-Loss Mode Highlight Card */}
            <div className="flex items-center justify-between gap-4 rounded-xl border border-emerald-500/45 bg-emerald-500/10 p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                <div>
                  <div className="flex items-center gap-1.5 font-mono-tech text-xs font-bold text-emerald-300 uppercase">
                    <span>{t.zeroLossTitle}</span>
                    <InfoTip text={t.helpZeroLoss} label={t.zeroLossTitle} />
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-300">{t.zeroLossHint}</p>
                </div>
              </div>
              <SciFiSwitch
                checked={draft.zero_loss_mode}
                onChange={(v) => {
                  audioSynth.playToggle(v);
                  setDraft((p) => ({
                    ...p,
                    zero_loss_mode: v,
                    sell_only_in_profit: v ? true : p.sell_only_in_profit,
                    stop_loss_enabled: v ? false : p.stop_loss_enabled,
                  }));
                  void onSave({
                    zero_loss_mode: v,
                    sell_only_in_profit: v,
                    stop_loss_enabled: v ? false : draft.stop_loss_enabled,
                  });
                }}
                label={t.zeroLossTitle}
                accent="emerald"
              />
            </div>

            {/* Auto Dip Re-Buy & Batch Sell (DCA — No sitting idle on one stuck trade) */}
            <div className="space-y-3 rounded-xl border border-cyan-500/40 bg-cyan-500/8 p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Layers className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
                  <div>
                    <div className="flex items-center gap-1.5 font-mono-tech text-xs font-bold text-cyan-200 uppercase">
                      <span>{t.dcaTitle}</span>
                      <InfoTip text={t.helpDca} label={t.dcaTitle} />
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-300">{t.dcaHint}</p>
                  </div>
                </div>
                <SciFiSwitch
                  checked={draft.dca_enabled}
                  onChange={(v) => setDraft((p) => ({ ...p, dca_enabled: v }))}
                  label={t.dcaTitle}
                  accent="cyan"
                />
              </div>

              {draft.dca_enabled && (
                <div className="grid grid-cols-1 gap-3 border-t border-cyan-500/20 pt-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 flex justify-between font-mono-tech text-[11px]">
                      <span className="text-slate-300">{t.dcaStepLabel}</span>
                      <span className="font-bold text-cyan-300">
                        -{draft.dca_step_pct.toFixed(1)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.5}
                      max={8}
                      step={0.2}
                      value={draft.dca_step_pct}
                      onChange={(e) =>
                        setDraft((p) => ({ ...p, dca_step_pct: Number(e.target.value) }))
                      }
                      className="w-full accent-cyan-400"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between font-mono-tech text-[11px]">
                      <span className="text-slate-300">{t.dcaMaxBuysLabel}</span>
                      <span className="font-bold text-amber-300">{draft.dca_max_buys}x</span>
                    </div>
                    <input
                      type="range"
                      min={2}
                      max={25}
                      step={1}
                      value={draft.dca_max_buys}
                      onChange={(e) =>
                        setDraft((p) => ({ ...p, dca_max_buys: Number(e.target.value) }))
                      }
                      className="w-full accent-amber-400"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Amount Per Trade ($1 Minimum + Quick Chips) */}
            <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
              <div className="mb-2 flex items-center justify-between font-mono-tech text-xs">
                <span className="flex items-center gap-1.5 text-slate-300">
                  <span>{t.amountPerTrade}</span>
                  <InfoTip text={t.helpAmountPerTrade} label={t.amountPerTrade} />
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">$</span>
                  <input
                    type="number"
                    min={1}
                    max={5000}
                    step={1}
                    value={draft.amount_per_trade}
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p,
                        amount_per_trade: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                    className="w-20 rounded border border-slate-700 bg-[#090d16] px-2 py-1 text-right font-mono-tech text-xs font-bold text-cyan-300 focus:border-cyan-400 focus:outline-none"
                  />
                </div>
              </div>
              <input
                type="range"
                min={1}
                max={1000}
                step={1}
                value={Math.min(1000, draft.amount_per_trade)}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, amount_per_trade: Number(e.target.value) }))
                }
                className="w-full accent-cyan-400"
              />
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {LOT_PRESETS.map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => {
                      audioSynth.playClick();
                      setDraft((p) => ({ ...p, amount_per_trade: amt }));
                    }}
                    className={`cursor-pointer rounded border px-2 py-1 font-mono-tech text-[11px] font-semibold transition-colors ${
                      draft.amount_per_trade === amt
                        ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                        : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    ${amt}
                  </button>
                ))}
              </div>
            </div>

            {/* Take Profit % */}
            <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
              <div className="mb-2 flex items-center justify-between font-mono-tech text-xs">
                <span className="flex items-center gap-1.5 text-slate-300">
                  <span>{t.takeProfitPct}</span>
                  <InfoTip text={t.helpTakeProfit} label={t.takeProfitPct} />
                </span>
                <span className="font-bold text-emerald-400">
                  +{draft.take_profit_pct.toFixed(1)}%
                </span>
              </div>
              <input
                type="range"
                min={0.3}
                max={12}
                step={0.1}
                value={draft.take_profit_pct}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, take_profit_pct: Number(e.target.value) }))
                }
                className="w-full accent-emerald-400"
              />
            </div>

            {/* Stop Loss ON/OFF + % */}
            <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-1.5 font-mono-tech text-xs font-semibold text-slate-200">
                    <span>{t.stopLossToggle}</span>
                    <InfoTip text={t.helpStopLoss} label={t.stopLossToggle} />
                  </div>
                  <div className="font-mono-tech text-[11px] text-rose-400">
                    {draft.zero_loss_mode
                      ? 'DISABLED BY ZERO-LOSS SHIELD'
                      : `-${draft.stop_loss_pct.toFixed(1)}%`}
                  </div>
                </div>
                <SciFiSwitch
                  checked={!draft.zero_loss_mode && draft.stop_loss_enabled}
                  disabled={draft.zero_loss_mode}
                  onChange={(v) => setDraft((p) => ({ ...p, stop_loss_enabled: v }))}
                  label={t.stopLossToggle}
                  accent="rose"
                />
              </div>
              {!draft.zero_loss_mode && draft.stop_loss_enabled && (
                <div className="mt-3">
                  <input
                    type="range"
                    min={0.5}
                    max={10}
                    step={0.1}
                    value={draft.stop_loss_pct}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, stop_loss_pct: Number(e.target.value) }))
                    }
                    className="w-full accent-rose-400"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            {/* Workspace Selector (Virtual vs Live Isolated Pages) */}
            <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
              <div className="mb-2.5 flex items-center gap-1.5 font-mono-tech text-xs font-semibold text-slate-300">
                <span>{t.tradingMode}</span>
                <InfoTip text={t.helpWorkspace} label={t.tradingMode} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onRequestWorkspaceSwitch('DEMO')}
                  className={`min-h-[44px] cursor-pointer rounded-lg border font-mono-tech text-xs font-bold tracking-wider uppercase transition-all ${
                    workspace === 'DEMO'
                      ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200 shadow-[0_0_16px_rgba(34,211,238,0.3)]'
                      : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.modeDemo}
                </button>
                <button
                  type="button"
                  onClick={() => onRequestWorkspaceSwitch('LIVE')}
                  className={`min-h-[44px] cursor-pointer rounded-lg border font-mono-tech text-xs font-bold tracking-wider uppercase transition-all ${
                    workspace === 'LIVE'
                      ? 'border-rose-500 bg-rose-500/25 text-rose-200 shadow-[0_0_18px_rgba(244,63,94,0.4)]'
                      : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:border-rose-500/40 hover:text-rose-300'
                  }`}
                >
                  {t.modeLive}
                </button>
              </div>
            </div>

            {/* Max Open Trades & Max Per Pair */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
                <div className="mb-2 flex items-center justify-between font-mono-tech text-xs">
                  <span className="flex items-center gap-1.5 text-slate-300">
                    <span>{t.maxOpenTrades}</span>
                    <InfoTip text={t.helpMaxOpen} label={t.maxOpenTrades} />
                  </span>
                  <span className="font-bold text-cyan-300">{draft.max_open_trades}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={15}
                  step={1}
                  value={draft.max_open_trades}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, max_open_trades: Number(e.target.value) }))
                  }
                  className="w-full accent-cyan-400"
                />
              </div>

              <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
                <div className="mb-2 flex items-center justify-between font-mono-tech text-xs">
                  <span className="text-slate-300">{t.maxAmountPerPair}</span>
                  <span className="font-bold text-amber-300">${draft.max_amount_per_pair}</span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={5000}
                  step={5}
                  value={draft.max_amount_per_pair}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, max_amount_per_pair: Number(e.target.value) }))
                  }
                  className="w-full accent-amber-400"
                />
              </div>
            </div>

            {/* Daily Loss Limit */}
            <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
              <div className="mb-2 flex items-center justify-between font-mono-tech text-xs">
                <span className="flex items-center gap-1.5 text-slate-300">
                  <span>{t.dailyLossLimit}</span>
                  <InfoTip text={t.helpDailyLimit} label={t.dailyLossLimit} />
                </span>
                <span className="font-bold text-rose-400">${draft.daily_loss_limit}</span>
              </div>
              <input
                type="range"
                min={1}
                max={1500}
                step={5}
                value={draft.daily_loss_limit}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, daily_loss_limit: Number(e.target.value) }))
                }
                className="w-full accent-rose-400"
              />
            </div>

            {/* Enabled Pairs */}
            <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
              <div className="mb-3 flex items-center justify-between font-mono-tech text-xs">
                <span className="font-semibold text-slate-200">{t.enabledPairsTitle}</span>
                <span className="text-cyan-300">{draft.enabled_pairs.length}/10</span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {SUPPORTED_PAIRS.map((symbol) => {
                  const active = draft.enabled_pairs.includes(symbol);
                  return (
                    <button
                      key={symbol}
                      type="button"
                      onClick={() => toggleDraftPair(symbol)}
                      className={`min-h-[40px] cursor-pointer rounded-lg border px-2 font-mono-tech text-xs font-semibold transition-all ${
                        active
                          ? 'border-emerald-400/70 bg-emerald-500/15 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.2)]'
                          : 'border-slate-800 bg-slate-900/50 text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {symbol.replace('USDT', '')}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </TerminalPanel>

      {/* Section 3: Telegram & Binance API Credentials Gateway */}
      <TerminalPanel
        accent="amber"
        title={t.binanceSectionTitle}
        rightSlot={
          <button
            type="button"
            onClick={() => setShowSecrets((v) => !v)}
            className="flex min-h-[34px] cursor-pointer items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1 font-mono-tech text-[11px] text-slate-300 hover:border-cyan-400/60"
          >
            {showSecrets ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            <span>{showSecrets ? 'HIDE' : 'SHOW'}</span>
          </button>
        }
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* Telegram Bot Integration */}
          <div className="space-y-3 rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono-tech text-xs font-bold text-cyan-300">
                <Send className="h-4 w-4" />
                <span>{t.telegramAlerts}</span>
                <InfoTip text={t.helpTelegram} label={t.telegramAlerts} />
              </div>
              <SciFiSwitch
                checked={draft.telegram_enabled}
                onChange={(v) => setDraft((p) => ({ ...p, telegram_enabled: v }))}
                label={t.telegramAlerts}
                accent="cyan"
              />
            </div>

            <div>
              <label className="mb-1 block font-mono-tech text-[11px] text-slate-400">
                {t.telegramTokenLabel}
              </label>
              <input
                type={showSecrets ? 'text' : 'password'}
                value={tgDraft.bot_token}
                onChange={(e) => setTgDraft((p) => ({ ...p, bot_token: e.target.value }))}
                placeholder="123456789:AAH..."
                className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-cyan-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block font-mono-tech text-[11px] text-slate-400">
                {t.telegramChatIdLabel}
              </label>
              <input
                type="text"
                value={tgDraft.chat_id}
                onChange={(e) => setTgDraft((p) => ({ ...p, chat_id: e.target.value }))}
                placeholder="-1001234567890"
                className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-cyan-400 focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <NeonButton
                type="button"
                variant="cyan"
                disabled={testingTg}
                onClick={handleTestTg}
                className="min-h-[36px] px-3 py-1 text-[11px]"
              >
                <Send className="h-3.5 w-3.5" />
                {testingTg ? 'DISPATCHING...' : t.testTelegramBtn}
              </NeonButton>

              {tgFeedback && (
                <span
                  className={`font-mono-tech text-[11px] ${
                    tgFeedback.ok ? 'text-emerald-400' : 'text-amber-300'
                  }`}
                >
                  {tgFeedback.text}
                </span>
              )}
            </div>
          </div>

          {/* Binance API Key & Secret */}
          <div className="space-y-3 rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono-tech text-xs font-bold text-amber-300">
                <KeyRound className="h-4 w-4" />
                <span>BINANCE SPOT API</span>
                <InfoTip text={t.helpBinance} label="BINANCE SPOT API" />
              </div>
              <button
                type="button"
                onClick={() => setBnDraft((p) => ({ ...p, use_testnet: !p.use_testnet }))}
                className={`cursor-pointer rounded border px-2 py-0.5 font-mono-tech text-[10px] font-semibold uppercase ${
                  bnDraft.use_testnet
                    ? 'border-amber-400/60 bg-amber-500/15 text-amber-300'
                    : 'border-emerald-400/60 bg-emerald-500/15 text-emerald-300'
                }`}
              >
                {bnDraft.use_testnet ? 'TESTNET' : 'SPOT MAINNET'}
              </button>
            </div>

            <div>
              <label className="mb-1 block font-mono-tech text-[11px] text-slate-400">
                {t.binanceKeyLabel}
              </label>
              <input
                type={showSecrets ? 'text' : 'password'}
                value={bnDraft.api_key}
                onChange={(e) =>
                  setBnDraft((p) => ({ ...p, api_key: e.target.value, verified: false }))
                }
                placeholder="Binance Spot API Key..."
                className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-amber-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block font-mono-tech text-[11px] text-slate-400">
                {t.binanceSecretLabel}
              </label>
              <input
                type={showSecrets ? 'text' : 'password'}
                value={bnDraft.api_secret}
                onChange={(e) =>
                  setBnDraft((p) => ({ ...p, api_secret: e.target.value, verified: false }))
                }
                placeholder="Binance Spot API Secret..."
                className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-amber-400 focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <NeonButton
                type="button"
                variant="amber"
                onClick={handleVerifyBn}
                className="min-h-[36px] px-3 py-1 text-[11px]"
              >
                {t.verifyBinanceBtn}
              </NeonButton>

              {bnFeedback && (
                <span
                  className={`font-mono-tech text-[11px] ${
                    bnFeedback.ok ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {bnFeedback.text}
                </span>
              )}
            </div>
          </div>
        </div>
      </TerminalPanel>

      {/* Section 4: GitHub -> Vercel, Render, Supabase SQL & Keys Blueprint */}
      <TerminalPanel
        accent="cyan"
        title={t.deployGuideTitle}
        subtitle={t.deployGuideSub}
        rightSlot={
          <div className="flex items-center gap-2">
            <NeonButton
              type="button"
              variant={copiedSql ? 'emerald' : 'cyan'}
              onClick={handleCopySql}
              className="min-h-[34px] px-3 py-1 text-[11px]"
            >
              {copiedSql ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedSql ? t.copiedBtn : t.copySqlBtn}
            </NeonButton>
            <button
              type="button"
              onClick={() => setShowGuideSql((v) => !v)}
              className="min-h-[34px] cursor-pointer rounded border border-slate-700 px-2.5 py-1 font-mono-tech text-[11px] text-slate-300 hover:border-cyan-400"
            >
              {showGuideSql ? 'HIDE SQL' : 'VIEW SQL'}
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 font-mono-tech text-[11px]">
          <div className="rounded-xl border border-slate-800 bg-[#05070d] p-3">
            <div className="mb-1 flex items-center gap-1.5 font-bold text-cyan-300 uppercase">
              <Database className="h-3.5 w-3.5" />
              <span>1. Supabase SQL</span>
            </div>
            <p className="text-slate-300 leading-relaxed">
              Supabase &gt; SQL Editor-এ উপরের Copy SQL Schema বাটনে ক্লিক করে কোড Run করুন। এতে settings, trades, logs টেবিল ও Realtime তৈরি হবে।
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#05070d] p-3">
            <div className="mb-1 font-bold text-emerald-300 uppercase">2. Vercel (Frontend)</div>
            <p className="text-slate-300 leading-relaxed">
              GitHub push করে Vercel-এ Import করুন। Environment Variables-এ শুধু বসান:
              <br />
              <code className="text-amber-300">VITE_SUPABASE_URL</code>
              <br />
              <code className="text-amber-300">VITE_SUPABASE_ANON_KEY</code>
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#05070d] p-3">
            <div className="mb-1 font-bold text-amber-300 uppercase">3. Render (24/7 Bot Worker)</div>
            <p className="text-slate-300 leading-relaxed">
              Render Background Worker-এ বসান: <code className="text-cyan-300">SUPABASE_URL</code>,{' '}
              <code className="text-cyan-300">SUPABASE_SERVICE_ROLE_KEY</code>,{' '}
              <code className="text-cyan-300">BINANCE_API_KEY</code>,{' '}
              <code className="text-cyan-300">BINANCE_API_SECRET</code>,{' '}
              <code className="text-cyan-300">TELEGRAM_BOT_TOKEN</code>,{' '}
              <code className="text-cyan-300">TELEGRAM_CHAT_ID</code>।
            </p>
          </div>
        </div>

        {showGuideSql && (
          <pre className="mt-3 max-h-64 overflow-auto rounded-xl border border-slate-800 bg-[#03050a] p-3 font-mono-tech text-[10px] leading-relaxed text-emerald-300">
            {SUPABASE_SQL_SCHEMA}
          </pre>
        )}
      </TerminalPanel>
    </div>
  );
};
