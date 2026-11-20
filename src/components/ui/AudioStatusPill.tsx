import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Volume2, VolumeX } from 'lucide-react';
import { telegramHaptic } from '../../lib/telegramWebApp';

interface AudioStatusPillProps {
  ready: boolean;
  voiceEnabled: boolean;
  onUnlock: () => void;
}

/**
 * Telegram WebView keeps audio locked until a real gesture. This pill tells the
 * operator whether the audio engine is live and doubles as the unlock button.
 */
export const AudioStatusPill: React.FC<AudioStatusPillProps> = ({
  ready,
  voiceEnabled,
  onUnlock,
}) => {
  const reducedMotion = useReducedMotion();
  const onClick = () => {
    telegramHaptic('light');
    onUnlock();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        ready
          ? 'Audio engine unlocked — candle ticks, trade chimes and voice announcements are live.'
          : 'Tap once to unlock audio inside the Telegram Mini App.'
      }
      aria-label={ready ? 'Audio ready' : 'Tap to unlock audio'}
      className={`tap-target flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono-tech text-[10px] font-bold tracking-wide uppercase transition-colors ${
        ready
          ? 'border-emerald-400/50 bg-emerald-500/12 text-emerald-300 hover:bg-emerald-500/20'
          : 'border-amber-400/55 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
      }`}
    >
      <span className="relative flex h-3.5 w-3.5 items-center justify-center">
        {ready ? (
          <>
            <Volume2 className="h-3.5 w-3.5" />
            {!reducedMotion && (
              <motion.span
                aria-hidden="true"
                animate={{ scale: [1, 1.9, 1], opacity: [0.5, 0, 0.5] }}
                transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
                className="absolute inset-0 rounded-full border border-emerald-300/70"
              />
            )}
          </>
        ) : (
          <VolumeX className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="whitespace-nowrap">
        {ready ? (voiceEnabled ? '🔊 Audio Ready' : '🔊 Audio Ready · Muted') : '🔇 Tap to Unlock Audio'}
      </span>
    </button>
  );
};
