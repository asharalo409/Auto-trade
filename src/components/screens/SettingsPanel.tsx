import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  Check,
  Clock,
  Copy,
  Database,
  DollarSign,
  Eye,
  EyeOff,
  Image as ImageIcon,
  KeyRound,
  Layers,
  Moon,
  Palette,
  Save,
  Send,
  Server,
  ShieldCheck,
  Sun,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { BDT_PER_USD, SUPABASE_SQL_SCHEMA, SUPPORTED_PAIRS } from '../../data/demoData';
import { audioSynth } from '../../lib/audioSynth';
import { avatarInitials, fileToAvatarDataUrl } from '../../lib/avatar';
import { getTimeBasedTheme, TERMINAL_THEMES } from '../../lib/themes';
import {
  AccountProfile,
  BackgroundPresetId,
  BinanceAccountSummary,
  BinanceConfig,
  BotSettings,
  CoreVisualMode,
  TelegramConfig,
  ThemeId,
  TradingMode,
  UserApiKeyStatus,
  WorkspaceUser,
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
  binanceAccount: BinanceAccountSummary | null;
  syncingBalance: boolean;
  bgPredator: BackgroundPresetId;
  onChangeBgPredator: (bg: BackgroundPresetId) => void;
  onSave: (patch: Partial<BotSettings>) => Promise<void>;
  onRequestWorkspaceSwitch: (mode: TradingMode) => void;
  onSaveTelegram: (cfg: TelegramConfig) => void;
  onTestTelegram: (cfg: TelegramConfig) => Promise<{ ok: boolean; detail: string }>;
  onSendBalanceTelegram: (
    cfg: TelegramConfig,
    bnCfg?: BinanceConfig
  ) => Promise<{ ok: boolean; detail: string }>;
  onSaveBinance: (cfg: BinanceConfig) => void;
  onVerifyBinance: (cfg: BinanceConfig) => Promise<{ ok: boolean; detail: string }>;
  workspaceUser: WorkspaceUser;
  account: AccountProfile | null;
  onUpdateProfile: (patch: {
    full_name?: string;
    avatar_url?: string | null;
  }) => Promise<{ ok: boolean; detail: string }>;
  apiKeyStatus: UserApiKeyStatus;
  onSaveUserBinanceKeys: (cfg: BinanceConfig) => Promise<{ ok: boolean; detail: string }>;
  onSaveAndVerifyKeys: (cfg: BinanceConfig) => Promise<{ ok: boolean; detail: string }>;
  onTestUserBinance: () => Promise<{ ok: boolean; detail: string }>;
  isGuest: boolean;
  onRequireAccount: () => void;
  onChangePassword: (
    currentPassword: string,
    newPassword: string
  ) => Promise<{ ok: boolean; detail: string }>;
  voiceEnabled: boolean;
  onToggleVoice: (enabled: boolean) => void;
  onTestVoice: () => void;
  onSpeakBalance: () => void;
}

const LOT_PRESETS = [1, 5, 10, 25, 50, 100, 250];

/** The 24/7 Render worker publishes its egress IP for Binance whitelisting. */
const WORKER_URL =
  (import.meta.env.VITE_WORKER_URL as string | undefined) ||
  'https://aegis-quant-worker-eu.onrender.com';
