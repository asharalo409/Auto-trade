import React, { useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Camera, CheckCircle2, Lock, Play, ShieldAlert, Terminal, UserPlus } from 'lucide-react';
import { audioSynth } from '../../lib/audioSynth';
import { avatarInitials, fileToAvatarDataUrl } from '../../lib/avatar';
import { checkEmailWithApyhub } from '../../lib/emailValidation';
import { resolveWorkspaceIdentity } from '../../lib/userIdentity';
import { NeonButton } from '../ui/MotionPrimitives';

interface LoginScreenProps {
  t: Record<string, string>;
  isSupabaseConfigured: boolean;
  onSignIn: (email: string, password: string) => Promise<{ error: string | null }>;
  onSignUp: (
    email: string,
    password: string,
    profile?: {
      fullName?: string;
      avatarUrl?: string | null;
      telegramChatId?: string | null;
      telegramUsername?: string | null;
    }
  ) => Promise<{ error: string | null; message?: string }>;
  onResetPassword: (
    email: string
  ) => Promise<{ error: string | null; message?: string }>;
  onEnterDemo: () => void;
  onReplayBoot: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({
  t,
  isSupabaseConfigured,
  onSignIn,
  onSignUp,
  onResetPassword,
  onEnterDemo,
  onReplayBoot,
}) => {
  const reducedMotion = useReducedMotion();
  const telegramIdentity = resolveWorkspaceIdentity();
  const [authMode, setAuthMode] = useState<'SIGNIN' | 'SIGNUP'>('SIGNIN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState(telegramIdentity.displayName === 'Web Guest' ? '' : telegramIdentity.displayName);
  const [telegramChatId, setTelegramChatId] = useState(telegramIdentity.chatId ?? '');
  const [avatarUrl, setAvatarUrl] = useState(telegramIdentity.photoUrl ?? '');
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const telegramUsername = telegramIdentity.username;

  const handleAvatarFile = async (file: File | null) => {
    if (!file) return;
    setAvatarError(null);
    try {
      // 160x160 WebP/JPEG data URL — small enough to store on the users row.
      setAvatarUrl(await fileToAvatarDataUrl(file));
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Could not process that image');
    }
  };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [emailNotice, setEmailNotice] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMsg(null);
    setEmailNotice(null);
    if (!email.trim() || !password.trim()) {
      setError('ইমেইল এবং পাসওয়ার্ড দুটিই দিন।');
      return;
    }
    if (authMode === 'SIGNUP') {
      if (password.length < 6) {
        setError('পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।');
        return;
      }
      if (password !== confirmPassword) {
        setError('দুইটি পাসওয়ার্ড এক হতে হবে।');
        return;
      }
      if (!fullName.trim()) {
        setError('Full name is required for admin approval.');
        return;
      }
      setLoading(true);
      // Server-side ApyHub check (format, domain, disposable). Not a mailbox ownership check.
      const check = await checkEmailWithApyhub(email.trim(), { disposableChecks: true });
      if (check.status === 'invalid') {
        setLoading(false);
        setError(
          'এই ইমেইলটি গ্রহণ করা যাচ্ছে না — ফরম্যাট/ডোমেইন সঠিক নয় অথবা এটি ডিসপোজেবল ইমেইল। (Format, domain & disposable check — not mailbox ownership.)'
        );
        return;
      }
      if (!check.ok) {
        setEmailNotice(
          'ApyHub ইমেইল যাচাই পাওয়া যায়নি — যাচাই ছাড়াই অ্যাকাউন্ট তৈরি হচ্ছে। (Validation service unavailable.)'
        );
      }
      const res = await onSignUp(email.trim(), password, {
        fullName: fullName.trim(),
        avatarUrl: avatarUrl.trim() || null,
        telegramChatId: telegramChatId.trim() || null,
        telegramUsername,
      });
      setLoading(false);
      if (res.error) setError(res.error);
      else if (res.message) setInfoMsg(res.message);
      return;
    }

    setLoading(true);
    const res = await onSignIn(email.trim(), password);
    setLoading(false);
    if (res.error) {
      setError(res.error);
    }
  };

  const handleForgot = async () => {
    setError(null);
    setInfoMsg(null);
    if (!email.trim()) {
      setError('আগে আপনার ইমেইল লিখুন।');
      return;
    }
    setLoading(true);
    const res = await onResetPassword(email.trim());
    setLoading(false);
    if (res.error) setError(res.error);
    else if (res.message) setInfoMsg(res.message);
  };

  return (
    <div className="relative flex min-h-[calc(100vh-120px)] items-center justify-center px-4 py-10">
      <motion.div
        initial={reducedMotion ? false : { opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-md rounded-2xl border border-cyan-500/35 bg-[#090d16]/95 p-6 shadow-[0_0_50px_-15px_rgba(34,211,238,0.35)] sm:p-8"
      >
        <span className="pointer-events-none absolute top-0 left-0 h-3 w-3 rounded-tl-2xl border-t-2 border-l-2 border-cyan-400" />
        <span className="pointer-events-none absolute top-0 right-0 h-3 w-3 rounded-tr-2xl border-t-2 border-r-2 border-cyan-400" />
        <span className="pointer-events-none absolute bottom-0 left-0 h-3 w-3 rounded-bl-2xl border-b-2 border-l-2 border-cyan-400" />
        <span className="pointer-events-none absolute bottom-0 right-0 h-3 w-3 rounded-br-2xl border-b-2 border-r-2 border-cyan-400" />

        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-cyan-400">
              <Lock className="h-4 w-4" />
              <span className="font-mono-tech text-[11px] tracking-widest uppercase">
                AEGIS QUANT // AUTH
              </span>
            </div>
            <h1 className="mt-2 font-display text-2xl font-bold tracking-wide text-slate-100 uppercase">
              {t.loginTitle}
            </h1>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">{t.loginSub}</p>
          </div>
          <button
            type="button"
            onClick={onReplayBoot}
            title="Replay boot sequence"
            className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-700/80 px-2.5 py-1.5 font-mono-tech text-[11px] text-slate-300 transition-colors hover:border-cyan-400/60 hover:text-cyan-300"
          >
            <Terminal className="h-3.5 w-3.5" />
            {t.replayBoot}
          </button>
        </div>

        {/* Sign In vs Set Password / Create Account Tabs */}
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-slate-800 bg-[#05060a] p-1">
          <button
            type="button"
            onClick={() => {
              audioSynth.playClick();
              setAuthMode('SIGNIN');
              setError(null);
              setInfoMsg(null);
              setEmailNotice(null);
            }}
            className={`min-h-[36px] cursor-pointer rounded-lg font-mono-tech text-xs font-bold uppercase transition-colors ${
              authMode === 'SIGNIN'
                ? 'bg-cyan-500/20 text-cyan-200'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              audioSynth.playClick();
              setAuthMode('SIGNUP');
              setError(null);
              setInfoMsg(null);
              setEmailNotice(null);
            }}
            className={`min-h-[36px] cursor-pointer rounded-lg font-mono-tech text-xs font-bold uppercase transition-colors ${
              authMode === 'SIGNUP'
                ? 'bg-emerald-500/20 text-emerald-200'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Register
          </button>
        </div>

        {!isSupabaseConfigured && (
          <div className="mb-4 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
            Supabase environment keys সেট না থাকলে নিচের সবুজ বাটনে চাপ দিয়ে সরাসরি Virtual Demo মোডে ঢুকতে পারবেন।
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3.5">
          {authMode === 'SIGNUP' && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                className="group relative h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-full border border-emerald-400/40 bg-[#05060a]"
                aria-label="Upload profile photo"
              >
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt="Profile preview"
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-emerald-300 to-teal-700 font-display text-lg font-black text-[#04120c]">
                    {avatarInitials(fullName || email || 'A')}
                  </span>
                )}
                <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
                  <Camera className="h-5 w-5 text-emerald-200" />
                </span>
              </button>
              <div className="min-w-0">
                <div className="font-mono-tech text-[11px] tracking-wider text-slate-300 uppercase">
                  Profile Photo
                </div>
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  className="mt-1 flex items-center gap-1.5 rounded border border-slate-700 px-2 py-1 font-mono-tech text-[10px] text-slate-200 hover:border-emerald-400/60 hover:text-emerald-300"
                >
                  <Camera className="h-3.5 w-3.5" />
                  {avatarUrl ? 'Change photo' : 'Choose photo'}
                </button>
                <p className="mt-1 font-mono-tech text-[9px] text-slate-500">
                  Auto-compressed to 160×160. {telegramIdentity.photoUrl ? 'Telegram photo pre-filled.' : 'Optional.'}
                </p>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  void handleAvatarFile(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
            </div>
          )}

          {authMode === 'SIGNUP' && avatarError && (
            <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-200">
              {avatarError}
            </p>
          )}

          {authMode === 'SIGNUP' && (
            <div>
              <label
                htmlFor="operator-full-name"
                className="mb-1.5 block font-mono-tech text-[11px] tracking-wider text-slate-300 uppercase"
              >
                Full Name
              </label>
              <input
                id="operator-full-name"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Your full name"
                autoComplete="name"
                disabled={!isSupabaseConfigured}
                className="min-h-[44px] w-full rounded-lg border border-slate-700/80 bg-[#05060a] px-3.5 py-2.5 font-mono-tech text-sm text-slate-100 placeholder-slate-600 transition-colors focus:border-emerald-400 focus:outline-none disabled:opacity-50"
              />
            </div>
          )}

          <div>
            <label
              htmlFor="operator-email"
              className="mb-1.5 block font-mono-tech text-[11px] tracking-wider text-slate-300 uppercase"
            >
              {t.emailLabel}
            </label>
            <input
              id="operator-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="billahtaseen@gmail.com"
              autoComplete="email"
              disabled={!isSupabaseConfigured}
              className="min-h-[44px] w-full rounded-lg border border-slate-700/80 bg-[#05060a] px-3.5 py-2.5 font-mono-tech text-sm text-slate-100 placeholder-slate-600 transition-colors focus:border-cyan-400 focus:outline-none disabled:opacity-50"
            />
            <p className="mt-1.5 font-mono-tech text-[10px] leading-relaxed text-slate-500">
              ApyHub checks format, domain &amp; disposable addresses on sign-up — not mailbox
              ownership.
            </p>
            {emailNotice && (
              <p className="mt-1.5 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200">
                {emailNotice}
              </p>
            )}
          </div>

          {authMode === 'SIGNUP' && (
            <div>
              <label
                htmlFor="operator-chat-id"
                className="mb-1.5 block font-mono-tech text-[11px] tracking-wider text-slate-300 uppercase"
              >
                Telegram Chat ID
              </label>
              <input
                id="operator-chat-id"
                type="text"
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                placeholder="e.g. 123456789"
                inputMode="numeric"
                autoComplete="off"
                disabled={!isSupabaseConfigured}
                className="min-h-[44px] w-full rounded-lg border border-slate-700/80 bg-[#05060a] px-3.5 py-2.5 font-mono-tech text-sm text-slate-100 placeholder-slate-600 transition-colors focus:border-emerald-400 focus:outline-none disabled:opacity-50"
              />
              <p className="mt-1.5 font-mono-tech text-[10px] leading-relaxed text-slate-500">
                {telegramIdentity.isTelegram
                  ? 'Auto-filled from your Telegram profile. Trade alerts will be sent here.'
                  : 'Not in Telegram? Open @TaseenMarketBot, send /start, and copy the chat id it replies with. This is where your private alerts arrive.'}
              </p>
            </div>
          )}

          <div>
            <label
              htmlFor="operator-password"
              className="mb-1.5 block font-mono-tech text-[11px] tracking-wider text-slate-300 uppercase"
            >
              {t.passwordLabel}
            </label>
            <input
              id="operator-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              autoComplete={authMode === 'SIGNUP' ? 'new-password' : 'current-password'}
              disabled={!isSupabaseConfigured}
              className="min-h-[44px] w-full rounded-lg border border-slate-700/80 bg-[#05060a] px-3.5 py-2.5 font-mono-tech text-sm text-slate-100 placeholder-slate-600 transition-colors focus:border-cyan-400 focus:outline-none disabled:opacity-50"
            />
          </div>

          {authMode === 'SIGNUP' && (
            <div>
              <label
                htmlFor="operator-confirm-password"
                className="mb-1.5 block font-mono-tech text-[11px] tracking-wider text-slate-300 uppercase"
              >
                Confirm Password
              </label>
              <input
                id="operator-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••••••"
                autoComplete="new-password"
                disabled={!isSupabaseConfigured}
                className="min-h-[44px] w-full rounded-lg border border-slate-700/80 bg-[#05060a] px-3.5 py-2.5 font-mono-tech text-sm text-slate-100 placeholder-slate-600 transition-colors focus:border-emerald-400 focus:outline-none disabled:opacity-50"
              />
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {infoMsg && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              <span>{infoMsg}</span>
            </div>
          )}

          <div className="flex flex-col gap-2.5 pt-2">
            {isSupabaseConfigured && (
              <NeonButton
                type="submit"
                variant={authMode === 'SIGNUP' ? 'emerald' : 'cyan'}
                disabled={loading}
                className="w-full"
              >
                {authMode === 'SIGNUP' && <UserPlus className="h-3.5 w-3.5" />}
                {loading
                  ? 'PROCESSING...'
                  : authMode === 'SIGNUP'
                    ? 'Create Account (Pending Approval)'
                    : t.signInBtn}
              </NeonButton>
            )}

            {isSupabaseConfigured && authMode === 'SIGNIN' && (
              <button
                type="button"
                onClick={handleForgot}
                className="cursor-pointer text-right font-mono-tech text-[11px] text-cyan-400 hover:underline"
              >
                Reset / Forgot Password?
              </button>
            )}

            <NeonButton
              type="button"
              variant="emerald"
              onClick={onEnterDemo}
              className="w-full"
            >
              <Play className="h-3.5 w-3.5" />
              {t.enterDemoBtn}
            </NeonButton>
          </div>
        </form>
      </motion.div>
    </div>
  );
};
