import { CandlePoint, ChartTimeframe } from '../types/trading';

export const PUBLIC_BINANCE_REST_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
] as const;

export const BINANCE_WS_ENDPOINTS = [
  'wss://data-stream.binance.vision/ws',
  'wss://stream.binance.com:9443/ws',
] as const;

export function timeframeToBinanceInterval(tf: ChartTimeframe): string {
  switch (tf) {
    case '1M':
      return '1m';
    case '5M':
      return '5m';
    case '15M':
      return '15m';
    case '1H':
      return '1h';
    case '4H':
      return '4h';
    default:
      return '15m';
  }
}

export async function fetchBinancePublicJson<T>(pathAndQuery: string): Promise<T> {
  let lastError: unknown = null;
  for (const base of PUBLIC_BINANCE_REST_ENDPOINTS) {
    try {
      const res = await fetch(`${base}${pathAndQuery}`, {
        cache: 'no-store',
      });
      if (res.status === 418 || res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} from ${base}`);
        continue;
      }
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status} from ${base}`);
        continue;
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('All Binance public endpoints failed');
}

export interface Binance24hrRow {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
}

export async function fetchBinance24hrTickers(symbols: readonly string[]): Promise<Binance24hrRow[]> {
  const symbolsParam = encodeURIComponent(JSON.stringify(symbols));
  return fetchBinancePublicJson<Binance24hrRow[]>(`/api/v3/ticker/24hr?symbols=${symbolsParam}`);
}

export function attachCandleIndicators(raw: CandlePoint[]): CandlePoint[] {
  if (raw.length === 0) return [];
  const sampleClose = raw[raw.length - 1]?.close ?? 1;
  const decimals = sampleClose > 50 ? 2 : sampleClose > 5 ? 3 : 5;
  const round = (v: number) => Number(v.toFixed(decimals));

  let ema20 = raw[0].close;
  let ema50 = raw[0].close;
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

export async function fetchBinanceKlines(
  symbol: string,
  timeframe: ChartTimeframe,
  limit = 44
): Promise<CandlePoint[]> {
  const interval = timeframeToBinanceInterval(timeframe);
  const rows = await fetchBinancePublicJson<(string | number)[][]>(
    `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
  );
  const candles: CandlePoint[] = rows.map((k) => {
    const openTime = Number(k[0]);
    const label = new Date(openTime).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return {
      time: label,
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Math.round(Number(k[5])),
    };
  });
  return attachCandleIndicators(candles);
}

export interface BinanceDepthSnapshot {
  bids: [string, string][];
  asks: [string, string][];
}

export async function fetchBinanceDepth(
  symbol: string,
  limit = 10
): Promise<BinanceDepthSnapshot> {
  return fetchBinancePublicJson<BinanceDepthSnapshot>(
    `/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`
  );
}

/**
 * Opens a resilient WebSocket connection to Binance public streams with endpoint fallback.
 * Returns a cleanup function.
 */
export function openBinanceStream(
  streamPath: string,
  onMessage: (data: unknown) => void,
  onConnected?: () => void
): () => void {
  let closedByCaller = false;
  let endpointIdx = 0;
  let ws: WebSocket | null = null;
  let retryTimer: number | null = null;

  const connect = () => {
    if (closedByCaller || typeof WebSocket === 'undefined') return;
    const base = BINANCE_WS_ENDPOINTS[endpointIdx % BINANCE_WS_ENDPOINTS.length];
    try {
      ws = new WebSocket(`${base}/${streamPath}`);
    } catch {
      endpointIdx += 1;
      retryTimer = window.setTimeout(connect, 2500);
      return;
    }

    ws.onopen = () => {
      if (!closedByCaller) onConnected?.();
    };

    ws.onmessage = (evt) => {
      if (closedByCaller) return;
      try {
        const parsed = JSON.parse(String(evt.data));
        onMessage(parsed);
      } catch {
        // ignore malformed frames
      }
    };

    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (closedByCaller) return;
      endpointIdx += 1;
      retryTimer = window.setTimeout(connect, 3000);
    };
  };

  connect();

  return () => {
    closedByCaller = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    try {
      ws?.close();
    } catch {
      // ignore
    }
  };
}
