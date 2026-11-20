/**
 * Aegis Quant Terminal — 24/7 Render Execution Worker
 * Connects Supabase (settings/trades/logs) + Binance Spot API + Telegram Alerts
 * Binds an optional HTTP healthcheck port when process.env.PORT is set (Render Web Service compatible).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const ENV_BINANCE_KEY = (process.env.BINANCE_API_KEY || '').trim();
const ENV_BINANCE_SECRET = (process.env.BINANCE_API_SECRET || '').trim();
const ENV_TESTNET = (process.env.BINANCE_TESTNET || '').trim() === 'true';

const BINANCE_ROUND_TRIP_FEE_PCT = 0.2; // 0.1% Buy + 0.1% Sell Spot taker fees
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_MINI_APP_URL = (
  process.env.TELEGRAM_MINI_APP_URL || 'https://auto-trade-qxp7.onrender.com'
).trim();
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
// Attached to every outgoing alert (BUY / SELL / TP / SL / status) so the
// operator can jump straight from chat into the Mini App terminal.
const TELEGRAM_OPEN_TERMINAL_MARKUP = {
  inline_keyboard: [[{ text: '📊 Open Terminal', web_app: { url: TELEGRAM_MINI_APP_URL } }]],
};
const IPV4_REGEX = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})\b/;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[WORKER ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Optional CORS HTTP Server & API Endpoints
const PORT = Number(process.env.PORT || 10000);
if (PORT > 0) {
  http
    .createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MBX-APIKEY');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (req.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/api/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            service: 'aegis-quant-worker',
            status: 'ok',
            timestamp: new Date().toISOString(),
          })
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/api/verify-keys') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const apiKey = String(data.apiKey || data.api_key || '').trim();
            const apiSecret = String(data.apiSecret || data.api_secret || '').trim();
            const testnet = process.env.BINANCE_TESTNET === 'true' ? true : Boolean(data.testnet ?? data.use_testnet ?? false);

            if (!apiKey || !apiSecret) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Missing apiKey or apiSecret' }));
              return;
            }

            const portfolio = await fetchBinancePortfolioUsdt(apiKey, apiSecret, testnet);
            if (!portfolio) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Failed to verify Binance keys or fetch balance' }));
              return;
            }

            const { data: settingsRow } = await supabase.from('settings').select('id').limit(1).maybeSingle();
            if (settingsRow) {
              await supabase
                .from('settings')
                .update({
                  binance_api_key: apiKey,
                  binance_api_secret: apiSecret,
                  use_testnet: testnet,
                  balance_usdt: portfolio.total,
                  last_heartbeat: new Date().toISOString(),
                })
                .eq('id', settingsRow.id);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                usdtBalance: portfolio.total,
                totalPortfolioUsd: portfolio.total,
                usdtFree: portfolio.spot,
                spotUsd: portfolio.spot,
                fundingUsd: portfolio.funding,
                earnUsd: portfolio.earn,
                message: `Binance API verified successfully. Portfolio balance: $${portfolio.total.toFixed(2)} (Spot $${portfolio.spot.toFixed(2)})`,
              })
            );
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      if ((req.method === 'GET' || req.method === 'POST') && (pathname === '/api/balance' || pathname === '/api/binance/balance')) {
        try {
          const { data: settingsRow } = await supabase.from('settings').select('*').limit(1).maybeSingle();
          if (!settingsRow) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, usdtBalance: 0, totalUsdt: 0, totalPortfolioUsd: 0 }));
            return;
          }

          const apiKey = (ENV_BINANCE_KEY || settingsRow.binance_api_key || '').trim();
          const apiSecret = (ENV_BINANCE_SECRET || settingsRow.binance_api_secret || '').trim();
          const useTestnet = process.env.BINANCE_TESTNET === 'false' ? false : (ENV_TESTNET || Boolean(settingsRow.use_testnet));

          let spotUsdt = Number(settingsRow.balance_usdt || 0);
          let fundingUsd = 0;
          let earnUsd = 0;
          if (apiKey && apiSecret) {
            const portfolio = await fetchBinancePortfolioUsdt(apiKey, apiSecret, useTestnet);
            if (portfolio) {
              spotUsdt = portfolio.spot;
              fundingUsd = portfolio.funding;
              earnUsd = portfolio.earn;
            }
          }
          const totalPortfolioUsd = Number((spotUsdt + fundingUsd + earnUsd).toFixed(2));
          const walletBreakdown = [
            { walletName: 'Spot', balanceUsd: spotUsdt },
            { walletName: 'Funding', balanceUsd: fundingUsd },
            { walletName: 'Earn', balanceUsd: earnUsd },
          ].filter((w) => w.balanceUsd > 0);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              usdtBalance: totalPortfolioUsd,
              usdtFree: spotUsdt,
              totalUsdt: totalPortfolioUsd,
              totalPortfolioUsd,
              spotUsd: spotUsdt,
              fundingUsd,
              earnUsd,
              walletBreakdown,
              assets: [],
            })
          );
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // Manual execution from the Mini App / web terminal: a real signed Binance Spot
      // MARKET order. The exchange decides the fill; the caller records that fill only.
      if (req.method === 'POST' && pathname === '/api/order') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const { data: settingsRow } = await supabase.from('settings').select('*').limit(1).maybeSingle();
            const apiKey = (ENV_BINANCE_KEY || data.apiKey || settingsRow?.binance_api_key || '').trim();
            const apiSecret = (ENV_BINANCE_SECRET || data.apiSecret || settingsRow?.binance_api_secret || '').trim();
            const useTestnet =
              process.env.BINANCE_TESTNET === 'false'
                ? false
                : ENV_TESTNET || Boolean(data.testnet ?? data.useTestnet ?? settingsRow?.use_testnet);
            const symbol = String(data.symbol || '').trim().toUpperCase();
            const side = String(data.side || '').trim().toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
            const quoteOrderQty = Number(data.quoteOrderQty || 0);
            const quantity = Number(data.quantity || 0);

            if (!apiKey || !apiSecret) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Missing Binance API credentials' }));
              return;
            }
            if (!symbol) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Missing symbol' }));
              return;
            }
            if (side === 'BUY' && (!Number.isFinite(quoteOrderQty) || quoteOrderQty < BINANCE_MIN_ORDER_USDT)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: `Order notional must be at least $${BINANCE_MIN_ORDER_USDT.toFixed(2)} USDT`,
                })
              );
              return;
            }
            if (side === 'SELL' && (!Number.isFinite(quantity) || quantity <= 0)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Missing sell quantity' }));
              return;
            }

            const order = await placeBinanceMarketOrder(
              symbol,
              side,
              quoteOrderQty,
              quantity,
              apiKey,
              apiSecret,
              useTestnet
            );
            await appendLog(
              'TRADE',
              `[MANUAL] ${side} ${symbol} filled: qty ${order.executedQty} for ${order.cummulativeQuoteQty} USDT`,
              symbol
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, order }));
          } catch (err) {
            console.error('[MANUAL ORDER ERROR]', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    })
    .listen(PORT, '0.0.0.0', () => {
      console.log(`[WORKER] HTTP server listening on port ${PORT}`);
    });
}

async function sendTelegram(text, token, chatId, options = {}) {
  const t = (token || TELEGRAM_BOT_TOKEN || '').trim();
  const c = (chatId || TELEGRAM_CHAT_ID || '').trim();
  if (!t || !c) return false;
  const replyMarkup =
    options.replyMarkup === null ? null : options.replyMarkup || TELEGRAM_OPEN_TERMINAL_MARKUP;
  try {
    const res = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: c,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn('[TELEGRAM ERROR]', data?.description || `HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[TELEGRAM ERROR]', err.message);
    return false;
  }
}

function isMissingTableError(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    msg.includes('Could not find the table') ||
    msg.includes('does not exist')
  );
}

function isMissingPairColumnError(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    msg.includes("'pair'") ||
    msg.includes('column "pair"')
  );
}

async function insertLogIntoTable(tableName, level, message, pair) {
  const payload = pair ? { level, pair, message } : { level, message };
  let { error } = await supabase.from(tableName).insert(payload);
  if (error && pair && isMissingPairColumnError(error)) {
    ({ error } = await supabase.from(tableName).insert({ level, message }));
  }
  if (error && !isMissingTableError(error)) {
    console.warn(`[SUPABASE LOG WARNING] (${tableName}) ${error.message}`);
  }
}

async function appendLog(level, message, pair = null) {
  await Promise.allSettled([
    insertLogIntoTable('engine_logs', level, message, pair),
    insertLogIntoTable('logs', level, message, pair),
  ]);
}

async function fetchServerPublicIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      const match = String(data?.ip || '').trim().match(IPV4_REGEX);
      if (match) return match[1];
    }
  } catch (err) {
    console.warn('[IP LOOKUP WARNING] ipify.org failed:', err.message);
  }

  try {
    const res = await fetch('https://ifconfig.me/ip', {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      const match = text.match(IPV4_REGEX);
      if (match) return match[1];
    }
  } catch (err) {
    console.warn('[IP LOOKUP WARNING] ifconfig.me failed:', err.message);
  }

  return null;
}

async function logServerPublicIp() {
  const ip = await fetchServerPublicIp();
  if (ip) {
    const line = `[SERVER PUBLIC IP] ${ip}`;
    console.log(line);
    await appendLog('INFO', line);
    return ip;
  }
  const warnLine = '[SERVER PUBLIC IP] Unavailable';
  console.warn(warnLine);
  await appendLog('WARNING', warnLine);
  return null;
}

function signBinanceQuery(queryString, apiSecret) {
  return crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');
}

async function fetchPublicWithFallback(pathAndQuery, useTestnet) {
  const endpoints = useTestnet
    ? ['https://testnet.binance.vision']
    : [
        'https://data-api.binance.vision',
        'https://api1.binance.com',
        'https://api2.binance.com',
        'https://api3.binance.com',
      ];

  let lastErr = null;
  for (const base of endpoints) {
    try {
      const res = await fetch(`${base}${pathAndQuery}`);
      if (res.status === 418 || res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Binance public HTTP ${res.status} (${base})`);
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`Binance public HTTP ${res.status} (${base})`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All public Binance market endpoints failed');
}

async function signedBinanceRequest(method, path, apiKey, apiSecret, useTestnet, extraParams = {}) {
  if (!apiKey || !apiSecret) {
    throw new Error('Binance API credentials missing');
  }

  const endpoints = useTestnet
    ? ['https://testnet.binance.vision']
    : ['https://api1.binance.com', 'https://api2.binance.com', 'https://api3.binance.com'];

  let lastErr = null;
  for (const base of endpoints) {
    try {
      const params = new URLSearchParams({
        ...extraParams,
        recvWindow: '15000',
        timestamp: String(Date.now()),
      });
      const sig = signBinanceQuery(params.toString(), apiSecret);
      params.set('signature', sig);

      const res = await fetch(`${base}${path}?${params.toString()}`, {
        method,
        headers: { 'X-MBX-APIKEY': apiKey },
      });

      if (res.status === 418 || res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Binance signed HTTP ${res.status} (${base})`);
        continue;
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.msg || `Binance HTTP ${res.status}`);
      }
      return data;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      if (!msg.includes('HTTP 418') && !msg.includes('HTTP 429') && !msg.includes('HTTP 5')) {
        throw err;
      }
    }
  }
  throw lastErr || new Error('All Binance signed endpoints failed');
}

async function fetchBinancePrices(symbols, useTestnet) {
  if (!symbols || symbols.length === 0) return {};
  const param = encodeURIComponent(JSON.stringify(symbols));
  const rows = await fetchPublicWithFallback(`/api/v3/ticker/price?symbols=${param}`, useTestnet);
  const map = {};
  for (const row of rows) {
    map[row.symbol] = Number(row.price);
  }
  return map;
}

async function fetchBinanceSpotUsdtBalance(apiKey, apiSecret, useTestnet) {
  if (!apiKey || !apiSecret) return null;
  const account = await signedBinanceRequest('GET', '/api/v3/account', apiKey, apiSecret, useTestnet);
  if (!account || !Array.isArray(account.balances)) return null;
  const usdt = account.balances.find((b) => b.asset === 'USDT');
  if (!usdt) return 0;
  return Number((Number(usdt.free || 0) + Number(usdt.locked || 0)).toFixed(2));
}

async function fetchBinanceFundingUsdt(apiKey, apiSecret, useTestnet) {
  if (useTestnet) return 0;
  try {
    const rows = await signedBinanceRequest('POST', '/sapi/v1/asset/get-funding-asset', apiKey, apiSecret, useTestnet, {});
    if (!Array.isArray(rows)) return 0;
    return rows
      .filter((r) => r.asset === 'USDT')
      .reduce(
        (sum, r) => sum + Number(r.free || 0) + Number(r.locked || 0) + Number(r.freeze || 0),
        0
      );
  } catch (err) {
    console.warn('[FUNDING WALLET WARNING]', err.message);
    return 0;
  }
}

async function fetchBinanceEarnUsdt(apiKey, apiSecret, useTestnet) {
  if (useTestnet) return 0;
  try {
    const data = await signedBinanceRequest('GET', '/sapi/v1/simple-earn/flexible/position', apiKey, apiSecret, useTestnet, { size: '50' });
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    return rows
      .filter((r) => r.asset === 'USDT')
      .reduce((sum, r) => sum + Number(r.totalAmount || 0), 0);
  } catch (err) {
    console.warn('[EARN WALLET WARNING]', err.message);
    return 0;
  }
}

/**
 * Full wallet total (Spot + Funding + Earn) so real money never reads as $0.00.
 * Returns null when the Spot account itself cannot be read (bad keys/IP block).
 */
