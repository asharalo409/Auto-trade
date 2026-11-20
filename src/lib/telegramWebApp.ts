/**
 * Thin, defensive wrapper around the Telegram Mini App (WebApp) SDK.
 *
 * The script is loaded from telegram.org in index.html, but it only defines
 * `window.Telegram.WebApp` when the page actually runs inside Telegram. Every
 * helper below therefore no-ops in a normal browser tab, and never throws if an
 * older Telegram client is missing one of the newer methods.
 */

export type HapticImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';

export interface TelegramHapticFeedback {
  impactOccurred: (style: HapticImpactStyle) => void;
  notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
  selectionChanged?: () => void;
}

export interface TelegramWebApp {
  ready: () => void;
  expand: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  disableVerticalSwipes?: () => void;
  isExpanded?: boolean;
  platform?: string;
  colorScheme?: 'light' | 'dark';
  HapticFeedback?: TelegramHapticFeedback;
  initDataUnsafe?: { user?: { id?: number; first_name?: string; username?: string } };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const TELEGRAM_CHROME_COLOR = '#090d12';

export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.Telegram?.WebApp ?? null;
  } catch {
    return null;
  }
}

export function isTelegramMiniApp(): boolean {
  return getTelegramWebApp() !== null;
}

/** Signal readiness, go full-screen and paint Telegram's chrome to match the app. */
export function initTelegramMiniApp(): void {
  const webApp = getTelegramWebApp();
  if (!webApp) return;
  try {
    webApp.ready();
    webApp.expand();
    webApp.setHeaderColor?.(TELEGRAM_CHROME_COLOR);
    webApp.setBackgroundColor?.(TELEGRAM_CHROME_COLOR);
    webApp.setBottomBarColor?.(TELEGRAM_CHROME_COLOR);
    webApp.disableVerticalSwipes?.();
  } catch (err) {
    console.warn('[Telegram] Mini App initialisation failed:', err);
  }
}

/** Short light haptic pulse for taps, tab switches and engine toggles. */
export function telegramHaptic(style: HapticImpactStyle = 'light'): void {
  const webApp = getTelegramWebApp();
  if (!webApp?.HapticFeedback?.impactOccurred) return;
  try {
    webApp.HapticFeedback.impactOccurred(style);
  } catch {
    // Older clients can reject unknown impact styles — never break the tap.
  }
}
