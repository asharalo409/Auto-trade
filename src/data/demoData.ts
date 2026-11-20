import {
  BinanceConfig,
  BotSettings,
  CandlePoint,
  ChartTimeframe,
  EquityPoint,
  EquityTimeframe,
  LogEntry,
  PairMarketData,
  SmartAlert,
  TelegramConfig,
  Trade,
} from '../types/trading';

export const SUPPORTED_PAIRS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'TRXUSDT',
] as const;

export const BDT_PER_USD = 122.4;

export const SUPABASE_SQL_SCHEMA = `-- 1. SETTINGS TABLE
create table if not exists public.settings (
  id bigint primary key generated always as identity,
  bot_enabled boolean default false,
  is_running boolean default false,
  trading_mode text default 'live',
  virtual_balance numeric default 10000,
  amount_per_trade numeric default 10,
  take_profit_pct numeric default 2.4,
  stop_loss_enabled boolean default false,
  stop_loss_pct numeric default 1.5,
  sell_only_in_profit boolean default true,
  zero_loss_mode boolean default true,
  zero_loss_shield boolean default true,
  dca_enabled boolean default true,
  dca_step_pct numeric default 1.5,
  dca_max_buys integer default 12,
  auto_theme_by_time boolean default false,
  max_open_trades integer default 5,
  max_amount_per_pair numeric default 500,
  daily_loss_limit numeric default 150,
  mode text default 'LIVE',
  enabled_pairs jsonb default '["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT"]'::jsonb,
  telegram_enabled boolean default false,
  telegram_bot_token text,
  telegram_chat_id text,
  binance_api_key text,
  binance_api_secret text,
  use_testnet boolean default false,
  balance_usdt numeric default 0,
  last_heartbeat timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2. TRADES TABLE
create table if not exists public.trades (
  id text primary key,
  pair text not null,
  side text default 'BUY',
  status text default 'OPEN',
  entry_price numeric not null,
  current_price numeric not null,
  exit_price numeric,
  quantity numeric not null,
  invested_usdt numeric not null,
  profit_usdt numeric default 0,
  profit_pct numeric default 0,
  take_profit_price numeric,
  stop_loss_price numeric,
  opened_at timestamptz default now(),
  closed_at timestamptz,
  mode text default 'live'
);

-- 3. LOGS & ENGINE_LOGS TABLES
create table if not exists public.logs (
  id bigint primary key generated always as identity,
  level text default 'INFO',
  pair text,
  message text not null,
  created_at timestamptz default now()
);

create table if not exists public.engine_logs (
  id bigint primary key generated always as identity,
  level text default 'INFO',
  pair text,
  message text not null,
  created_at timestamptz default now()
);

-- 4. ENABLE REALTIME & ROW LEVEL SECURITY
alter publication supabase_realtime add table public.settings, public.trades, public.logs, public.engine_logs;
alter table public.settings enable row level security;
alter table public.trades enable row level security;
alter table public.logs enable row level security;
alter table public.engine_logs enable row level security;

create policy "Auth users full settings" on public.settings for all to authenticated using (true) with check (true);
create policy "Auth users full trades" on public.trades for all to authenticated using (true) with check (true);
create policy "Auth users full logs" on public.logs for all to authenticated using (true) with check (true);
create policy "Auth users full engine_logs" on public.engine_logs for all to authenticated using (true) with check (true);

insert into public.settings (bot_enabled, mode, zero_loss_mode, sell_only_in_profit)
select false, 'LIVE', true, true
where not exists (select 1 from public.settings);

-- 5. UPGRADE FOR 24/7 WORKER (safe to re-run on an existing project)
alter table public.settings add column if not exists is_running boolean default false;
alter table public.settings add column if not exists trading_mode text default 'live';
alter table public.settings add column if not exists virtual_balance numeric default 10000;
alter table public.settings add column if not exists telegram_bot_token text;
alter table public.settings add column if not exists telegram_chat_id text;
alter table public.trades add column if not exists mode text default 'live';`;