async function fetchBinancePortfolioUsdt(apiKey, apiSecret, useTestnet) {
  const spot = await fetchBinanceSpotUsdtBalance(apiKey, apiSecret, useTestnet);
  if (spot === null) return null;
  const [funding, earn] = await Promise.all([
    fetchBinanceFundingUsdt(apiKey, apiSecret, useTestnet),
    fetchBinanceEarnUsdt(apiKey, apiSecret, useTestnet),
  ]);
  return {
    spot: Number(spot.toFixed(2)),
    funding: Number(funding.toFixed(2)),
    earn: Number(earn.toFixed(2)),
    total: Number((spot + funding + earn).toFixed(2)),
  };
}

async function placeBinanceMarketOrder(symbol, side, quoteOrderQty, quantity, apiKey, apiSecret, useTestnet) {
  const params = {
    symbol,
    side,
    type: 'MARKET',
  };
  if (side === 'BUY') {
    params.quoteOrderQty = Number(quoteOrderQty).toFixed(2);
  } else {
    params.quantity = Number(quantity).toFixed(5);
  }
  return signedBinanceRequest('POST', '/api/v3/order', apiKey, apiSecret, useTestnet, params);
}

// Binance rejects any Spot order below the symbol's MIN_NOTIONAL (usually $5) with
// "Filter failure: NOTIONAL" and below LOT_SIZE stepSize with "Filter failure: LOT_SIZE".
// These helpers keep every live entry compliant instead of aborting the whole cycle.
const BINANCE_MIN_ORDER_USDT = 5.5;
let exchangeFiltersCache = { at: 0, data: null };
const lastWarnAt = new Map();

