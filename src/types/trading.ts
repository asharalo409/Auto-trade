export type Language = 'en' | 'bn';

export type TabId = 'command' | 'market' | 'feed' | 'trades' | 'risk' | 'settings';

export type BotStatus = 'RUNNING' | 'STOPPED' | 'OFFLINE';

export type TradingMode = 'DEMO' | 'LIVE';

export type TradeStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';

export type LogLevel = 'INFO' | 'WARNING' | 'ERROR' | 'TRADE';

export type SignalType = 'BUY' | 'HOLD' | 'SELL';

export type EquityTimeframe = '1D' | '1W' | '1M' | 'ALL';

export type ThemeId =
  | 'CYBER_CYAN'
  | 'DEEP_SPACE'
  | 'SOLAR_FLARE'
  | 'AMBER_TTY'
  | 'CRIMSON_ALGO'
  | 'DEEP_Q_VIOLET'
  | 'EMERALD_QUANT';

export type CoreVisualMode = 'torus' | 'lorenz' | 'vortex' | 'depth';

export type CandleStyle = 'japanese' | 'heikin_ashi' | 'hollow' | 'momentum_ribbon';

export type ChartTimeframe = '1M' | '5M' | '15M' | '1H' | '4H';

export type ChartIndicator = 'MA' | 'EMA' | 'BOLL' | 'VWAP';

export interface CandlePoint {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma7?: number;
  ma25?: number;
  ema20?: number;
  ema50?: number;
  bbUpper?: number;
  bbMid?: number;
  bbLower?: number;
  vwap?: number;
}

export type BackgroundPresetId = 'tiger' | 'lion' | 'eagle' | 'none';

export interface TelegramConfig {
  bot_token: string;
  chat_id: string;
  notify_trades: boolean;
  notify_tp_sl: boolean;
  notify_status: boolean;
  notify_balance?: boolean;
}

export interface BinanceConfig {
  api_key: string;
  api_secret: string;
  use_testnet: boolean;
  verified: boolean;
}

export interface BinanceAssetHolding {
  asset: string;
  free: number;
  locked: number;
  total: number;
  usdValue: number;
}

export interface BinanceAccountSummary {
  connected: boolean;
  usdtFree: number;
  usdtLocked: number;
  totalUsdt: number;
  totalPortfolioUsd: number;
  spotUsd?: number;
  fundingUsd?: number;
  earnUsd?: number;
  walletBreakdown?: { walletName: string; balanceUsd: number }[];
  assets: BinanceAssetHolding[];
  canTrade: boolean;
  lastSyncedAt: string;
  errorDetail?: string | null;
  serverIp?: string | null;
}

export interface BotSettings {
  id: number | string;
  bot_enabled: boolean;
  amount_per_trade: number;
  take_profit_pct: number;
  stop_loss_enabled: boolean;
  stop_loss_pct: number;
  sell_only_in_profit: boolean;
  zero_loss_mode: boolean;
  dca_enabled: boolean;
  dca_step_pct: number;
  dca_max_buys: number;
  auto_theme_by_time: boolean;
  max_open_trades: number;
  max_amount_per_pair: number;
  daily_loss_limit: number;
  mode: TradingMode;
  enabled_pairs: string[];
  telegram_enabled: boolean;
  sound_enabled: boolean;
  theme: ThemeId;
  core_visual: CoreVisualMode;
  candle_style: CandleStyle;
  last_heartbeat: string;
  balance_usdt?: number;
  updated_at?: string;
}

export interface Trade {
  id: string;
  pair: string;
  side: 'BUY' | 'SELL';
  status: TradeStatus;
  entry_price: number;
  current_price: number;
  exit_price?: number | null;
  quantity: number;
  invested_usdt: number;
  profit_usdt: number;
  profit_pct: number;
  take_profit_price: number;
  stop_loss_price: number;
  opened_at: string;
  closed_at?: string | null;
}

export interface LogEntry {
  id: string;
  level: LogLevel;
  message: string;
  pair?: string | null;
  created_at: string;
}

export interface PairMarketData {
  symbol: string;
  base: string;
  quote: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  baseVolume24h: number;
  inflowPct: number;
  rsi14: number;
  ema20: number;
  ema50: number;
  signal: SignalType;
  perf: {
    today: number;
    d7: number;
    d30: number;
    d90: number;
  };
  sparkline: { t: string; p: number }[];
}

export interface SmartAlert {
  id: string;
  pair: string;
  title: string;
  desc: string;
  deltaPct: number;
  time: string;
  spark: number[];
}

export interface EquityPoint {
  label: string;
  equity: number;
  pnl: number;
}