export const INITIAL_DEMO_SETTINGS: BotSettings = {
  id: 1,
  bot_enabled: true,
  amount_per_trade: 25,
  take_profit_pct: 2.4,
  stop_loss_enabled: false,
  stop_loss_pct: 1.5,
  sell_only_in_profit: true,
  zero_loss_mode: true,
  dca_enabled: true,
  dca_step_pct: 1.5,
  dca_max_buys: 12,
  auto_theme_by_time: false,
  max_open_trades: 5,
  max_amount_per_pair: 500,
  daily_loss_limit: 150,
  mode: 'DEMO',
  enabled_pairs: [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'ADAUSDT',
    'AVAXUSDT',
    'LINKUSDT',
  ],
  telegram_enabled: true,
  sound_enabled: true,
  theme: 'CYBER_CYAN',
  core_visual: 'torus',
  candle_style: 'japanese',
  last_heartbeat: new Date().toISOString(),
  balance_usdt: 10000.0,
};

export const INITIAL_LIVE_SETTINGS: BotSettings = {
  ...INITIAL_DEMO_SETTINGS,
  id: 2,
  bot_enabled: false,
  mode: 'LIVE',
  amount_per_trade: 10,
  balance_usdt: 0,
  last_heartbeat: new Date().toISOString(),
};

export const INITIAL_TELEGRAM_CONFIG: TelegramConfig = {
  bot_token: '',
  chat_id: '',
  notify_trades: true,
  notify_tp_sl: true,
  notify_status: true,
  notify_balance: true,
};

export const INITIAL_BINANCE_CONFIG: BinanceConfig = {
  api_key: '',
  api_secret: '',
  use_testnet: false,
  verified: false,
};

function generateSparkline(basePrice: number, trend: number) {
  const pts: { t: string; p: number }[] = [];
  let price = basePrice * (1 - trend * 0.008);
  for (let i = 0; i < 18; i++) {
    const wave = Math.sin(i * 0.65) * 0.004 + (trend >= 0 ? 0.0012 : -0.0012);
    price = Number((price * (1 + wave)).toFixed(basePrice > 10 ? 2 : 5));
    pts.push({ t: `${i}:00`, p: price });
  }
  pts[pts.length - 1].p = basePrice;
  return pts;
}