const FALLBACK_SERVER_IP = '74.220.51.139';

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  t,
  workspace,
  settings,
  saving,
  telegramConfig,
  binanceConfig,
  binanceAccount,
  syncingBalance,
  bgPredator,
  onChangeBgPredator,
  onSave,
  onRequestWorkspaceSwitch,
  onSaveTelegram,
  onTestTelegram,
  onSendBalanceTelegram,
  onSaveBinance,
  onVerifyBinance,
  workspaceUser,
  account,
  onUpdateProfile,
  apiKeyStatus,
  onSaveUserBinanceKeys,
  onSaveAndVerifyKeys,
  onTestUserBinance,
  isGuest,
  onRequireAccount,
  onChangePassword,
  voiceEnabled,
  onToggleVoice,
  onTestVoice,
  onSpeakBalance,
}) => {
  const [draft, setDraft] = useState<BotSettings>(settings);
  const [tgDraft, setTgDraft] = useState<TelegramConfig>(telegramConfig);
  const [bnDraft, setBnDraft] = useState<BinanceConfig>(binanceConfig);
  const [showSecrets, setShowSecrets] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [keysSavedToast, setKeysSavedToast] = useState(false);
  const [tgFeedback, setTgFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [bnFeedback, setBnFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [vaultFeedback, setVaultFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [profileName, setProfileName] = useState(account?.full_name ?? '');
  const [profileAvatar, setProfileAvatar] = useState(account?.avatar_url ?? '');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const profileFileRef = useRef<HTMLInputElement | null>(null);
  const [savingVault, setSavingVault] = useState(false);
  const [testingVault, setTestingVault] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwFeedback, setPwFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [testingTg, setTestingTg] = useState(false);
  const [sendingBalTg, setSendingBalTg] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);
  const [showGuideSql, setShowGuideSql] = useState(false);
  const [muted, setMuted] = useState(() => audioSynth.isMuted());
  const [serverIp, setServerIp] = useState(FALLBACK_SERVER_IP);
  const [copiedIp, setCopiedIp] = useState(false);

  // Ask the worker for its real public IP; the documented address is the fallback.
  useEffect(() => {
    let active = true;
    const loadServerIp = async () => {
      try {
        const res = await fetch(`${WORKER_URL}/api/server-ip`);
        const data = (await res.json().catch(() => null)) as { ip?: string | null } | null;
        const ip = String(data?.ip || '').trim();
        if (active && /^[0-9a-fA-F.:]+$/.test(ip)) setServerIp(ip);
      } catch {
        /* keep the documented fallback */
      }
    };
    void loadServerIp();
    return () => {
      active = false;
    };
  }, []);

  const handleCopyServerIp = async () => {
    audioSynth.playClick();
    try {
      await navigator.clipboard.writeText(serverIp);
    } catch {
      const el = document.createElement('textarea');
      el.value = serverIp;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopiedIp(true);
    window.setTimeout(() => setCopiedIp(false), 1800);
  };

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

  useEffect(() => {
    setProfileName(account?.full_name ?? '');
    setProfileAvatar(account?.avatar_url ?? '');
  }, [account?.id, account?.full_name, account?.avatar_url]);

  const handleProfilePhoto = async (file: File | null) => {
    if (!file) return;
    setProfileFeedback(null);
    try {
      setProfileAvatar(await fileToAvatarDataUrl(file));
    } catch (err) {
      setProfileFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Could not process that image',
      });
    }
  };

  const handleSaveProfile = async () => {
    audioSynth.playClick();
    setProfileSaving(true);
    setProfileFeedback(null);
    const res = await onUpdateProfile({
      full_name: profileName,
      avatar_url: profileAvatar || null,
    });
    setProfileSaving(false);
    setProfileFeedback({ ok: res.ok, text: res.detail });
  };

  const handleSave = async () => {
    onSaveTelegram(tgDraft);
    onSaveBinance(bnDraft);
    await onSave({
      amount_per_trade: Math.max(minLot, draft.amount_per_trade),
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
      trailing_stop_pct: draft.trailing_stop_pct ?? 1.5,
      daily_max_loss_pct: draft.daily_max_loss_pct ?? 5,
      voice_language: draft.voice_language ?? 'en',
      auto_compounding: draft.auto_compounding ?? false,
      compound_allocation_pct: draft.compound_allocation_pct ?? 5,
      multi_timeframe_filter: draft.multi_timeframe_filter ?? true,
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
    onSaveTelegram(tgDraft);
    const res = await onTestTelegram(tgDraft);
    setTestingTg(false);
    setTgFeedback({ ok: res.ok, text: res.detail });
  };

  const handleSendBalTg = async () => {
    setSendingBalTg(true);
    setTgFeedback(null);
    onSaveTelegram(tgDraft);
    onSaveBinance(bnDraft);
    const res = await onSendBalanceTelegram(tgDraft, bnDraft);
    setSendingBalTg(false);
    setTgFeedback({ ok: res.ok, text: res.detail });
  };

  const handleSendBalFromBinancePanel = async () => {
    audioSynth.playClick();
    if (isGuest) {
      onRequireAccount();
      return;
    }
    setSendingBalTg(true);
    setBnFeedback(null);
    onSaveTelegram(tgDraft);
    onSaveBinance(bnDraft);
    const res = await onSendBalanceTelegram(tgDraft, bnDraft);
    setSendingBalTg(false);
    setBnFeedback({ ok: res.ok, text: res.detail });
  };

  const handleSaveGatewayKeys = async () => {
    audioSynth.playClick();
    onSaveTelegram(tgDraft);
    onSaveBinance(bnDraft);
    await onSave({ telegram_enabled: draft.telegram_enabled });
    setKeysSavedToast(true);
    window.setTimeout(() => setKeysSavedToast(false), 2200);
  };

  const handleVerifyBn = async () => {
    if (isGuest) {
      onRequireAccount();
      return;
    }
    audioSynth.playClick();
    onSaveBinance(bnDraft);
    setSavingVault(true);
    setVaultFeedback(null);
    const res = await onVerifyBinance(bnDraft);
    setSavingVault(false);
    setVaultFeedback({ ok: res.ok, text: res.detail });
  };

  /** Save both keys, then immediately verify + load the real portfolio in place. */
  const handleSaveVault = async () => {
    audioSynth.playClick();
    if (isGuest) {
      onRequireAccount();
      return;
    }
    onSaveBinance(bnDraft);
    setSavingVault(true);
    setVaultFeedback(null);
    const res = await onSaveAndVerifyKeys(bnDraft);
    setSavingVault(false);
    setVaultFeedback({ ok: res.ok, text: res.detail });
  };

  const handleTestVault = async () => {
    audioSynth.playClick();
    if (isGuest) {
      onRequireAccount();
      return;
    }
    setTestingVault(true);
    setVaultFeedback(null);
    const res = await onTestUserBinance();
    setTestingVault(false);
    setVaultFeedback({ ok: res.ok, text: res.detail });
  };

  const handleChangePassword = async () => {
    audioSynth.playClick();
    setPwFeedback(null);
    if (!pwCurrent || !pwNext) {
      setPwFeedback({ ok: false, text: 'Enter your current and new password.' });
      return;
    }
    if (pwNext.length < 8) {
      setPwFeedback({ ok: false, text: 'New password must be at least 8 characters.' });
      return;
    }
    if (pwNext !== pwConfirm) {
      setPwFeedback({ ok: false, text: 'The two new passwords do not match.' });
      return;
    }
    setPwBusy(true);
    const res = await onChangePassword(pwCurrent, pwNext);
    setPwBusy(false);
    setPwFeedback({ ok: res.ok, text: res.detail });
    if (res.ok) {
      setPwCurrent('');
      setPwNext('');
      setPwConfirm('');
    }
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
  // Mute is the master gate, but the Sound FX preference can also silence audio.
  // Keep the badge honest about the effective state so the two switches never disagree.
  const audioSilent = muted || !draft.sound_enabled;
  // The portfolio total includes coins and Funding/Earn; only Spot USDT can be spent.
  const tradeableUsdt = binanceAccount?.usdtFree ?? 0;
  const canFundOrders = Boolean(binanceAccount?.canTrade);
  // Binance Spot rejects any order below $5 MIN_NOTIONAL, so LIVE has a real floor.
  const minLot = workspace === 'LIVE' ? 5.5 : 1;
  const lotPresets = LOT_PRESETS.filter((amt) => amt >= minLot);

  return (
    <div className="space-y-4">
      {/* Section 0: My Profile — full name + circular photo (used on cards & board) */}
      {account && (
        <TerminalPanel
          accent="emerald"
          title="MY PROFILE"
          subtitle="Shown on your PnL cards, the header and the traders leaderboard"
          rightSlot={
            <NeonButton
              type="button"
              variant={profileFeedback?.ok ? 'emerald' : 'cyan'}
              onClick={() => void handleSaveProfile()}
              disabled={profileSaving}
              className="min-h-[34px] px-3 py-1 text-[11px]"
            >
              {profileFeedback?.ok ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
              {profileSaving ? 'SAVING...' : profileFeedback?.ok ? 'SAVED' : 'SAVE PROFILE'}
            </NeonButton>
          }
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => profileFileRef.current?.click()}
                className="group relative h-20 w-20 shrink-0 cursor-pointer overflow-hidden rounded-full border border-emerald-400/45 bg-[#05070d]"
                aria-label="Change profile photo"
              >
                {profileAvatar ? (
                  <img
                    src={profileAvatar}
                    alt={profileName || 'Profile photo'}
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-emerald-300 to-teal-700 font-display text-xl font-black text-[#04120c]">
                    {avatarInitials(profileName || account.email)}
                  </span>
                )}
                <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                  <Camera className="h-6 w-6 text-emerald-200" />
                </span>
              </button>
              <div>
                <button
                  type="button"
                  onClick={() => profileFileRef.current?.click()}
                  className="flex items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1 font-mono-tech text-[10px] text-slate-200 hover:border-emerald-400/60 hover:text-emerald-300"
                >
                  <Camera className="h-3.5 w-3.5" />
                  {profileAvatar ? 'CHANGE PHOTO' : 'UPLOAD PHOTO'}
                </button>
                <p className="mt-1 max-w-[170px] font-mono-tech text-[9px] leading-relaxed text-slate-500">
                  Auto-resized to 160×160. JPG, PNG or WebP.
                </p>
              </div>
              <input
                ref={profileFileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  void handleProfilePhoto(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
            </div>

            <div className="flex-1 space-y-2">
              <div>
                <label
                  htmlFor="profile-full-name"
                  className="mb-1 block font-mono-tech text-[10px] tracking-wider text-slate-400 uppercase"
                >
                  Full Name
                </label>
                <input
                  id="profile-full-name"
                  type="text"
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                  placeholder="Your full name"
                  className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-emerald-400 focus:outline-none"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 font-mono-tech text-[10px] text-slate-500">
                <span className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-300">
                  {account.email}
                </span>
                <span
                  className={`rounded border px-1.5 py-0.5 font-bold uppercase ${
                    account.approval_status === 'approved'
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                  }`}
                >
                  {account.approval_status}
                </span>
                {account.telegram_chat_id && (
                  <span className="rounded border border-slate-700 px-1.5 py-0.5">
                    TG {account.telegram_chat_id}
                  </span>
                )}
              </div>
            </div>
          </div>

          {profileFeedback && (
            <div
              className={`mt-3 rounded-lg border px-2.5 py-1.5 font-mono-tech text-[11px] ${
                profileFeedback.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              }`}
            >
              {profileFeedback.text}
            </div>
          )}
        </TerminalPanel>
      )}

      {/* Account Security: self-service password change (Supabase Auth owns the hash) */}
      {account && (
        <TerminalPanel
          accent="crimson"
          title="ACCOUNT SECURITY"
          subtitle="Change the password you sign in with"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <label
                htmlFor="pw-current"
                className="mb-1 block font-mono-tech text-[10px] tracking-wider text-slate-400 uppercase"
              >
                Current Password
              </label>
              <input
                id="pw-current"
                type="password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                autoComplete="current-password"
                placeholder="••••••••"
                className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-rose-400 focus:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor="pw-new"
                className="mb-1 block font-mono-tech text-[10px] tracking-wider text-slate-400 uppercase"
              >
                New Password
              </label>
              <input
                id="pw-new"
                type="password"
                value={pwNext}
                onChange={(e) => setPwNext(e.target.value)}
                autoComplete="new-password"
                placeholder="Min. 8 characters"
                className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-rose-400 focus:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor="pw-confirm"
                className="mb-1 block font-mono-tech text-[10px] tracking-wider text-slate-400 uppercase"
              >
                Confirm New Password
              </label>
              <input
                id="pw-confirm"
                type="password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                autoComplete="new-password"
                placeholder="Repeat new password"
                className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-rose-400 focus:outline-none"
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <NeonButton
              type="button"
              variant="rose"
              disabled={pwBusy}
              onClick={() => void handleChangePassword()}
              className="min-h-[36px] px-3 py-1 text-[11px]"
            >
              <KeyRound className="h-3.5 w-3.5" />
              {pwBusy ? 'UPDATING PASSWORD...' : 'CHANGE PASSWORD'}
            </NeonButton>
          </div>

          <p className="mt-2 font-mono-tech text-[10px] leading-relaxed text-slate-500">
            The current password is verified first; the new one is hashed and stored by Supabase
            Auth against your account row. Forgot it instead? Use Forgot Password? on the sign-in
            screen — @TaseenMarketBot DMs a 6-digit reset code.
          </p>

          {pwFeedback && (
            <div
              className={`mt-3 rounded-lg border px-2.5 py-1.5 font-mono-tech text-[11px] ${
                pwFeedback.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              }`}
            >
              {pwFeedback.text}
            </div>
          )}
        </TerminalPanel>
      )}

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
            <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-3.5 space-y-2.5">
              <div className="flex items-center justify-between gap-3">
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
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={audioSilent}
                  title={audioSilent ? t.muteSoundTitle : t.testSoundBtn}
                  onClick={() => {
                    audioSynth.setEnabled(true);
                    audioSynth.playTradeChime(true);
                    audioSynth.setEnabled(draft.sound_enabled);
                  }}
                  className="cursor-pointer rounded border border-cyan-500/35 bg-cyan-500/10 px-2.5 py-1 font-mono-tech text-[10px] font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ♪ {t.testSoundBtn}
                </button>
              </div>
            </div>

            {/* Global Mute Sound (persisted in localStorage, silences every audioSynth effect) */}
            <div className="rounded-xl border border-rose-500/30 bg-[#05070d] p-3.5 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <VolumeX
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      muted ? 'text-rose-300' : 'text-slate-500'
                    }`}
                  />
                  <div>
                    <div className="flex items-center gap-1.5 font-mono-tech text-xs font-bold text-slate-100 uppercase">
                      <span>{t.muteSoundTitle}</span>
                      <InfoTip text={t.muteSoundHint} label={t.muteSoundTitle} />
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400">{t.muteSoundHint}</p>
                  </div>
                </div>
                <SciFiSwitch
                  checked={muted}
                  onChange={(v) => {
                    audioSynth.setMuted(v);
                    setMuted(v);
                    if (!v) audioSynth.playToggle(true);
                  }}
                  label={t.muteSoundTitle}
                  accent="rose"
                />
              </div>
              <div className="flex justify-end">
                <span
                  className={`rounded border px-2 py-0.5 font-mono-tech text-[10px] font-semibold ${
                    audioSilent
                      ? 'border-rose-500/45 bg-rose-500/10 text-rose-200'
                      : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  }`}
                >
                  {audioSilent ? t.soundMutedBadge : t.soundOnBadge}
                </span>
              </div>
            </div>

            {/* Built-in Browser Voice & SFX Announcer (Web Audio + speechSynthesis) */}
            <div className="rounded-xl border border-cyan-500/35 bg-[#05070d] p-3.5 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  {voiceEnabled ? (
                    <Volume2 className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                  ) : (
                    <VolumeX className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                  )}
                  <div>
                    <div className="flex items-center gap-1.5 font-mono-tech text-xs font-bold text-slate-100 uppercase">
                      <span>{t.voiceSfxTitle}</span>
                      <InfoTip text={t.voiceSfxHint} label={t.voiceSfxTitle} />
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400">{t.voiceSfxHint}</p>
                  </div>
                </div>
                <SciFiSwitch
                  checked={voiceEnabled}
                  onChange={(v) => {
                    audioSynth.playToggle(v);
                    onToggleVoice(v);
                  }}
                  label={t.voiceSfxTitle}
                  accent="cyan"
                />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <div className="mr-auto flex items-center gap-1 rounded-lg border border-slate-700/70 bg-[#090d16] p-0.5">
                  {(
                    [
                      ['en', 'English'],
                      ['bn_en', 'বাংলা + English'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        audioSynth.playClick();
                        setDraft((p) => ({ ...p, voice_language: value }));
                        void onSave({ voice_language: value });
                      }}
                      className={`min-h-[30px] cursor-pointer rounded px-2 font-mono-tech text-[10px] font-semibold transition-colors ${
                        (draft.voice_language ?? 'en') === value
                          ? 'bg-cyan-500/25 text-cyan-200'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    audioSynth.playClick();
                    onTestVoice();
                  }}
                  className="cursor-pointer rounded border border-cyan-500/35 bg-cyan-500/10 px-2.5 py-1 font-mono-tech text-[10px] font-semibold text-cyan-200 hover:bg-cyan-500/20"
                >
                  🔊 {t.testVoiceBtn}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    audioSynth.playClick();
                    onSpeakBalance();
                  }}
                  className="cursor-pointer rounded border border-slate-600/60 bg-slate-800/40 px-2.5 py-1 font-mono-tech text-[10px] font-semibold text-slate-200 hover:bg-slate-700/40"
                >
                  🗣️ {t.speakBalanceBtn}
                </button>
              </div>
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

        {/* Predator Red-Eye Background Selector */}
        <div className="mt-4 rounded-xl border border-rose-500/30 bg-[#05070d]/85 p-4">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-mono-tech text-xs font-bold text-rose-300 uppercase">
              <ImageIcon className="h-4 w-4 text-rose-400" />
              <span>{t.bgPredatorTitle}</span>
            </div>
            <span className="font-mono-tech text-[11px] text-slate-400">{t.bgPredatorHint}</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {(
              [
                {
                  id: 'tiger' as BackgroundPresetId,
                  label: t.bgTiger,
                  thumb: '/src/assets/images/predator_tiger_red_eyes_1795118033481.jpg',
                },
                {
                  id: 'lion' as BackgroundPresetId,
                  label: t.bgLion,
                  thumb: '/src/assets/images/predator_lion_red_eyes_1795118034764.jpg',
                },
                {
                  id: 'eagle' as BackgroundPresetId,
                  label: t.bgEagle,
                  thumb: '/src/assets/images/predator_eagle_red_eyes_1795118034989.jpg',
                },
                {
                  id: 'none' as BackgroundPresetId,
                  label: t.bgNone,
                  thumb: null,
                },
              ]
            ).map((bg) => {
              const active = bgPredator === bg.id;
              return (
                <button
                  key={bg.id}
                  type="button"
                  onClick={() => {
                    audioSynth.playClick();
                    onChangeBgPredator(bg.id);
                  }}
                  className={`group relative flex min-h-[68px] cursor-pointer items-end overflow-hidden rounded-lg border p-2 text-left transition-all ${
                    active
                      ? 'border-rose-400 shadow-[0_0_16px_rgba(244,63,94,0.4)]'
                      : 'border-slate-800 hover:border-slate-600'
                  }`}
                >
                  {bg.thumb ? (
                    <img
                      src={bg.thumb}
                      alt={bg.label}
                      referrerPolicy="no-referrer"
                      className="absolute inset-0 h-full w-full object-cover opacity-70 transition-transform duration-300 group-hover:scale-105"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-[#05060a]" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
                  <span className="relative z-10 font-mono-tech text-[10px] font-bold text-slate-100">
                    {bg.label}
                  </span>
                </button>
              );
            })}
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
                    min={minLot}
                    max={5000}
                    step={1}
                    value={draft.amount_per_trade}
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p,
                        amount_per_trade: Math.max(minLot, Number(e.target.value) || minLot),
                      }))
                    }
                    className="w-20 rounded border border-slate-700 bg-[#090d16] px-2 py-1 text-right font-mono-tech text-xs font-bold text-cyan-300 focus:border-cyan-400 focus:outline-none"
                  />
                </div>
              </div>
              <input
                type="range"
                min={minLot}
                max={1000}
                step={1}
                value={Math.min(1000, Math.max(minLot, draft.amount_per_trade))}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, amount_per_trade: Number(e.target.value) }))
                }
                className="w-full accent-cyan-400"
              />
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {lotPresets.map((amt) => (
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
              <p
                className={`mt-2 font-mono-tech text-[10px] leading-relaxed ${
                  workspace === 'LIVE' ? 'text-amber-300/90' : 'text-slate-500'
                }`}
              >
                {t.liveLotMinHint}
              </p>
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

            {/* Trailing Stop-Loss & Daily Max Loss Guard (enforced by the 24/7 worker) */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
                <div className="mb-2 flex items-center justify-between font-mono-tech text-xs">
                  <span className="flex items-center gap-1.5 text-slate-300">
                    <span>Trailing Stop</span>
                    <InfoTip
                      text="Closes an open position once price retraces this % from its highest watermark, locking in profit."
                      label="Trailing Stop"
                    />
                  </span>
                  <span className="font-bold text-emerald-300">
                    {(draft.trailing_stop_pct ?? 1.5).toFixed(1)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={8}
                  step={0.1}
                  value={draft.trailing_stop_pct ?? 1.5}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, trailing_stop_pct: Number(e.target.value) }))
                  }
                  aria-label="Trailing stop percentage"
                  className="w-full accent-emerald-400"
                />
                <p className="mt-1 font-mono-tech text-[10px] text-slate-500">
                  Peak-price trailing exit · 0% disables it
                </p>
              </div>

              <div className="rounded-xl border border-slate-800/80 bg-[#05070d] p-4">
                <div className="mb-2 flex items-center justify-between font-mono-tech text-xs">
                  <span className="flex items-center gap-1.5 text-slate-300">
                    <span>Daily Max Loss</span>
                    <InfoTip
                      text="Pauses new entries for the rest of the Asia/Dhaka day once realized losses reach this % of the day's opening equity."
                      label="Daily Max Loss"
                    />
                  </span>
                  <span className="font-bold text-rose-400">
                    {(draft.daily_max_loss_pct ?? 5).toFixed(1)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={25}
                  step={0.5}
                  value={draft.daily_max_loss_pct ?? 5}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, daily_max_loss_pct: Number(e.target.value) }))
                  }
                  aria-label="Daily maximum loss percentage"
                  className="w-full accent-rose-400"
                />
                <p className="mt-1 font-mono-tech text-[10px] text-slate-500">
                  Resets at 00:00 Asia/Dhaka · 0% disables it
                </p>
              </div>
            </div>

            {/* Smart Auto-Compounding + Multi-Timeframe Confirmation (worker-enforced) */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-amber-500/35 bg-amber-500/8 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <DollarSign className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                    <div>
                      <div className="flex items-center gap-1.5 font-mono-tech text-xs font-bold text-amber-200 uppercase">
                        <span>Auto-Compounding</span>
                        <InfoTip
                          text="Sizes every new entry and DCA ticket as a % of the current workspace balance, so position sizes grow with profit instead of a fixed dollar lot."
                          label="Auto-Compounding"
                        />
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-300">
                        Scales each ticket with balance
                      </p>
                    </div>
                  </div>
                  <SciFiSwitch
                    checked={draft.auto_compounding ?? false}
                    onChange={(v) => {
                      audioSynth.playToggle(v);
                      setDraft((p) => ({ ...p, auto_compounding: v }));
                      void onSave({ auto_compounding: v });
                    }}
                    label="Auto-Compounding"
                    accent="amber"
                  />
                </div>

                {(draft.auto_compounding ?? false) && (
                  <div className="mt-3 border-t border-amber-500/20 pt-3">
                    <div className="mb-1 flex justify-between font-mono-tech text-[11px]">
                      <span className="text-slate-300">Allocation per trade</span>
                      <span className="font-bold text-amber-300">
                        {(draft.compound_allocation_pct ?? 5).toFixed(1)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.5}
                      max={50}
                      step={0.5}
                      value={draft.compound_allocation_pct ?? 5}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          compound_allocation_pct: Number(e.target.value),
                        }))
                      }
                      className="w-full accent-amber-400"
                    />
                    <p className="mt-1 font-mono-tech text-[10px] text-slate-500">
                      Clamped to Binance&apos;s $5.50 minimum in LIVE
                    </p>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-cyan-500/35 bg-cyan-500/8 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <Activity className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                    <div>
                      <div className="flex items-center gap-1.5 font-mono-tech text-xs font-bold text-cyan-200 uppercase">
                        <span>Multi-Timeframe Filter</span>
                        <InfoTip
                          text="Blocks a 1m/5m/15m BUY unless the 1h candle closes above its EMA20 with 1h RSI between 40 and 72, so the engine stops buying into macro downtrends."
                          label="Multi-Timeframe Filter"
                        />
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-300">
                        1h trend confirmation · RSI 40-72
                      </p>
                    </div>
                  </div>
                  <SciFiSwitch
                    checked={draft.multi_timeframe_filter ?? true}
                    onChange={(v) => {
                      audioSynth.playToggle(v);
                      setDraft((p) => ({ ...p, multi_timeframe_filter: v }));
                      void onSave({ multi_timeframe_filter: v });
                    }}
                    label="Multi-Timeframe Filter"
                    accent="cyan"
                  />
                </div>
                <p className="mt-3 border-t border-cyan-500/20 pt-2 font-mono-tech text-[10px] text-slate-500">
                  Crash Guard (±4% / 5m) and trailing exits always stay armed.
                </p>
              </div>
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
          <div className="flex items-center gap-2">
            <NeonButton
              type="button"
              variant={keysSavedToast ? 'emerald' : 'cyan'}
              onClick={handleSaveGatewayKeys}
              className="min-h-[34px] px-2.5 py-1 text-[11px]"
            >
              {keysSavedToast ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
              <span>{keysSavedToast ? t.keysSavedMsg : t.saveKeysBtn}</span>
            </NeonButton>
            <button
              type="button"
              onClick={() => setShowSecrets((v) => !v)}
              className="flex min-h-[34px] cursor-pointer items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1 font-mono-tech text-[11px] text-slate-300 hover:border-cyan-400/60"
            >
              {showSecrets ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              <span>{showSecrets ? 'HIDE' : 'SHOW'}</span>
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* One unified Binance Spot API & Secret Vault (form + status + live balance) */}
          <div className="space-y-3 rounded-xl border border-amber-500/35 bg-gradient-to-br from-amber-500/[0.08] via-[#05070d]/95 to-emerald-500/[0.06] p-4 lg:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-2 font-mono-tech text-xs font-bold text-amber-200">
                <ShieldCheck className="h-4 w-4" />
                <span>BINANCE SPOT API &amp; SECRET VAULT</span>
                <InfoTip text={t.helpBinance} label="BINANCE SPOT API" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...bnDraft, use_testnet: !bnDraft.use_testnet };
                    setBnDraft(next);
                    onSaveBinance(next);
                  }}
                  className={`cursor-pointer rounded border px-2 py-0.5 font-mono-tech text-[10px] font-semibold uppercase ${
                    bnDraft.use_testnet
                      ? 'border-amber-400/60 bg-amber-500/15 text-amber-300'
                      : 'border-emerald-400/60 bg-emerald-500/15 text-emerald-300'
                  }`}
                >
                  {bnDraft.use_testnet ? 'TESTNET' : 'SPOT MAINNET'}
                </button>
                <span
                  className={`rounded border px-2 py-0.5 font-mono-tech text-[10px] font-bold tracking-wider uppercase ${
                    apiKeyStatus.linked
                      ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-300'
                      : 'border-slate-600 bg-slate-800/60 text-slate-400'
                  }`}
                >
                  {apiKeyStatus.linked
                    ? `LINKED${apiKeyStatus.api_key_masked ? ` · ${apiKeyStatus.api_key_masked}` : ''}`
                    : 'NO KEYS LINKED'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 font-mono-tech text-[11px] sm:grid-cols-3">
              <div className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2">
                <div className="text-[9px] tracking-wider text-slate-500 uppercase">Workspace ID</div>
                <div className="truncate text-slate-100">{workspaceUser.telegramUserId}</div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2">
                <div className="text-[9px] tracking-wider text-slate-500 uppercase">Trader</div>
                <div className="truncate text-slate-100">
                  {workspaceUser.displayName}
                  {workspaceUser.username ? ` (@${workspaceUser.username})` : ''}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2">
                <div className="text-[9px] tracking-wider text-slate-500 uppercase">
                  Binance API Key
                </div>
                <div className="truncate text-amber-200">
                  {apiKeyStatus.api_key_masked ?? 'not saved yet'}
                </div>
              </div>
            </div>

            {/* 1-click Server IP whitelist box — sits right above the API key input */}
            <div className="rounded-xl border border-cyan-400/40 bg-gradient-to-r from-cyan-500/10 via-[#05070d]/90 to-emerald-500/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-mono-tech text-[10px] font-bold tracking-wider text-cyan-300 uppercase">
                    <Server className="h-3.5 w-3.5" />
                    <span>24/7 Server IP · whitelist this</span>
                  </div>
                  <code className="mt-1 block truncate font-mono-tech text-sm font-bold text-cyan-100">
                    {serverIp}
                  </code>
                </div>
                <NeonButton
                  type="button"
                  variant={copiedIp ? 'emerald' : 'cyan'}
                  onClick={() => void handleCopyServerIp()}
                  className="min-h-[34px] px-3 py-1 text-[11px]"
                >
                  {copiedIp ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedIp ? 'COPIED!' : 'COPY IP'}</span>
                </NeonButton>
              </div>
              <p className="mt-2 font-mono-tech text-[10px] leading-relaxed text-slate-300">
                Add this Server IP under{' '}
                <span className="text-cyan-200">“Restrict access to trusted IPs only”</span> in your
                Binance API Management settings.
              </p>
            </div>

            {/* Non-custodial safety notice */}
            <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/[0.07] p-3">
              <div className="mb-1.5 flex items-center gap-1.5 font-mono-tech text-[10px] font-bold tracking-wider text-emerald-300 uppercase">
                <ShieldCheck className="h-4 w-4" />
                <span>100% Non-Custodial &amp; Safe</span>
              </div>
              <ul className="space-y-1 font-mono-tech text-[10px] leading-relaxed text-slate-300">
                <li>
                  • Keep <span className="font-bold text-emerald-200">Enable Withdrawals</span> and{' '}
                  <span className="font-bold text-emerald-200">Universal Transfer</span> OFF on
                  Binance. Our bot can ONLY place Spot trades inside your account — it can never
                  withdraw or transfer your funds.
                </li>
                <li>
                  • Enable only <span className="font-bold text-emerald-200">Enable Reading</span>{' '}
                  and <span className="font-bold text-emerald-200">Enable Spot &amp; Margin Trading</span>.
                </li>
              </ul>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="binance-api-key"
                  className="mb-1 block font-mono-tech text-[11px] text-slate-400"
                >
                  Binance API Key
                </label>
                <input
                  id="binance-api-key"
                  type={showSecrets ? 'text' : 'password'}
                  value={bnDraft.api_key}
                  onChange={(e) => {
                    const next = { ...bnDraft, api_key: e.target.value, verified: false };
                    setBnDraft(next);
                    onSaveBinance(next);
                  }}
                  placeholder="Paste your Binance Spot API Key"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-amber-400 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="binance-api-secret"
                  className="mb-1 block font-mono-tech text-[11px] text-slate-400"
                >
                  Binance API Secret
                </label>
                <input
                  id="binance-api-secret"
                  type={showSecrets ? 'text' : 'password'}
                  value={bnDraft.api_secret}
                  onChange={(e) => {
                    const next = { ...bnDraft, api_secret: e.target.value, verified: false };
                    setBnDraft(next);
                    onSaveBinance(next);
                  }}
                  placeholder="Paste your Binance Spot API Secret"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-amber-400 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <NeonButton
                type="button"
                variant="amber"
                disabled={savingVault}
                onClick={handleSaveVault}
                className="min-h-[36px] px-3 py-1 text-[11px]"
              >
                <KeyRound className="h-3.5 w-3.5" />
                {savingVault ? 'SAVING & VERIFYING...' : 'SAVE & VERIFY KEYS'}
              </NeonButton>
              <NeonButton
                type="button"
                variant="emerald"
                disabled={testingVault}
                onClick={handleTestVault}
                className="min-h-[36px] px-3 py-1 text-[11px]"
              >
                <Activity className="h-3.5 w-3.5" />
                {testingVault ? 'TESTING...' : 'TEST CONNECTION'}
              </NeonButton>
              <NeonButton
                type="button"
                variant="cyan"
                disabled={savingVault}
                onClick={handleVerifyBn}
                className="min-h-[36px] px-3 py-1 text-[11px]"
              >
                {savingVault ? 'VERIFYING...' : 'VERIFY KEYS'}
              </NeonButton>
              <NeonButton
                type="button"
                variant="emerald"
                disabled={sendingBalTg}
                onClick={handleSendBalFromBinancePanel}
                className="min-h-[36px] px-3 py-1 text-[11px]"
              >
                <Send className="h-3.5 w-3.5" />
                {sendingBalTg ? 'SENDING...' : 'VIEW BALANCE IN TELEGRAM'}
              </NeonButton>
            </div>

            <p className="font-mono-tech text-[10px] leading-relaxed text-slate-400">
              {isGuest
                ? 'Guest mode: register an account to save real Binance keys. Virtual Demo trading stays free without an account.'
                : 'Both values are written to the worker’s private vault and never returned to a browser — only the mask above is. Saving verifies the keys, flips the badge to LINKED and loads your real portfolio (Spot USDT + held coins, converted to USD & BDT) immediately.'}
            </p>

            {vaultFeedback && (
              <div
                className={`rounded-lg border px-2.5 py-1.5 font-mono-tech text-[11px] ${
                  vaultFeedback.ok
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                }`}
              >
                {vaultFeedback.text}
              </div>
            )}

            {binanceAccount?.connected && (
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2.5 font-mono-tech text-[10px]">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 font-bold">
                  <span className="text-emerald-300">REAL BINANCE PORTFOLIO</span>
                  <span className="text-emerald-200">
                    ${binanceAccount.totalPortfolioUsd.toFixed(2)} USD · ৳
                    {Math.round(binanceAccount.totalPortfolioUsd * BDT_PER_USD).toLocaleString(
                      'en-US'
                    )}{' '}
                    BDT
                  </span>
                </div>
                <div className="mb-1.5 flex flex-wrap gap-x-3 gap-y-1 text-slate-300">
                  <span>Spot USDT ${(binanceAccount.spotUsd ?? 0).toFixed(2)}</span>
                  <span>Held coins ${(binanceAccount.spotCoinsUsd ?? 0).toFixed(2)}</span>
                  <span className={canFundOrders ? 'text-emerald-300' : 'text-amber-300'}>
                    {t.tradeableUsdtLabel}: ${tradeableUsdt.toFixed(2)}
                  </span>
                </div>
                {binanceAccount.assets.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {binanceAccount.assets.slice(0, 8).map((a) => (
                      <span
                        key={a.asset}
                        className="rounded border border-slate-700/80 bg-[#090d16] px-2 py-0.5 text-slate-200"
                      >
                        {a.asset}: {a.total} (${a.usdValue.toFixed(2)})
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-amber-300">{t.liveBalanceEmptyZero}</div>
                )}
              </div>
            )}
          </div>
          {/* Telegram Bot Integration */}
          <div className="space-y-3 rounded-xl border border-slate-800/80 bg-[#05070d]/90 p-4 lg:col-span-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono-tech text-xs font-bold text-cyan-300">
                <Send className="h-4 w-4" />
                <span>{t.telegramAlerts}</span>
                <InfoTip text={t.helpTelegram} label={t.telegramAlerts} />
              </div>
              <SciFiSwitch
                checked={draft.telegram_enabled}
                onChange={(v) => {
                  setDraft((p) => ({ ...p, telegram_enabled: v }));
                  void onSave({ telegram_enabled: v });
                }}
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
                onChange={(e) => {
                  const next = { ...tgDraft, bot_token: e.target.value };
                  setTgDraft(next);
                  onSaveTelegram(next);
                }}
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
                onChange={(e) => {
                  const next = { ...tgDraft, chat_id: e.target.value };
                  setTgDraft(next);
                  onSaveTelegram(next);
                }}
                placeholder="-1001234567890"
                className="min-h-[40px] w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 font-mono-tech text-xs text-slate-100 placeholder-slate-600 focus:border-cyan-400 focus:outline-none"
              />
            </div>

            {/* Telegram Real Money / Balance in Notification Toggle */}
            <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/35 bg-emerald-500/8 px-3 py-2.5">
              <div className="flex items-start gap-2">
                <DollarSign className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <div>
                  <div className="font-mono-tech text-[11px] font-bold text-emerald-300">
                    {t.tgNotifyBalanceToggle}
                  </div>
                  <p className="text-[10px] text-slate-400">{t.tgNotifyBalanceHint}</p>
                </div>
              </div>
              <SciFiSwitch
                checked={tgDraft.notify_balance !== false}
                onChange={(v) => {
                  const next = { ...tgDraft, notify_balance: v };
                  setTgDraft(next);
                  onSaveTelegram(next);
                }}
                label={t.tgNotifyBalanceToggle}
                accent="emerald"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
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

              <NeonButton
                type="button"
                variant="emerald"
                disabled={sendingBalTg}
                onClick={handleSendBalTg}
                className="min-h-[36px] px-3 py-1 text-[11px]"
              >
                <DollarSign className="h-3.5 w-3.5" />
                {sendingBalTg ? 'SENDING...' : t.tgSendBalanceNowBtn}
              </NeonButton>
            </div>

            {tgFeedback && (
              <div
                className={`rounded-lg border px-2.5 py-1.5 font-mono-tech text-[11px] ${
                  tgFeedback.ok
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                }`}
              >
                {tgFeedback.text}
              </div>
            )}
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
              <br />
              Server IP: <code className="text-cyan-300">{serverIp}</code> — Binance API-এ “Restrict
              access to trusted IPs only”-তে যোগ করুন। Withdrawals ও Universal Transfer বন্ধ রাখুন।
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
