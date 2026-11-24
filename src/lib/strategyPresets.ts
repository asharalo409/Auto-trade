import { BotSettings, Language } from '../types/trading';

export type StrategyPresetId = 'safe' | 'balanced' | 'scalping';

export interface StrategyPreset {
  id: StrategyPresetId;
  /** Short selector label. */
  label: Record<Language, string>;
  /** One-line description rendered under the label. */
  blurb: Record<Language, string>;
  /** Multi-timeframe RSI buy band the worker enforces for this preset. */
  rsiMin: number;
  rsiMax: number;
  /** Accent classes for the selected/hovered card. */
  accent: {
    text: string;
    border: string;
    bg: string;
    glow: string;
  };
  /** Strategy values written to Supabase the moment the preset is tapped. */
  patch: Partial<BotSettings>;
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'safe',
    label: { en: 'Safe', bn: 'নিরাপদ' },
    blurb: {
      en: 'Conservative entries · strict RSI 40–65',
      bn: 'সতর্ক এন্ট্রি · কঠোর RSI ৪০–৬৫',
    },
    rsiMin: 40,
    rsiMax: 65,
    accent: {
      text: 'text-emerald-200',
      border: 'border-emerald-400/70',
      bg: 'bg-emerald-500/15',
      glow: 'shadow-[0_0_22px_-4px_rgba(16,185,129,0.65)]',
    },
    patch: {
      strategy_preset: 'safe',
      amount_per_trade: 5.5,
      max_amount_per_pair: 25,
      take_profit_pct: 1.5,
      trailing_stop_pct: 1.0,
      max_open_trades: 2,
      dca_enabled: false,
      multi_timeframe_filter: true,
    },
  },
  {
    id: 'balanced',
    label: { en: 'Balanced', bn: 'ভারসাম্যপূর্ণ' },
    blurb: {
      en: 'Standard RSI 40–72 · DCA enabled',
      bn: 'স্বাভাবিক RSI ৪০–৭২ · DCA চালু',
    },
    rsiMin: 40,
    rsiMax: 72,
    accent: {
      text: 'text-cyan-200',
      border: 'border-cyan-400/70',
      bg: 'bg-cyan-500/15',
      glow: 'shadow-[0_0_22px_-4px_rgba(34,211,238,0.65)]',
    },
    patch: {
      strategy_preset: 'balanced',
      amount_per_trade: 10,
      max_amount_per_pair: 50,
      take_profit_pct: 1.2,
      trailing_stop_pct: 0.6,
      max_open_trades: 3,
      dca_enabled: true,
      multi_timeframe_filter: true,
    },
  },
  {
    id: 'scalping',
    label: { en: 'Scalping', bn: 'স্ক্যাল্পিং' },
    blurb: {
      en: 'Fast micro-momentum · relaxed RSI 35–78',
      bn: 'দ্রুত মাইক্রো-মোমেন্টাম · শিথিল RSI ৩৫–৭৮',
    },
    rsiMin: 35,
    rsiMax: 78,
    accent: {
      text: 'text-amber-200',
      border: 'border-amber-400/70',
      bg: 'bg-amber-500/15',
      glow: 'shadow-[0_0_22px_-4px_rgba(245,158,11,0.65)]',
    },
    patch: {
      strategy_preset: 'scalping',
      amount_per_trade: 5.5,
      max_amount_per_pair: 50,
      take_profit_pct: 0.6,
      trailing_stop_pct: 0.3,
      max_open_trades: 5,
      dca_enabled: true,
      multi_timeframe_filter: true,
    },
  },
];

export function getStrategyPreset(id: string | null | undefined): StrategyPreset | null {
  if (!id) return null;
  return STRATEGY_PRESETS.find((preset) => preset.id === id) ?? null;
}