export const INITIAL_MARKET_PAIRS: PairMarketData[] = [
  {
    symbol: 'BTCUSDT',
    base: 'BTC',
    quote: 'USDT',
    price: 91420.5,
    change24h: 3.42,
    high24h: 92680.0,
    low24h: 88340.0,
    volume24h: 2480000000,
    baseVolume24h: 27127,
    inflowPct: 58.4,
    rsi14: 61.4,
    ema20: 90110.2,
    ema50: 88450.0,
    signal: 'BUY',
    perf: { today: 3.42, d7: 6.18, d30: 14.2, d90: 29.4 },
    sparkline: generateSparkline(91420.5, 1),
  },
  {
    symbol: 'ETHUSDT',
    base: 'ETH',
    quote: 'USDT',
    price: 3284.15,
    change24h: 2.18,
    high24h: 3340.0,
    low24h: 3185.4,
    volume24h: 1320000000,
    baseVolume24h: 401930,
    inflowPct: 54.1,
    rsi14: 58.2,
    ema20: 3240.0,
    ema50: 3175.4,
    signal: 'BUY',
    perf: { today: 2.18, d7: 4.85, d30: 9.7, d90: 18.6 },
    sparkline: generateSparkline(3284.15, 1),
  },
  {
    symbol: 'BNBUSDT',
    base: 'BNB',
    quote: 'USDT',
    price: 642.8,
    change24h: 0.84,
    high24h: 651.2,
    low24h: 632.0,
    volume24h: 412000000,
    baseVolume24h: 640945,
    inflowPct: 51.2,
    rsi14: 51.9,
    ema20: 639.5,
    ema50: 631.1,
    signal: 'HOLD',
    perf: { today: 0.84, d7: 2.1, d30: 5.4, d90: 14.1 },
    sparkline: generateSparkline(642.8, 0.4),
  },
  {
    symbol: 'SOLUSDT',
    base: 'SOL',
    quote: 'USDT',
    price: 214.62,
    change24h: 5.74,
    high24h: 218.9,
    low24h: 201.4,
    volume24h: 980000000,
    baseVolume24h: 4566210,
    inflowPct: 64.7,
    rsi14: 67.8,
    ema20: 205.3,
    ema50: 196.4,
    signal: 'BUY',
    perf: { today: 5.74, d7: 11.4, d30: 24.8, d90: 46.2 },
    sparkline: generateSparkline(214.62, 1.5),
  },
  {
    symbol: 'XRPUSDT',
    base: 'XRP',
    quote: 'USDT',
    price: 1.142,
    change24h: -1.65,
    high24h: 1.178,
    low24h: 1.124,
    volume24h: 560000000,
    baseVolume24h: 490367775,
    inflowPct: 44.3,
    rsi14: 43.1,
    ema20: 1.158,
    ema50: 1.132,
    signal: 'HOLD',
    perf: { today: -1.65, d7: -3.2, d30: 8.1, d90: 21.5 },
    sparkline: generateSparkline(1.142, -0.8),
  },
  {
    symbol: 'ADAUSDT',
    base: 'ADA',
    quote: 'USDT',
    price: 0.748,
    change24h: -3.28,
    high24h: 0.782,
    low24h: 0.741,
    volume24h: 295000000,
    baseVolume24h: 394385026,
    inflowPct: 38.6,
    rsi14: 34.7,
    ema20: 0.771,
    ema50: 0.785,
    signal: 'SELL',
    perf: { today: -3.28, d7: -5.9, d30: -1.4, d90: 11.2 },
    sparkline: generateSparkline(0.748, -1.3),
  },
  {
    symbol: 'DOGEUSDT',
    base: 'DOGE',
    quote: 'USDT',
    price: 0.3642,
    change24h: 4.19,
    high24h: 0.371,
    low24h: 0.345,
    volume24h: 740000000,
    baseVolume24h: 2031850631,
    inflowPct: 61.5,
    rsi14: 63.5,
    ema20: 0.351,
    ema50: 0.338,
    signal: 'BUY',
    perf: { today: 4.19, d7: 9.2, d30: 19.3, d90: 38.7 },
    sparkline: generateSparkline(0.3642, 1.1),
  },
  {
    symbol: 'AVAXUSDT',
    base: 'AVAX',
    quote: 'USDT',
    price: 38.94,
    change24h: -0.92,
    high24h: 39.85,
    low24h: 38.2,
    volume24h: 228000000,
    baseVolume24h: 5855161,
    inflowPct: 47.9,
    rsi14: 47.4,
    ema20: 39.25,
    ema50: 38.8,
    signal: 'HOLD',
    perf: { today: -0.92, d7: 1.3, d30: 6.8, d90: 15.4 },
    sparkline: generateSparkline(38.94, -0.5),
  },
  {
    symbol: 'LINKUSDT',
    base: 'LINK',
    quote: 'USDT',
    price: 17.85,
    change24h: 1.94,
    high24h: 18.12,
    low24h: 17.34,
    volume24h: 194000000,
    baseVolume24h: 10868347,
    inflowPct: 55.8,
    rsi14: 55.8,
    ema20: 17.42,
    ema50: 16.95,
    signal: 'BUY',
    perf: { today: 1.94, d7: 4.1, d30: 12.6, d90: 27.9 },
    sparkline: generateSparkline(17.85, 0.9),
  },
  {
    symbol: 'TRXUSDT',
    base: 'TRX',
    quote: 'USDT',
    price: 0.2145,
    change24h: -2.41,
    high24h: 0.221,
    low24h: 0.212,
    volume24h: 178000000,
    baseVolume24h: 829836829,
    inflowPct: 41.2,
    rsi14: 38.9,
    ema20: 0.219,
    ema50: 0.221,
    signal: 'SELL',
    perf: { today: -2.41, d7: -4.1, d30: 2.3, d90: 9.8 },
    sparkline: generateSparkline(0.2145, -1.0),
  },
];

