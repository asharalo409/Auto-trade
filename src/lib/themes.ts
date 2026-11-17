import { ThemeId } from '../types/trading';

export interface TerminalTheme {
  id: ThemeId;
  name: string;
  tag: string;
  bgCanvas: string;
  bgPanel: string;
  primaryHex: string;
  secondaryHex: string;
  profitHex: string;
  lossHex: string;
  blobAClass: string;
  blobBClass: string;
  gridRgba: string;
  borderGlow: string;
  accentText: string;
  accentBorder: string;
  accentBg: string;
  threePrimary: number;
  threeSecondary: number;
}

export function getTimeBasedTheme(date = new Date()): { theme: ThemeId; isDay: boolean } {
  const hour = date.getHours();
  const isDay = hour >= 6 && hour < 18;
  return {
    theme: isDay ? 'SOLAR_FLARE' : 'DEEP_SPACE',
    isDay,
  };
}

export const TERMINAL_THEMES: Record<ThemeId, TerminalTheme> = {
  CYBER_CYAN: {
    id: 'CYBER_CYAN',
    name: 'Heliovex Cyan',
    tag: 'CYAN',
    bgCanvas: '#05060a',
    bgPanel: 'rgba(9, 13, 22, 0.92)',
    primaryHex: '#22d3ee',
    secondaryHex: '#10b981',
    profitHex: '#34d399',
    lossHex: '#fb7185',
    blobAClass: 'bg-emerald-500/20',
    blobBClass: 'bg-cyan-500/18',
    gridRgba: 'rgba(34, 211, 238, 0.045)',
    borderGlow: 'rgba(34, 211, 238, 0.4)',
    accentText: 'text-cyan-300',
    accentBorder: 'border-cyan-400/50',
    accentBg: 'bg-cyan-500/15',
    threePrimary: 0x10b981,
    threeSecondary: 0x22d3ee,
  },
  DEEP_SPACE: {
    id: 'DEEP_SPACE',
    name: 'Deep Space',
    tag: 'NIGHT',
    bgCanvas: '#020308',
    bgPanel: 'rgba(5, 8, 18, 0.95)',
    primaryHex: '#38bdf8',
    secondaryHex: '#818cf8',
    profitHex: '#34d399',
    lossHex: '#f43f5e',
    blobAClass: 'bg-indigo-600/22',
    blobBClass: 'bg-sky-500/18',
    gridRgba: 'rgba(56, 189, 248, 0.055)',
    borderGlow: 'rgba(129, 140, 248, 0.48)',
    accentText: 'text-sky-300',
    accentBorder: 'border-sky-400/55',
    accentBg: 'bg-sky-500/15',
    threePrimary: 0x38bdf8,
    threeSecondary: 0x818cf8,
  },
  SOLAR_FLARE: {
    id: 'SOLAR_FLARE',
    name: 'Solar Flare',
    tag: 'DAY',
    bgCanvas: '#140e05',
    bgPanel: 'rgba(26, 18, 7, 0.94)',
    primaryHex: '#facc15',
    secondaryHex: '#fb923c',
    profitHex: '#4ade80',
    lossHex: '#fb7185',
    blobAClass: 'bg-yellow-400/22',
    blobBClass: 'bg-orange-500/20',
    gridRgba: 'rgba(250, 204, 21, 0.075)',
    borderGlow: 'rgba(250, 204, 21, 0.55)',
    accentText: 'text-yellow-300',
    accentBorder: 'border-yellow-400/60',
    accentBg: 'bg-yellow-400/18',
    threePrimary: 0xfacc15,
    threeSecondary: 0xfb923c,
  },
  AMBER_TTY: {
    id: 'AMBER_TTY',
    name: 'Ambrx Phosphor',
    tag: 'GOLD',
    bgCanvas: '#070502',
    bgPanel: 'rgba(18, 13, 6, 0.92)',
    primaryHex: '#fbbf24',
    secondaryHex: '#f59e0b',
    profitHex: '#4ade80',
    lossHex: '#f87171',
    blobAClass: 'bg-amber-500/20',
    blobBClass: 'bg-orange-500/16',
    gridRgba: 'rgba(251, 191, 36, 0.045)',
    borderGlow: 'rgba(251, 191, 36, 0.42)',
    accentText: 'text-amber-300',
    accentBorder: 'border-amber-400/50',
    accentBg: 'bg-amber-500/15',
    threePrimary: 0xfbbf24,
    threeSecondary: 0xf97316,
  },
  CRIMSON_ALGO: {
    id: 'CRIMSON_ALGO',
    name: 'Algory Crimson',
    tag: 'REDLINE',
    bgCanvas: '#080305',
    bgPanel: 'rgba(18, 8, 12, 0.92)',
    primaryHex: '#fb7185',
    secondaryHex: '#ef4444',
    profitHex: '#34d399',
    lossHex: '#f43f5e',
    blobAClass: 'bg-rose-500/20',
    blobBClass: 'bg-red-600/15',
    gridRgba: 'rgba(244, 63, 94, 0.045)',
    borderGlow: 'rgba(244, 63, 94, 0.42)',
    accentText: 'text-rose-300',
    accentBorder: 'border-rose-400/50',
    accentBg: 'bg-rose-500/15',
    threePrimary: 0xf43f5e,
    threeSecondary: 0xfb923c,
  },
  DEEP_Q_VIOLET: {
    id: 'DEEP_Q_VIOLET',
    name: 'Synaptra Deep-Q',
    tag: 'NEURAL',
    bgCanvas: '#06040b',
    bgPanel: 'rgba(14, 9, 24, 0.92)',
    primaryHex: '#c084fc',
    secondaryHex: '#38bdf8',
    profitHex: '#34d399',
    lossHex: '#fb7185',
    blobAClass: 'bg-fuchsia-500/18',
    blobBClass: 'bg-indigo-500/20',
    gridRgba: 'rgba(192, 132, 252, 0.045)',
    borderGlow: 'rgba(192, 132, 252, 0.42)',
    accentText: 'text-purple-300',
    accentBorder: 'border-purple-400/50',
    accentBg: 'bg-purple-500/15',
    threePrimary: 0xc084fc,
    threeSecondary: 0x38bdf8,
  },
  EMERALD_QUANT: {
    id: 'EMERALD_QUANT',
    name: 'Kairos Matrix',
    tag: 'QUANT',
    bgCanvas: '#030806',
    bgPanel: 'rgba(6, 16, 12, 0.92)',
    primaryHex: '#34d399',
    secondaryHex: '#2dd4bf',
    profitHex: '#4ade80',
    lossHex: '#fb7185',
    blobAClass: 'bg-emerald-500/22',
    blobBClass: 'bg-teal-500/16',
    gridRgba: 'rgba(16, 185, 129, 0.05)',
    borderGlow: 'rgba(16, 185, 129, 0.42)',
    accentText: 'text-emerald-300',
    accentBorder: 'border-emerald-400/50',
    accentBg: 'bg-emerald-500/15',
    threePrimary: 0x34d399,
    threeSecondary: 0xa3e635,
  },
};