async function warnThrottled(key, message, pair = null, cfg = null) {
  const now = Date.now();
  if (now - (lastWarnAt.get(key) || 0) < 10 * 60_000) return;
  lastWarnAt.set(key, now);
  console.warn(message);
  await appendLog('WARNING', cfg ? `[${MODE_LABEL[cfg.mode]}] ${message}` : message, pair);
  if (cfg) await sendWarningTelegram(cfg, message);
}

async function getSymbolFilters(symbol, useTestnet) {
  const fallback = { stepSize: 0, minQty: 0, minNotional: BINANCE_MIN_ORDER_USDT };
  if (!exchangeFiltersCache.data || Date.now() - exchangeFiltersCache.at > 6 * 3600_000) {
    try {
      const info = await fetchPublicWithFallback('/api/v3/exchangeInfo', useTestnet);
      const map = {};
      for (const s of info.symbols || []) {
        const filters = s.filters || [];
        const lot = filters.find((f) => f.filterType === 'LOT_SIZE');
        const notional =
          filters.find((f) => f.filterType === 'MIN_NOTIONAL') ||
          filters.find((f) => f.filterType === 'NOTIONAL');
        map[s.symbol] = {
          stepSize: Number(lot?.stepSize || 0),
          minQty: Number(lot?.minQty || 0),
          minNotional: Number(notional?.minNotional || notional?.notional || 5),
        };
      }
      exchangeFiltersCache = { at: Date.now(), data: map };
    } catch (err) {
      console.warn('[FILTERS] exchangeInfo unavailable, using defaults:', err.message);
      return fallback;
    }
  }
  return exchangeFiltersCache.data[symbol] || fallback;
}

function floorToStep(qty, stepSize) {
  if (!stepSize || stepSize <= 0) return Number(qty.toFixed(8));
  const decimals = Math.max(0, Math.round(-Math.log10(stepSize)));
  return Number((Math.floor(qty / stepSize) * stepSize).toFixed(decimals));
}

/**
 * Places a MIN_NOTIONAL/LOT_SIZE-compliant live BUY, or logs one throttled warning
 * and returns null. Never throws, so one rejected order cannot abort the whole cycle.
 *
 * The order size is NEVER silently resized. If the operator's lot is below the
 * exchange minimum we skip the entry and say so in the log + Telegram, so the
 * Settings value, the trade record and the exchange order always agree.
 */
async function buyWithGuards(symbol, label, quoteQty, livePx, apiKey, apiSecret, useTestnet, availableUsdt, cfg = null) {
  const filters = await getSymbolFilters(symbol, useTestnet);
  const requested = Math.max(1, Number(quoteQty) || 1);
  const minNotional = Math.max(filters.minNotional || 0, BINANCE_MIN_ORDER_USDT);
  const available = Number.isFinite(availableUsdt) ? availableUsdt : 0;

  if (requested < minNotional) {
    await warnThrottled(
      `lot-below-min-${symbol}`,
      `LIVE ${label} SKIPPED ${symbol} — your lot is $${requested.toFixed(2)} but Binance Spot requires at least $${minNotional.toFixed(2)}. Raise "Amount Per Trade" in Settings (no order was placed and nothing was resized).`,
      symbol,
      cfg
    );
    return null;
  }
  const notional = requested;

  if (available < notional) {
    await warnThrottled(
      `no-funds-${symbol}`,
      available <= 0
        ? `LIVE ${label} SKIPPED ${symbol} — Binance Spot USDT is $0.00. Transfer USDT to your Spot wallet (Funding/Earn balances cannot be traded) and press Sync Balance.`
        : `LIVE ${label} SKIPPED ${symbol} — needs $${notional.toFixed(2)} but Spot has $${available.toFixed(2)} available.`,
      symbol,
      cfg
    );
    return null;
  }

  let qty = floorToStep(notional / livePx, filters.stepSize);
  if (!Number.isFinite(qty) || qty <= 0) {
    qty = filters.minQty > 0 ? floorToStep(filters.minQty, filters.stepSize) || filters.minQty : 0;
  }
  if (!qty) return null;

  try {
    const order = await placeBinanceMarketOrder(symbol, 'BUY', notional, qty, apiKey, apiSecret, useTestnet);
    return {
      filledQty: Number(order?.executedQty) || qty,
      notional: Number(order?.cummulativeQuoteQty) || notional,
    };
  } catch (err) {
    await warnThrottled(
      `order-failed-${symbol}`,
      `LIVE ${label} REJECTED ${symbol}: ${err.message} — skipped this cycle (no phantom trade created).`,
      symbol,
      cfg
    );
    return null;
  }
}

let lastLoggedBalance = null;

const MODE_LABEL = { live: 'LIVE', virtual: 'DEMO' };

function normalizeTradingMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'live' || v === 'real' ? 'live' : 'virtual';
}

function normalizePairList(raw) {
  if (Array.isArray(raw)) return raw.map((p) => String(p).trim().toUpperCase()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((p) => String(p).trim().toUpperCase()).filter(Boolean);
    } catch {
      return raw.split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
    }
  }
  return ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
}

/**
 * Everything the 15s cycle needs comes from the Supabase settings row, so the bot
 * keeps running with zero browser tabs open. `is_running`/`trading_mode` are the
 * canonical columns; the legacy `bot_enabled`/`mode` pair is still honoured.
 */
function resolveTradingConfig(settings) {
  const zeroLoss = Boolean(
    settings.zero_loss_shield ?? settings.zero_loss_mode ?? settings.sell_only_in_profit ?? true
  );
  const runFlag = settings.is_running ?? settings.engine_running;
  const isRunning =
    runFlag === null || runFlag === undefined ? Boolean(settings.bot_enabled) : Boolean(runFlag);
  return {
    isRunning,
    mode: normalizeTradingMode(
      settings.workspace_mode ?? settings.trading_mode ?? settings.mode
    ),
    telegramEnabled: settings.telegram_enabled !== false,
    telegramToken: String(
      settings.telegram_bot_token || settings.bot_token || TELEGRAM_BOT_TOKEN || ''
    ).trim(),
    telegramChatId: String(settings.telegram_chat_id || settings.chat_id || TELEGRAM_CHAT_ID || '').trim(),
    lotRequested: Math.max(1, Number(settings.trade_amount ?? settings.amount_per_trade ?? 10)),
    pairs: normalizePairList(settings.enabled_pairs),
    tpPct: Number(settings.take_profit_pct || 2.4),
    dcaEnabled: settings.dca_enabled !== false,
    dcaStepPct: Math.max(0.2, Number(settings.dca_step_pct || 1.5)),
    dcaMaxBuys: Math.max(1, Number(settings.dca_max_buys || 12)),
    zeroLoss,
    stopLossPct: Math.abs(Number(settings.stop_loss_pct || 1.5)),
    stopLossEnabled: !zeroLoss && Boolean(settings.stop_loss_enabled),
    maxPerPair: Number(settings.max_amount_per_pair || 500),
    maxOpenTrades: Math.max(1, Number(settings.max_open_trades || 5)),
    trailingStopPct: Math.max(0, Number(settings.trailing_stop_pct ?? 1.5)),
    dailyMaxLossPct: Math.max(0, Number(settings.daily_max_loss_pct ?? 5)),
  };
}

/** Rows written before the `mode` column existed are still separable by id prefix. */
function tradeModeOf(row) {
  const declared = String(row?.mode ?? row?.trading_mode ?? '').trim().toLowerCase();
  if (declared === 'live' || declared === 'virtual') return declared;
  return String(row?.id ?? '').startsWith('VDEMO-') ? 'virtual' : 'live';
}