export const INITIAL_SMART_ALERTS: SmartAlert[] = [
  {
    id: 'ALT-1',
    pair: 'SOLUSDT',
    title: 'Breakout Surge in 5m',
    desc: 'Volume 2.4x above 20-bar mean with clean EMA20 cross.',
    deltaPct: 5.74,
    time: 'Just now',
    spark: [204, 206, 205.5, 208.2, 211.1, 213.4, 214.6],
  },
  {
    id: 'ALT-2',
    pair: 'ADAUSDT',
    title: 'Small Drop in 3m',
    desc: 'Sharp dip probing lower Bollinger band — Zero-Loss Guard holding.',
    deltaPct: -3.28,
    time: '3m ago',
    spark: [0.778, 0.774, 0.769, 0.761, 0.755, 0.749, 0.748],
  },
  {
    id: 'ALT-3',
    pair: 'BTCUSDT',
    title: 'Whale Bid Wall Imbalance',
    desc: 'Spot bid depth +58.4% stronger than ask across top 10 levels.',
    deltaPct: 3.42,
    time: '6m ago',
    spark: [89400, 89920, 90150, 90640, 90980, 91210, 91420],
  },
];

export function generateCandlesForPair(
  pair: PairMarketData,
  timeframe: ChartTimeframe,
  count = 44
): CandlePoint[] {
  const stepMinutes =
    timeframe === '1M'
      ? 1
      : timeframe === '5M'
        ? 5
        : timeframe === '15M'
          ? 15
          : timeframe === '1H'
            ? 60
            : 240;

  const volatility =
    timeframe === '1M'
      ? 0.0022
      : timeframe === '5M'
        ? 0.0038
        : timeframe === '15M'
          ? 0.0058
          : timeframe === '1H'
            ? 0.0095
            : 0.015;

  const seed = pair.symbol.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const decimals = pair.price > 50 ? 2 : pair.price > 5 ? 3 : 5;
  const round = (v: number) => Number(v.toFixed(decimals));

  const raw: CandlePoint[] = [];
  let cursor = pair.price * (1 - (pair.change24h / 100) * 0.45);
  const nowMs = Date.now();

  for (let i = 0; i < count; i++) {
    const wave =
      Math.sin((i + seed) * 0.42) * volatility * 0.7 +
      Math.cos((i * 1.7 + seed) * 0.23) * volatility * 0.55;
    const trendBias = (pair.change24h >= 0 ? 1 : -1) * volatility * 0.14;

    const open = cursor;
    const close = i === count - 1 ? pair.price : Math.max(0.0001, open * (1 + wave + trendBias));
    const wickUp = Math.abs(Math.sin(i * 2.1 + seed)) * volatility * 0.65;
    const wickDown = Math.abs(Math.cos(i * 1.9 + seed)) * volatility * 0.65;
    const high = Math.max(open, close) * (1 + wickUp);
    const low = Math.min(open, close) * (1 - wickDown);
    const vol = Math.round(
      (pair.volume24h / 45000) * (0.65 + Math.abs(Math.sin(i * 1.3 + seed)))
    );

    const ts = new Date(nowMs - (count - 1 - i) * stepMinutes * 60_000);
    const label = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    raw.push({
      time: label,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: vol,
    });
    cursor = close;
  }

  // Compute MA7, MA25, EMA20, EMA50, BOLL(20, 2), and VWAP
  let ema20 = raw[0]?.close ?? pair.price;
  let ema50 = raw[0]?.close ?? pair.price;
  const k20 = 2 / 21;
  const k50 = 2 / 51;
  let cumPV = 0;
  let cumV = 0;

  return raw.map((c, idx) => {
    ema20 = c.close * k20 + ema20 * (1 - k20);
    ema50 = c.close * k50 + ema50 * (1 - k50);

    const slice7 = raw.slice(Math.max(0, idx - 6), idx + 1);
    const ma7 = slice7.reduce((s, p) => s + p.close, 0) / slice7.length;

    const slice25 = raw.slice(Math.max(0, idx - 24), idx + 1);
    const ma25 = slice25.reduce((s, p) => s + p.close, 0) / slice25.length;

    const slice20 = raw.slice(Math.max(0, idx - 19), idx + 1);
    const bbMid = slice20.reduce((s, p) => s + p.close, 0) / slice20.length;
    const variance =
      slice20.reduce((s, p) => s + Math.pow(p.close - bbMid, 2), 0) / slice20.length;
    const std = Math.sqrt(variance);

    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
    const vwap = cumV > 0 ? cumPV / cumV : c.close;

    return {
      ...c,
      ma7: round(ma7),
      ma25: round(ma25),
      ema20: round(ema20),
      ema50: round(ema50),
      bbUpper: round(bbMid + 2 * std),
      bbMid: round(bbMid),
      bbLower: round(bbMid - 2 * std),
      vwap: round(vwap),
    };
  });
}

export function toHeikinAshi(candles: CandlePoint[]): CandlePoint[] {
  if (!candles.length) return [];
  const result: CandlePoint[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen =
      i === 0 ? (c.open + c.close) / 2 : (result[i - 1].open + result[i - 1].close) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    result.push({
      ...c,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
    });
  }
  return result;
}

const now = Date.now();
const minAgo = (m: number) => new Date(now - m * 60_000).toISOString();
const hourAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

export const INITIAL_DEMO_TRADES: Trade[] = [
  {
    id: 'TRD-9041',
    pair: 'SOLUSDT',
    side: 'BUY',
    status: 'OPEN',
    entry_price: 210.85,
    current_price: 214.62,
    quantity: 0.474,
    invested_usdt: 100,
    profit_usdt: 1.79,
    profit_pct: 1.79,
    take_profit_price: 215.91,
    stop_loss_price: 207.69,
    opened_at: minAgo(18),
  },
  {
    id: 'TRD-9040',
    pair: 'BTCUSDT',
    side: 'BUY',
    status: 'OPEN',
    entry_price: 90480.0,
    current_price: 91420.5,
    quantity: 0.00276,
    invested_usdt: 250,
    profit_usdt: 2.6,
    profit_pct: 1.04,
    take_profit_price: 92651.5,
    stop_loss_price: 89122.8,
    opened_at: minAgo(47),
  },
  {
    id: 'TRD-9039',
    pair: 'ETHUSDT',
    side: 'BUY',
    status: 'OPEN',
    entry_price: 3251.4,
    current_price: 3284.15,
    quantity: 0.0307,
    invested_usdt: 100,
    profit_usdt: 1.01,
    profit_pct: 1.01,
    take_profit_price: 3329.43,
    stop_loss_price: 3202.63,
    opened_at: hourAgo(2),
  },
  {
    id: 'TRD-9037',
    pair: 'LINKUSDT',
    side: 'BUY',
    status: 'CLOSED',
    entry_price: 17.32,
    current_price: 17.74,
    exit_price: 17.74,
    quantity: 5.77,
    invested_usdt: 100,
    profit_usdt: 2.42,
    profit_pct: 2.42,
    take_profit_price: 17.74,
    stop_loss_price: 17.06,
    opened_at: hourAgo(5),
    closed_at: hourAgo(1),
  },
  {
    id: 'TRD-9036',
    pair: 'BTCUSDT',
    side: 'BUY',
    status: 'CLOSED',
    entry_price: 88920.0,
    current_price: 91060.0,
    exit_price: 91060.0,
    quantity: 0.00281,
    invested_usdt: 250,
    profit_usdt: 6.01,
    profit_pct: 2.41,
    take_profit_price: 91054.0,
    stop_loss_price: 87586.0,
    opened_at: hourAgo(10),
    closed_at: hourAgo(4),
  },
  {
    id: 'TRD-9035',
    pair: 'ETHUSDT',
    side: 'BUY',
    status: 'CLOSED',
    entry_price: 3186.2,
    current_price: 3271.85,
    exit_price: 3271.85,
    quantity: 0.0314,
    invested_usdt: 100,
    profit_usdt: 2.69,
    profit_pct: 2.69,
    take_profit_price: 3271.55,
    stop_loss_price: 3138.4,
    opened_at: hourAgo(16),
    closed_at: hourAgo(9),
  },
  {
    id: 'TRD-9034',
    pair: 'BNBUSDT',
    side: 'BUY',
    status: 'CLOSED',
    entry_price: 604.4,
    current_price: 597.05,
    exit_price: 597.05,
    quantity: 0.1655,
    invested_usdt: 100,
    profit_usdt: -1.22,
    profit_pct: -1.22,
    take_profit_price: 619.1,
    stop_loss_price: 595.0,
    opened_at: hourAgo(22),
    closed_at: hourAgo(14),
  },
];