function isMissingColumnError(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return error.code === '42703' || error.code === 'PGRST204' || msg.includes('column');
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

async function sendTradeTelegram(cfg, details) {
  if (!cfg.telegramEnabled || !cfg.telegramToken || !cfg.telegramChatId) return;
  const label = MODE_LABEL[cfg.mode];
  const lines = [
    `<b>[${label}] ${details.title}</b>`,
    `Pair: <b>${details.symbol}</b> · ${details.side}`,
    `Price: ${money(details.price)}`,
    `Amount: ${money(details.amountUsd)} USDT`,
  ];
  if (details.pnlUsdt !== undefined && details.pnlUsdt !== null) {
    const pnl = Number(details.pnlUsdt);
    const pct = details.pnlPct === undefined ? null : Number(details.pnlPct);
    lines.push(
      `P&L: ${pnl >= 0 ? '+' : ''}${money(pnl)}${
        pct === null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`
      }`
    );
  }
  lines.push(
    `Balance: ${money(details.balanceUsd)} ${cfg.mode === 'live' ? '(Spot portfolio)' : '(virtual)'}`
  );
  if (details.note) lines.push(details.note);
  lines.push(`🕒 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  await sendTelegram(lines.join('\n'), cfg.telegramToken, cfg.telegramChatId);
}

async function sendWarningTelegram(cfg, message) {
  if (!cfg.telegramEnabled || !cfg.telegramToken || !cfg.telegramChatId) return;
  await sendTelegram(
    `<b>[AEGIS ${MODE_LABEL[cfg.mode]}] ⚠️ WARNING</b>\n${message}`,
    cfg.telegramToken,
    cfg.telegramChatId
  );
}

/* ------------------------------------------------------------------------- *
 * Midnight daily PnL report — 00:00 Asia/Dhaka (18:00 UTC)
 * ------------------------------------------------------------------------- */

const BDT_PER_USD = 122.4;
const DHAKA_OFFSET_MS = 6 * 3600_000;

/** Start of the current Asia/Dhaka day, expressed as a UTC Date. */
function dhakaDayStartUtc(now = new Date()) {
  const dhaka = new Date(now.getTime() + DHAKA_OFFSET_MS);
  dhaka.setUTCHours(0, 0, 0, 0);
  return new Date(dhaka.getTime() - DHAKA_OFFSET_MS);
}

function dhakaDateKey(now = new Date()) {
  return new Date(now.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

let lastDailyReportKey = null;

async function sendDailyPnlReport() {
  const settings = await fetchSettingsRow();
  if (!settings) return false;
  const cfg = resolveTradingConfig(settings);

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: rows } = await supabase
    .from('trades')
    .select('*')
    .eq('status', 'CLOSED')
    .gte('closed_at', since);
  const closed = (rows || []).filter((row) => tradeModeOf(row) === cfg.mode);
  const totalTrades = closed.length;
  const wins = closed.filter((row) => Number(row.profit_usdt || 0) > 0).length;
  const losses = Math.max(0, totalTrades - wins);
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const realized = closed.reduce((sum, row) => sum + Number(row.profit_usdt || 0), 0);

  let liveSpot = Number(settings.balance_usdt || 0);
  let liveTotal = liveSpot;
  const apiKey = (ENV_BINANCE_KEY || settings.binance_api_key || '').trim();
  const apiSecret = (ENV_BINANCE_SECRET || settings.binance_api_secret || '').trim();
  const useTestnet =
    process.env.BINANCE_TESTNET === 'false' ? false : ENV_TESTNET || Boolean(settings.use_testnet);
  if (apiKey && apiSecret) {
    try {
      const portfolio = await fetchBinancePortfolioUsdt(apiKey, apiSecret, useTestnet);
      if (portfolio) {
        liveSpot = portfolio.spot;
        liveTotal = portfolio.total;
      }
    } catch (err) {
      console.warn('[DAILY REPORT] Portfolio sync skipped:', err.message);
    }
  }

  const virtualBalance = readVirtualBalance(settings);
  const bdtRealized = Math.round(realized * BDT_PER_USD);
  const bdtLive = Math.round(liveTotal * BDT_PER_USD);
  const bdtVirtual = Math.round(virtualBalance * BDT_PER_USD);

  const lines = [
    '<b>📊 AEGIS DAILY REPORT</b>',
    `🗓 ${dhakaDateKey()} · Asia/Dhaka · past 24h`,
    `🎛 Workspace: <b>${MODE_LABEL[cfg.mode]}</b> · Engine ${
      cfg.isRunning ? '🟢 RUNNING' : '⚪ STOPPED'
    }`,
    '',
    `📈 Trades closed: <b>${totalTrades}</b>`,
    `✅ Win rate: <b>${winRate.toFixed(1)}%</b> (${wins}W / ${losses}L)`,
    `💰 Realized PnL: <b>${realized >= 0 ? '+' : ''}$${realized.toFixed(2)}</b> (৳${bdtRealized.toLocaleString(
      'en-US'
    )})`,
    '',
    `🏦 Live portfolio: $${liveTotal.toFixed(2)} · tradeable Spot $${liveSpot.toFixed(2)} (৳${bdtLive.toLocaleString(
      'en-US'
    )})`,
    `🧪 Virtual balance: $${virtualBalance.toFixed(2)} (৳${bdtVirtual.toLocaleString('en-US')})`,
  ];

  if (!cfg.telegramEnabled) return false;
  await sendTelegram(lines.join('\n'), cfg.telegramToken, cfg.telegramChatId);
  await appendLog(
    'INFO',
    `[${MODE_LABEL[cfg.mode]}] Daily report sent — ${totalTrades} trades, ${winRate.toFixed(
      1
    )}% win rate, realized $${realized.toFixed(2)}.`
  );
  return true;
}

/** Fires once per Dhaka day during the first ten minutes after local midnight. */
async function dailyReportLoop() {
  try {
    const dhaka = new Date(Date.now() + DHAKA_OFFSET_MS);
    if (dhaka.getUTCHours() !== 0 || dhaka.getUTCMinutes() > 10) return;
    const key = dhakaDateKey();
    if (lastDailyReportKey === key) return;
    lastDailyReportKey = key;
    console.log(`[DAILY REPORT] Sending midnight summary for ${key}`);
    await sendDailyPnlReport();
  } catch (err) {
    console.warn('[DAILY REPORT ERROR]', err.message);
  }
}

/* ------------------------------------------------------------------------- *
 * Telegram command bridge for @TaseenMarketBot
 * Long-polls getUpdates with offset tracking, accepts commands only from the
 * authorized TELEGRAM_CHAT_ID, and mutates the same Supabase settings row the
 * 24/7 worker and web terminal already read — so chat commands and the UI stay
 * in lockstep. Every reply carries the "Open Terminal" Mini App button.
 * ------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let telegramUpdateOffset = 0;
let telegramOffsetInitialised = false;
let telegramPolling = false;
let telegramBridgeCache = null;

async function fetchSettingsRow() {
  const { data, error } = await supabase.from('settings').select('*').limit(1).maybeSingle();
  if (error) {
    console.warn('[TELEGRAM BOT] Could not read settings:', error.message);
    return null;
  }
  return data || null;
}

async function resolveTelegramBridge() {
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    return { token: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID };
  }
  if (telegramBridgeCache?.token && telegramBridgeCache?.chatId) return telegramBridgeCache;
  const settings = await fetchSettingsRow();
  telegramBridgeCache = {
    token: (TELEGRAM_BOT_TOKEN || settings?.telegram_bot_token || settings?.bot_token || '').trim(),
    chatId: (TELEGRAM_CHAT_ID || settings?.telegram_chat_id || settings?.chat_id || '').trim(),
  };
  return telegramBridgeCache;
}

async function telegramApiCall(token, method, payload, timeoutMs) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs || 30_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && data?.ok !== false, data };
}

/**
 * Writes a settings patch, degrading to per-column writes when the Supabase
 * schema predates some canonical columns (`engine_running`, `workspace_mode`).
 */
async function updateSettingsWithFallback(settingsId, patch) {
  const full = await supabase.from('settings').update(patch).eq('id', settingsId);
  if (!full.error) return { ok: true, applied: Object.keys(patch), skipped: [] };
  if (!isMissingColumnError(full.error)) {
    return { ok: false, applied: [], skipped: [], error: full.error.message };
  }

  const applied = [];
  const skipped = [];
  for (const [column, value] of Object.entries(patch)) {
    const { error } = await supabase
      .from('settings')
      .update({ [column]: value })
      .eq('id', settingsId);
    if (error) skipped.push(column);
    else applied.push(column);
  }
  return { ok: applied.length > 0, applied, skipped };
}

function settingsModeLabel(settings) {
  const raw = String(
    settings?.workspace_mode ?? settings?.trading_mode ?? settings?.mode ?? 'live'
  )
    .trim()
    .toLowerCase();
  return raw === 'live' || raw === 'real' ? 'LIVE' : 'VIRTUAL';
}

async function handleTelegramCommand(rawText, token, chatId, operatorName) {
  const command = String(rawText || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/@[a-z0-9_]+$/i, '');

  const settings = await fetchSettingsRow();
  if (!settings) {
    await sendTelegram('⚠️ Aegis Quant: Supabase settings row not found — command ignored.', token, chatId);
    return;
  }

  switch (command) {
    case '/start':
    case '/help': {
      await sendTelegram(
        [
          '<b>🛡️ AEGIS QUANT — COMMAND MENU</b>',
          '',
          '/balance — live Spot USDT + virtual demo balance',
          '/status — engine state, workspace mode, open positions',
          '/start_bot — start the 24/7 engine (LIVE or VIRTUAL)',
          '/stop_bot — pause trading immediately',
          '/mode_live — switch the workspace to LIVE Binance Spot',
          '/mode_demo — switch the workspace to VIRTUAL demo',
          '',
          `Operator: <b>${operatorName}</b>`,
        ].join('\n'),
        token,
        chatId
      );
      return;
    }

    case '/balance': {
      const apiKey = (ENV_BINANCE_KEY || settings.binance_api_key || '').trim();
      const apiSecret = (ENV_BINANCE_SECRET || settings.binance_api_secret || '').trim();
      const useTestnet =
        process.env.BINANCE_TESTNET === 'false'
          ? false
          : ENV_TESTNET || Boolean(settings.use_testnet);
      let liveSpot = Number(settings.balance_usdt || 0);
      let note = '';
      if (apiKey && apiSecret) {
        try {
          const portfolio = await fetchBinancePortfolioUsdt(apiKey, apiSecret, useTestnet);
          if (portfolio) {
            liveSpot = portfolio.spot;
            note = `\n<i>Spot $${portfolio.spot.toFixed(2)} · Funding $${portfolio.funding.toFixed(2)} · Earn $${portfolio.earn.toFixed(2)}</i>`;
          } else {
            note = '\n<i>Binance balance unavailable — check API keys and server IP access.</i>';
          }
        } catch (err) {
          note = `\n<i>Binance balance unavailable: ${err.message}</i>`;
        }
      } else {
        note = '\n<i>No Binance API keys linked.</i>';
      }
      const virtualBalance = readVirtualBalance(settings);
      await sendTelegram(
        [
          '💰 <b>ACCOUNT BALANCES</b>',
          `• Live Spot USDT: $${Number(liveSpot || 0).toFixed(2)}`,
          `• Virtual Demo USDT: $${Number(virtualBalance || 0).toFixed(2)}`,
          note,
        ].join('\n'),
        token,
        chatId
      );
      return;
    }

    case '/status': {
      const engineRunning =
        settings.is_running === null || settings.is_running === undefined
          ? Boolean(settings.engine_running ?? settings.bot_enabled)
          : Boolean(settings.is_running);
      const modeLabel = settingsModeLabel(settings);
      const { data: openRows, error: openErr } = await supabase
        .from('trades')
        .select('*')
        .eq('status', 'OPEN');
      const openCount = openErr
        ? 0
        : (openRows || []).filter(
            (row) => tradeModeOf(row) === (modeLabel === 'LIVE' ? 'live' : 'virtual')
          ).length;
      const lastCycle = settings.last_heartbeat
        ? new Date(settings.last_heartbeat).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
        : 'never';
      await sendTelegram(
        [
          '📊 <b>AEGIS QUANT STATUS</b>',
          `• Engine: <b>${engineRunning ? 'RUNNING' : 'STOPPED'}</b>`,
          `• Workspace mode: <b>${modeLabel}</b>`,
          `• Open positions: <b>${openCount}</b>`,
          `• Last cycle: ${lastCycle}`,
        ].join('\n'),
        token,
        chatId
      );
      return;
    }

    case '/start_bot': {
      const modeLabel = settingsModeLabel(settings);
      const result = await updateSettingsWithFallback(settings.id, {
        engine_running: true,
        is_running: true,
        bot_enabled: true,
      });
      if (!result.ok) {
        await sendTelegram(
          `⚠️ Could not start the engine: ${result.error || 'no writable settings column'}.`,
          token,
          chatId
        );
        return;
      }
      await appendLog('INFO', `[TELEGRAM] Engine STARTED by ${operatorName} (Mode: ${modeLabel}).`);
      await sendTelegram(
        `✅ <b>Aegis Quant Engine STARTED</b> (Mode: ${modeLabel}).`,
        token,
        chatId
      );
      return;
    }

    case '/stop_bot': {
      const result = await updateSettingsWithFallback(settings.id, {
        engine_running: false,
        is_running: false,
        bot_enabled: false,
      });
      if (!result.ok) {
        await sendTelegram(
          `⚠️ Could not stop the engine: ${result.error || 'no writable settings column'}.`,
          token,
          chatId
        );
        return;
      }
      await appendLog('INFO', `[TELEGRAM] Engine STOPPED by ${operatorName}.`);
      await sendTelegram('🛑 <b>Aegis Quant Engine STOPPED.</b>', token, chatId);
      return;
    }

    case '/mode_live':
    case '/mode_demo': {
      const nextMode = command === '/mode_live' ? 'live' : 'virtual';
      const modeLabel = nextMode === 'live' ? 'LIVE' : 'VIRTUAL';
      const result = await updateSettingsWithFallback(settings.id, {
        workspace_mode: nextMode,
        trading_mode: nextMode,
        mode: nextMode,
      });
      if (!result.ok) {
        await sendTelegram(
          `⚠️ Could not switch workspace: ${result.error || 'no writable settings column'}.`,
          token,
          chatId
        );
        return;
      }
      await appendLog('INFO', `[TELEGRAM] Workspace switched to ${modeLabel} by ${operatorName}.`);
      await sendTelegram(
        `✅ <b>Workspace switched to ${modeLabel}</b>${
          nextMode === 'live' ? ' — Binance Spot (real money).' : ' — paper demo engine.'
        }`,
        token,
        chatId
      );
      return;
    }

    default:
      if (command.startsWith('/')) {
        await sendTelegram(
          `Unknown command: <code>${command}</code>\nSend /help to see the menu.`,
          token,
          chatId
        );
      }
  }
}

async function pollTelegramUpdates() {
  if (telegramPolling) return;
  telegramPolling = true;
  try {
    const { token, chatId } = await resolveTelegramBridge();
    if (!token || !chatId) return;

    // Skip the backlog once at boot so a restart never replays days-old commands.
    if (!telegramOffsetInitialised) {
      const probe = await telegramApiCall(
        token,
        'getUpdates',
        { offset: -1, limit: 1, timeout: 0 },
        15_000
      );
      const results = Array.isArray(probe.data?.result) ? probe.data.result : [];
      const lastId = Number(results[results.length - 1]?.update_id);
      telegramUpdateOffset = Number.isFinite(lastId) ? lastId + 1 : 0;
      telegramOffsetInitialised = true;
    }

    const { status, data } = await telegramApiCall(
      token,
      'getUpdates',
      {
        offset: telegramUpdateOffset,
        timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
        limit: 20,
        allowed_updates: ['message'],
      },
      (TELEGRAM_POLL_TIMEOUT_SECONDS + 20) * 1000
    );

    if (status === 409) {
      console.warn('[TELEGRAM BOT] 409 Conflict — another poller is active. Backing off 30s.');
      await sleep(30_000);
      return;
    }
    if (!data?.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      const updateId = Number(update?.update_id);
      if (Number.isFinite(updateId)) {
        telegramUpdateOffset = Math.max(telegramUpdateOffset, updateId + 1);
      }
      const message = update?.message;
      const text = String(message?.text || '').trim();
      if (!text) continue;

      const incomingChatId = String(message?.chat?.id ?? '').trim();
      if (incomingChatId !== chatId) {
        console.warn(`[TELEGRAM BOT] Ignored command from unauthorized chat ${incomingChatId || 'unknown'}.`);
        continue;
      }

      console.log(`[TELEGRAM BOT] Command from ${incomingChatId}: ${text}`);
      await handleTelegramCommand(
        text,
        token,
        incomingChatId,
        String(message?.from?.first_name || 'Operator')
      );
    }
  } catch (err) {
    const msg = String(err?.message || err);
    if (!msg.toLowerCase().includes('timeout') && !msg.toLowerCase().includes('abort')) {
      console.warn('[TELEGRAM BOT] Poll failed:', msg);
      await sleep(5_000);
    }
  } finally {
    telegramPolling = false;
  }
}

async function startTelegramCommandLoop() {
  const { token, chatId } = await resolveTelegramBridge();
  if (!token || !chatId) {
    console.warn(
      '[TELEGRAM BOT] Command listener idle — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured yet. Retrying in 60s.'
    );
    setTimeout(() => void startTelegramCommandLoop(), 60_000).unref?.();
    return;
  }
  console.log('[TELEGRAM BOT] Command listener online — long polling, authorized chat only.');
  for (;;) {
    await pollTelegramUpdates();
    await sleep(1_200);
  }
}

function buildTradeRow({ mode, symbol, price, quantity, notional, tpPct, zeroLoss, stopLossPct }) {
  const id = `${mode === 'virtual' ? 'VDEMO' : 'ORD'}-${Date.now()}-${Math.floor(Math.random() * 999)}`;
  return {
    id,
    pair: symbol,
    side: 'BUY',
    status: 'OPEN',
    entry_price: price,
    current_price: price,
    quantity,
    invested_usdt: Number(notional.toFixed(2)),
    profit_usdt: 0,
    profit_pct: 0,
    take_profit_price: Number(
      (price * (1 + (tpPct + (zeroLoss ? BINANCE_ROUND_TRIP_FEE_PCT : 0)) / 100)).toFixed(4)
    ),
    stop_loss_price: Number((price * (1 - stopLossPct / 100)).toFixed(4)),
    opened_at: new Date().toISOString(),
  };
}

async function insertTradeWithMode(row, mode) {
  let { error } = await supabase.from('trades').insert({ ...row, mode });
  if (error && isMissingColumnError(error)) {
    const { mode: _ignored, ...legacyRow } = row;
    ({ error } = await supabase.from('trades').insert(legacyRow));
  }
  if (error) {
    console.error(`[TRADE INSERT ERROR] ${error.message}`);
    await appendLog('ERROR', `Could not persist trade ${row.id} (${row.pair}): ${error.message}`, row.pair);
    return false;
  }
  return true;
}

const VIRTUAL_BALANCE_START = 10_000;
// Written in this order; the first column that accepts a write becomes the one we read back.
const VIRTUAL_BALANCE_COLUMNS = ['virtual_balance', 'demo_balance'];
let virtualBalanceColumn = VIRTUAL_BALANCE_COLUMNS[0];
let virtualBalanceMemory = null;
let virtualBalanceHeldInMemory = false;

function readVirtualBalance(settings) {
  // While no column accepts writes, the in-process balance is the only source of truth,
  // otherwise every cycle would resurrect the stale DB value and restart the paper P&L.
  if (virtualBalanceHeldInMemory && virtualBalanceMemory !== null) return virtualBalanceMemory;
  const stored = Number(settings[virtualBalanceColumn] ?? settings.virtual_balance ?? settings.demo_balance);
  if (Number.isFinite(stored)) {
    virtualBalanceMemory = stored;
    return stored;
  }
  if (virtualBalanceMemory !== null) return virtualBalanceMemory;
  return VIRTUAL_BALANCE_START;
}

async function writeVirtualBalance(settingsId, balance, cfg = null) {
  const value = Math.max(0, Number(balance.toFixed(2)));
  virtualBalanceMemory = value;

  let lastError = null;
  for (const column of VIRTUAL_BALANCE_COLUMNS) {
    const { error } = await supabase
      .from('settings')
      .update({ [column]: value })
      .eq('id', settingsId);
    if (!error) {
      if (column !== virtualBalanceColumn) {
        console.warn(`[DEMO BALANCE] Persisting paper balance in settings.${column}.`);
      }
      virtualBalanceColumn = column;
      if (virtualBalanceHeldInMemory) {
        virtualBalanceHeldInMemory = false;
        await appendLog('INFO', `[${MODE_LABEL[cfg?.mode] || 'DEMO'}] Paper balance persistence restored — ${money(value)} saved to settings.${column}.`);
      }
      return value;
    }
    lastError = error;
    if (!isMissingColumnError(error)) break;
  }

  const reason = lastError?.message || 'no writable settings column';
  if (!virtualBalanceHeldInMemory) {
    virtualBalanceHeldInMemory = true;
    console.warn(
      `[DEMO BALANCE] ${reason} — holding paper balance in memory so DEMO trades and P&L keep accumulating.`
    );
  }
  await warnThrottled(
    'virtual-balance-column',
    `DEMO balance could not be saved (${reason}). Holding ${money(value)} in memory so paper trades and P&L keep accumulating — run "alter table public.settings add column if not exists virtual_balance numeric default 10000;" to persist it again.`,
    null,
    cfg
  );
  return value;
}

async function runCycle() {
  try {
    const { data: settings, error: setErr } = await supabase
      .from('settings')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (setErr || !settings) return;

    const cfg = resolveTradingConfig(settings);
    cfg.id = settings.id;
    cfg.apiKey = (ENV_BINANCE_KEY || settings.binance_api_key || '').trim();
    cfg.apiSecret = (ENV_BINANCE_SECRET || settings.binance_api_secret || '').trim();
    cfg.useTestnet =
      process.env.BINANCE_TESTNET === 'false' ? false : ENV_TESTNET || Boolean(settings.use_testnet);
    cfg.hasCredentials = Boolean(cfg.apiKey && cfg.apiSecret);
    const label = MODE_LABEL[cfg.mode];

    const heartbeatPatch = { last_heartbeat: new Date().toISOString() };
    let liveSpot = Number(settings.balance_usdt || 0);
    let virtualBalance = readVirtualBalance(settings);

    // 1. Always sync the real Binance balance for the LIVE readout (even on standby).
    if (cfg.hasCredentials) {
      try {
        const portfolio = await fetchBinancePortfolioUsdt(cfg.apiKey, cfg.apiSecret, cfg.useTestnet);
        if (portfolio) {
          liveSpot = portfolio.spot;
          heartbeatPatch.balance_usdt = portfolio.total;
          if (lastLoggedBalance !== portfolio.total) {
            lastLoggedBalance = portfolio.total;
            const logMsg = `[BALANCE SYNC] Portfolio $${portfolio.total.toFixed(2)} — Spot $${portfolio.spot.toFixed(2)} (tradeable) · Funding $${portfolio.funding.toFixed(2)} · Earn $${portfolio.earn.toFixed(2)}`;
            console.log(logMsg);
            await appendLog('INFO', logMsg);
          }
        }
      } catch (balErr) {
        console.warn('[BALANCE SYNC WARNING]', balErr.message);
      }
    }

    await supabase.from('settings').update(heartbeatPatch).eq('id', settings.id);

    if (!cfg.isRunning) return; // Standby: heartbeat only, never place orders.

    const { data: openRows } = await supabase.from('trades').select('*').eq('status', 'OPEN');
    const activeTrades = (openRows || []).filter((row) => tradeModeOf(row) === cfg.mode);

    const symbolsToFetch = Array.from(
      new Set([...cfg.pairs, ...activeTrades.map((t) => t.pair)].filter(Boolean))
    );
    const prices = await fetchBinancePrices(symbolsToFetch, cfg.useTestnet);

    // 2. Refresh open-trade PnL for this workspace's positions only.
    for (const tr of activeTrades) {
      const livePx = prices[tr.pair];
      if (!livePx) continue;
      const qty = Number(tr.quantity || 0);
      const profitUsdt = Number(((livePx - Number(tr.entry_price)) * qty).toFixed(2));
      const profitPct = Number(
        ((profitUsdt / Math.max(0.01, Number(tr.invested_usdt))) * 100).toFixed(2)
      );
      // Highest watermark since entry, used by the trailing stop-loss.
      const entryPx = Number(tr.entry_price) || 0;
      const peakPrice = Math.max(Number(tr.peak_price) || 0, entryPx, livePx);
      const pnlPatch = {
        current_price: livePx,
        profit_usdt: profitUsdt,
        profit_pct: profitPct,
        peak_price: peakPrice,
      };
      let { error: pnlError } = await supabase
        .from('trades')
        .update(pnlPatch)
        .eq('id', tr.id);
      if (pnlError && isMissingColumnError(pnlError)) {
        // Pre-upgrade schema: keep PnL live and fall back to entry-only trailing.
        const { peak_price: _ignoredPeak, ...legacyPatch } = pnlPatch;
        ({ error: pnlError } = await supabase
          .from('trades')
          .update(legacyPatch)
          .eq('id', tr.id));
      }
      tr.current_price = livePx;
      tr.profit_usdt = profitUsdt;
      tr.profit_pct = profitPct;
      tr.peak_price = peakPrice;
    }

    // 2.5 Daily max-loss guard (Asia/Dhaka day): pause new risk once the realized loss
    // for the current day reaches daily_max_loss_pct of that day's opening equity.
    let dailyLossBreached = false;
    if (cfg.dailyMaxLossPct > 0) {
      try {
        const { data: closedToday } = await supabase
          .from('trades')
          .select('id,mode,trading_mode,profit_usdt,closed_at')
          .eq('status', 'CLOSED')
          .gte('closed_at', dhakaDayStartUtc().toISOString());
        const realizedToday = (closedToday || [])
          .filter((row) => tradeModeOf(row) === cfg.mode)
          .reduce((sum, row) => sum + Number(row.profit_usdt || 0), 0);
        const equity = cfg.mode === 'live' ? liveSpot : virtualBalance;
        const dayOpenEquity = Math.max(1, equity - realizedToday);
        const lossPct = realizedToday < 0 ? (Math.abs(realizedToday) / dayOpenEquity) * 100 : 0;
        dailyLossBreached = lossPct >= cfg.dailyMaxLossPct;
        if (dailyLossBreached) {
          await warnThrottled(
            'daily-max-loss',
            `Daily loss guard hit — realized loss ${lossPct.toFixed(2)}% of $${dayOpenEquity.toFixed(
              2
            )} opening equity (limit ${cfg.dailyMaxLossPct}%). New entries paused until 00:00 Asia/Dhaka.`,
            null,
            cfg
          );
        }
      } catch (guardErr) {
        console.warn('[DAILY GUARD WARNING]', guardErr.message);
      }
    }

    // 3. Strategy: batch sell-all (fee-aware zero-loss), DCA re-buy, fresh entries.
    for (const symbol of cfg.pairs) {
      const livePx = prices[symbol];
      if (!livePx) continue;
      const pairOpen = activeTrades.filter((t) => t.pair === symbol);

      if (pairOpen.length > 0) {
        const totalInvested = pairOpen.reduce((s, t) => s + Number(t.invested_usdt || 0), 0);
        const totalPnl = pairOpen.reduce((s, t) => s + Number(t.profit_usdt || 0), 0);
        const aggPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
        const estimatedFeesUsdt = totalInvested * (BINANCE_ROUND_TRIP_FEE_PCT / 100);
        const netPnlAfterFees = totalPnl - estimatedFeesUsdt;
        const requiredTpWithFees = cfg.zeroLoss ? cfg.tpPct + BINANCE_ROUND_TRIP_FEE_PCT : cfg.tpPct;

        const takeProfitTriggered =
          aggPct >= requiredTpWithFees && (!cfg.zeroLoss || netPnlAfterFees > 0);
        const stopLossTriggered = cfg.stopLossEnabled && !cfg.zeroLoss && aggPct <= -cfg.stopLossPct;

        // Trailing stop-loss: lock in profit once price retraces trailing_stop_pct from
        // the highest watermark reached since entry.
        const peakPrice = Math.max(
          ...pairOpen.map((t) => Number(t.peak_price) || Number(t.entry_price) || 0)
        );
        const peakAboveEntry = pairOpen.some(
          (t) => (Number(t.peak_price) || 0) > Number(t.entry_price || 0)
        );
        const trailingTriggered =
          cfg.trailingStopPct > 0 &&
          peakAboveEntry &&
          peakPrice > 0 &&
          livePx <= peakPrice * (1 - cfg.trailingStopPct / 100) &&
          netPnlAfterFees > 0;

        if (takeProfitTriggered || stopLossTriggered || trailingTriggered) {
          const closedAt = new Date().toISOString();
          let closedCount = 0;
          for (const tr of pairOpen) {
            if (cfg.mode === 'live') {
              try {
                await placeBinanceMarketOrder(
                  symbol,
                  'SELL',
                  0,
                  Number(tr.quantity),
                  cfg.apiKey,
                  cfg.apiSecret,
                  cfg.useTestnet
                );
              } catch (sellErr) {
                await warnThrottled(
                  `sell-failed-${symbol}`,
                  `LIVE SELL REJECTED ${symbol}: ${sellErr.message} — position kept open, next cycle will retry.`,
                  symbol,
                  cfg
                );
                continue;
              }
            }
            const { error: closeErr } = await supabase
              .from('trades')
              .update({
                status: 'CLOSED',
                exit_price: livePx,
                profit_usdt: Number((livePx - Number(tr.entry_price)) * Number(tr.quantity || 0)),
                closed_at: closedAt,
              })
              .eq('id', tr.id);
            if (closeErr) {
              console.error(`[CLOSE ERROR] ${closeErr.message}`);
              continue;
            }
            closedCount += 1;
          }

          if (closedCount > 0) {
            const proceeds = totalInvested + netPnlAfterFees;
            if (cfg.mode === 'virtual') {
              virtualBalance = await writeVirtualBalance(cfg.id, virtualBalance + proceeds, cfg);
            } else {
              liveSpot = Math.max(0, liveSpot + proceeds);
            }
            const tag = takeProfitTriggered
              ? 'BATCH SELL ALL'
              : trailingTriggered
                ? 'TRAILING STOP EXIT'
                : 'STOP-LOSS EXIT';
            const msg = `${tag} ${symbol} (${closedCount} orders) @ $${livePx} | Net PnL ${
              netPnlAfterFees >= 0 ? '+' : ''
            }$${netPnlAfterFees.toFixed(2)} (${aggPct >= 0 ? '+' : ''}${aggPct.toFixed(2)}%)`;
            await appendLog('TRADE', `[${label}] ${msg}`, symbol);
            await sendTradeTelegram(cfg, {
              title: tag,
              symbol,
              side: 'SELL',
              price: livePx,
              amountUsd: totalInvested,
              pnlUsdt: netPnlAfterFees,
              pnlPct: aggPct,
              balanceUsd: cfg.mode === 'live' ? liveSpot : virtualBalance,
              note: takeProfitTriggered
                ? cfg.zeroLoss
                  ? 'Zero-Loss Shield: exit cleared the 0.2% round-trip fee.'
                  : undefined
                : trailingTriggered
                  ? `Trailing stop: price fell ${cfg.trailingStopPct}% from the $${peakPrice.toFixed(
                      2
                    )} peak — profit locked in.`
                  : 'Circuit breaker: stop-loss exit executed.',
            });
          }
          continue;
        }

        // DCA re-buy on a dip below the lowest open entry.
        if (!dailyLossBreached && cfg.dcaEnabled && pairOpen.length < cfg.dcaMaxBuys) {
          const lowestEntry = Math.min(...pairOpen.map((t) => Number(t.entry_price)));
          const dropPct = ((lowestEntry - livePx) / lowestEntry) * 100;
          if (dropPct >= cfg.dcaStepPct && totalInvested + cfg.lotRequested <= cfg.maxPerPair) {
            let row = null;
            if (cfg.mode === 'live') {
              const buy = await buyWithGuards(
                symbol,
                'DCA',
                cfg.lotRequested,
                livePx,
                cfg.apiKey,
                cfg.apiSecret,
                cfg.useTestnet,
                liveSpot,
                cfg
              );
              if (!buy) continue;
              row = buildTradeRow({
                mode: 'live',
                symbol,
                price: livePx,
                quantity: buy.filledQty,
                notional: buy.notional,
                tpPct: cfg.tpPct,
                zeroLoss: cfg.zeroLoss,
                stopLossPct: cfg.stopLossPct,
              });
              if (!(await insertTradeWithMode(row, 'live'))) continue;
              liveSpot = Math.max(0, liveSpot - buy.notional);
            } else {
              if (virtualBalance < cfg.lotRequested) {
                await warnThrottled(
                  `virtual-funds-${symbol}`,
                  `DEMO ${symbol} DCA skipped — virtual balance ${money(
                    virtualBalance
                  )} is below the ${money(cfg.lotRequested)} lot.`,
                  symbol,
                  cfg
                );
                continue;
              }
              row = buildTradeRow({
                mode: 'virtual',
                symbol,
                price: livePx,
                quantity: Number((cfg.lotRequested / livePx).toFixed(8)),
                notional: cfg.lotRequested,
                tpPct: cfg.tpPct,
                zeroLoss: cfg.zeroLoss,
                stopLossPct: cfg.stopLossPct,
              });
              if (!(await insertTradeWithMode(row, 'virtual'))) continue;
              virtualBalance = await writeVirtualBalance(cfg.id, virtualBalance - cfg.lotRequested, cfg);
            }
            activeTrades.push(row);
            const msg = `DCA RE-BUY #${pairOpen.length + 1} ${symbol} @ $${livePx} (-${dropPct.toFixed(
              2
            )}% dip) | ${money(row.invested_usdt)} USDT`;
            await appendLog('TRADE', `[${label}] ${msg}`, symbol);
            await sendTradeTelegram(cfg, {
              title: `DCA RE-BUY #${pairOpen.length + 1}`,
              symbol,
              side: 'BUY',
              price: livePx,
              amountUsd: row.invested_usdt,
              balanceUsd: cfg.mode === 'live' ? liveSpot : virtualBalance,
              note: `Dip: -${dropPct.toFixed(2)}% vs lowest entry`,
            });
          }
        }
      } else if (!dailyLossBreached && activeTrades.length < cfg.maxOpenTrades) {
        if (cfg.mode === 'live' && !cfg.hasCredentials) {
          await warnThrottled(
            'live-missing-keys',
            'LIVE mode is ON but no Binance API key/secret is configured — no orders are sent and no phantom trades are recorded.',
            null,
            cfg
          );
          return;
        }

        let ticker24h = null;
        try {
          ticker24h = await fetchPublicWithFallback(
            `/api/v3/ticker/24hr?symbol=${symbol}`,
            cfg.useTestnet
          );
        } catch {}

        const priceChangePercent = ticker24h ? Number(ticker24h.priceChangePercent || 0) : 0;
        const quoteVolume = ticker24h ? Number(ticker24h.quoteVolume || 0) : 100000;
        const hasHealthyVolume = quoteVolume > 200000;
        const favorableMomentum = priceChangePercent > -5.0;

        if (hasHealthyVolume && favorableMomentum) {
          let row = null;
          if (cfg.mode === 'live') {
            const buy = await buyWithGuards(
              symbol,
              'ENTRY',
              cfg.lotRequested,
              livePx,
              cfg.apiKey,
              cfg.apiSecret,
              cfg.useTestnet,
              liveSpot,
              cfg
            );
            if (!buy) continue;
            row = buildTradeRow({
              mode: 'live',
              symbol,
              price: livePx,
              quantity: buy.filledQty,
              notional: buy.notional,
              tpPct: cfg.tpPct,
              zeroLoss: cfg.zeroLoss,
              stopLossPct: cfg.stopLossPct,
            });
            if (!(await insertTradeWithMode(row, 'live'))) continue;
            liveSpot = Math.max(0, liveSpot - buy.notional);
          } else {
            if (virtualBalance < cfg.lotRequested) {
              await warnThrottled(
                `virtual-funds-${symbol}`,
                `DEMO ${symbol} entry skipped — virtual balance ${money(
                  virtualBalance
                )} is below the ${money(cfg.lotRequested)} lot.`,
                symbol,
                cfg
              );
              continue;
            }
            row = buildTradeRow({
              mode: 'virtual',
              symbol,
              price: livePx,
              quantity: Number((cfg.lotRequested / livePx).toFixed(8)),
              notional: cfg.lotRequested,
              tpPct: cfg.tpPct,
              zeroLoss: cfg.zeroLoss,
              stopLossPct: cfg.stopLossPct,
            });
            if (!(await insertTradeWithMode(row, 'virtual'))) continue;
            virtualBalance = await writeVirtualBalance(cfg.id, virtualBalance - cfg.lotRequested, cfg);
          }

          activeTrades.push(row);
          const msg = `ENTRY BUY ${symbol} @ $${livePx} | ${money(
            row.invested_usdt
          )} USDT | 24h ${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(
            2
          )}% | Vol $${Math.round(quoteVolume).toLocaleString()}`;
          await appendLog('TRADE', `[${label}] ${msg}`, symbol);
          await sendTradeTelegram(cfg, {
            title: cfg.mode === 'live' ? 'ENTRY BUY' : 'PAPER ENTRY BUY',
            symbol,
            side: 'BUY',
            price: livePx,
            amountUsd: row.invested_usdt,
            balanceUsd: cfg.mode === 'live' ? liveSpot : virtualBalance,
            note: `24h ${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}% · ${
              cfg.zeroLoss ? 'Zero-Loss Shield ON' : 'Standard TP/SL'
            }`,
          });
        }
      }
    }
  } catch (err) {
    console.error('[CYCLE ERROR]', err.message);
    await appendLog('ERROR', `Worker cycle error: ${err.message}`);
  }
}

async function startWorker() {
  console.log(
    '[AEGIS WORKER] Started — 24/7 engine for LIVE + DEMO/VIRTUAL modes. Polling Supabase settings every 15s...'
  );
  await logServerPublicIp();
  void startTelegramCommandLoop();
  // Midnight Asia/Dhaka PnL report — checked every minute, sent once per day.
  setInterval(() => void dailyReportLoop(), 60_000);
  await runCycle();
  setInterval(runCycle, 15_000);
}

startWorker();