export const INITIAL_DEMO_LOGS: LogEntry[] = [
  {
    id: 'LOG-1001',
    level: 'INFO',
    pair: null,
    message: 'Virtual simulator synced — 8/10 spot streams active, Zero-Loss Shield armed.',
    created_at: minAgo(28),
  },
  {
    id: 'LOG-1002',
    level: 'TRADE',
    pair: 'SOLUSDT',
    message: 'ENTRY BUY 0.474 SOL @ $210.85 | TP $215.91 (+2.40%) | Zero-Loss Guard ON',
    created_at: minAgo(18),
  },
  {
    id: 'LOG-1004',
    level: 'TRADE',
    pair: 'LINKUSDT',
    message: 'TAKE PROFIT HIT 5.77 LINK @ $17.74 | Realized +$2.42 USDT (+2.42%)',
    created_at: minAgo(7),
  },
];

export const INITIAL_LIVE_LOGS: LogEntry[] = [
  {
    id: 'LIVE-0001',
    level: 'INFO',
    pair: null,
    message: 'LIVE Production Workspace initialized. Balance starts at $0.00 until Binance keys sync.',
    created_at: minAgo(2),
  },
  {
    id: 'LIVE-0002',
    level: 'WARNING',
    pair: null,
    message: 'Execution engine STANDBY. Engage Bot ON in Command Center to start real trades.',
    created_at: minAgo(1),
  },
];

export const EQUITY_SERIES: Record<EquityTimeframe, EquityPoint[]> = {
  '1D': [
    { label: '00:00', equity: 9910, pnl: 0 },
    { label: '04:00', equity: 9928, pnl: 18 },
    { label: '08:00', equity: 9945, pnl: 35 },
    { label: '12:00', equity: 9972, pnl: 62 },
    { label: '16:00', equity: 9986, pnl: 76 },
    { label: '20:00', equity: 10000, pnl: 90 },
  ],
  '1W': [
    { label: 'Mon', equity: 9640, pnl: 0 },
    { label: 'Tue', equity: 9715, pnl: 75 },
    { label: 'Wed', equity: 9790, pnl: 150 },
    { label: 'Thu', equity: 9855, pnl: 215 },
    { label: 'Fri', equity: 9920, pnl: 280 },
    { label: 'Sat', equity: 9970, pnl: 330 },
    { label: 'Sun', equity: 10000, pnl: 360 },
  ],
  '1M': [
    { label: 'W1', equity: 8950, pnl: 0 },
    { label: 'W2', equity: 9280, pnl: 330 },
    { label: 'W3', equity: 9510, pnl: 560 },
    { label: 'W4', equity: 9780, pnl: 830 },
    { label: 'Now', equity: 10000, pnl: 1050 },
  ],
  ALL: [
    { label: 'Jul', equity: 7500, pnl: 0 },
    { label: 'Aug', equity: 8240, pnl: 740 },
    { label: 'Sep', equity: 8920, pnl: 1420 },
    { label: 'Oct', equity: 9480, pnl: 1980 },
    { label: 'Nov', equity: 10000, pnl: 2500 },
  ],
};
