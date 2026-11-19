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

            const usdtBalance = await fetchBinanceSpotUsdtBalance(apiKey, apiSecret, testnet);
            if (usdtBalance === null) {
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
                  balance_usdt: usdtBalance,
                  last_heartbeat: new Date().toISOString(),
                })
                .eq('id', settingsRow.id);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                usdtBalance,
                message: `Binance API verified successfully. USDT Balance: $${usdtBalance.toFixed(2)}`,
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

          let usdtBalance = Number(settingsRow.balance_usdt || 0);
          if (apiKey && apiSecret) {
            const fetched = await fetchBinanceSpotUsdtBalance(apiKey, apiSecret, useTestnet);
            if (fetched !== null && Number.isFinite(fetched)) {
              usdtBalance = fetched;
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              usdtBalance,
              totalUsdt: usdtBalance,
              totalPortfolioUsd: usdtBalance,
              spotUsd: usdtBalance,
              fundingUsd: 0,
              earnUsd: 0,
              assets: [],
            })
          );
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    })
    .listen(PORT, '0.0.0.0', () => {
      console.log(`[WORKER] HTTP server listening on port ${PORT}`);
    });
}

async function sendTelegram(text, token, chatId) {
  const t = (token || TELEGRAM_BOT_TOKEN || '').trim();
  const c = (chatId || TELEGRAM_CHAT_ID || '').trim();
  if (!t || !c) return;
  try {
    await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: c,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[TELEGRAM ERROR]', err.message);
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

let lastLoggedBalance = null;

async function runCycle() {
  try {
    const { data: settings, error: setErr } = await supabase
      .from('settings')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (setErr || !settings) return;

    // Resolve credentials from env or Supabase settings table
    const apiKey = (ENV_BINANCE_KEY || settings.binance_api_key || '').trim();
    const apiSecret = (ENV_BINANCE_SECRET || settings.binance_api_secret || '').trim();
    const useTestnet = process.env.BINANCE_TESTNET === 'false' ? false : (ENV_TESTNET || Boolean(settings.use_testnet));
    const telegramToken = (settings.telegram_bot_token || settings.bot_token || '').trim();
    const telegramChatId = (settings.telegram_chat_id || settings.chat_id || '').trim();

    // 1. ALWAYS sync Real Binance Spot USDT Balance in every 15s loop (regardless of bot_enabled ON/OFF)
    const heartbeatPatch = { last_heartbeat: new Date().toISOString() };
    if (apiKey && apiSecret) {
      try {
        const spotUsdt = await fetchBinanceSpotUsdtBalance(apiKey, apiSecret, useTestnet);
        if (spotUsdt !== null && Number.isFinite(spotUsdt)) {
          heartbeatPatch.balance_usdt = spotUsdt;
          if (lastLoggedBalance !== spotUsdt) {
            lastLoggedBalance = spotUsdt;
            const logMsg = `[BALANCE SYNC] Live Spot USDT: $${spotUsdt.toFixed(2)}`;
            console.log(logMsg);
            await appendLog('INFO', logMsg);
          }
        }
      } catch (balErr) {
        console.warn('[BALANCE SYNC WARNING]', balErr.message);
      }
    }

    await supabase
      .from('settings')
      .update(heartbeatPatch)
      .eq('id', settings.id);

    if (!settings.bot_enabled) {
      return; // Standby / OFF: Sync balance & heartbeat only, never place orders!
    }

    const enabledPairs = Array.isArray(settings.enabled_pairs)
      ? settings.enabled_pairs
      : ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];

    const { data: openTrades } = await supabase
      .from('trades')
      .select('*')
      .eq('status', 'OPEN');

    const activeTrades = openTrades || [];
    const symbolsToFetch = Array.from(
      new Set([...enabledPairs, ...activeTrades.map((t) => t.pair)])
    );
    const prices = await fetchBinancePrices(symbolsToFetch, useTestnet);

    // 2. Refresh open trades PnL
    for (const tr of activeTrades) {
      const livePx = prices[tr.pair];
      if (!livePx) continue;
      const profitUsdt = Number(((livePx - tr.entry_price) * tr.quantity).toFixed(2));
      const profitPct = Number(((profitUsdt / Math.max(0.01, tr.invested_usdt)) * 100).toFixed(2));
      await supabase
        .from('trades')
        .update({
          current_price: livePx,
          profit_usdt: profitUsdt,
          profit_pct: profitPct,
        })
        .eq('id', tr.id);
      tr.current_price = livePx;
      tr.profit_usdt = profitUsdt;
      tr.profit_pct = profitPct;
    }

    const lot = Math.max(1, Number(settings.amount_per_trade || 10));
    const tpPct = Number(settings.take_profit_pct || 2.4);
    const dcaEnabled = settings.dca_enabled !== false;
    const dcaStepPct = Math.max(0.2, Number(settings.dca_step_pct || 1.5));
    const dcaMaxBuys = Math.max(1, Number(settings.dca_max_buys || 12));
    const zeroLoss = Boolean(
      settings.zero_loss_shield ?? settings.zero_loss_mode ?? settings.sell_only_in_profit ?? true
    );
    const stopLossEnabled = !zeroLoss && Boolean(settings.stop_loss_enabled);
    const stopLossPct = Math.abs(Number(settings.stop_loss_pct || 1.5));
    const maxPerPair = Number(settings.max_amount_per_pair || 500);
    const maxOpenTrades = Math.max(1, Number(settings.max_open_trades || 5));

    // 3. Evaluate Batch Sell-All (Fee-Aware Zero-Loss Shield) or DCA Re-Buy per pair
    for (const symbol of enabledPairs) {
      const livePx = prices[symbol];
      if (!livePx) continue;
      const pairOpen = activeTrades.filter((t) => t.pair === symbol);

      if (pairOpen.length > 0) {
        const totalInvested = pairOpen.reduce((s, t) => s + Number(t.invested_usdt), 0);
        const totalPnl = pairOpen.reduce((s, t) => s + Number(t.profit_usdt), 0);
        const aggPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
        const estimatedFeesUsdt = totalInvested * (BINANCE_ROUND_TRIP_FEE_PCT / 100);
        const netPnlAfterFees = totalPnl - estimatedFeesUsdt;
        const requiredTpWithFees = zeroLoss ? tpPct + BINANCE_ROUND_TRIP_FEE_PCT : tpPct;

        // STRICT ZERO-LOSS CHECK: Never sell unless gross PnL covers Binance 0.2% round-trip fees + net profit > 0
        const takeProfitTriggered =
          aggPct >= requiredTpWithFees && (!zeroLoss || netPnlAfterFees > 0);

        const stopLossTriggered =
          stopLossEnabled && !zeroLoss && aggPct <= -stopLossPct;

        if (takeProfitTriggered || stopLossTriggered) {
          for (const tr of pairOpen) {
            if (apiKey && apiSecret) {
              await placeBinanceMarketOrder(symbol, 'SELL', 0, tr.quantity, apiKey, apiSecret, useTestnet);
            }
            await supabase
              .from('trades')
              .update({
                status: 'CLOSED',
                exit_price: livePx,
                closed_at: new Date().toISOString(),
              })
              .eq('id', tr.id);
          }
          const tag = takeProfitTriggered ? 'BATCH SELL ALL' : 'STOP-LOSS EXIT';
          const msg = `${tag} ${symbol} (${pairOpen.length} orders) @ $${livePx} | Net PnL ${
            netPnlAfterFees >= 0 ? '+' : ''
          }$${netPnlAfterFees.toFixed(2)} (${aggPct >= 0 ? '+' : ''}${aggPct.toFixed(2)}%)`;
          await appendLog('TRADE', msg, symbol);
          if (settings.telegram_enabled) await sendTelegram(`<b>[AEGIS LIVE]</b> ${msg}`, telegramToken, telegramChatId);
          continue;
        }

        // DCA Re-Buy when price dips below lowest open entry
        if (dcaEnabled && pairOpen.length < dcaMaxBuys) {
          const lowestEntry = Math.min(...pairOpen.map((t) => Number(t.entry_price)));
          const dropPct = ((lowestEntry - livePx) / lowestEntry) * 100;
          if (dropPct >= dcaStepPct && totalInvested + lot <= maxPerPair) {
            let filledQty = Number((lot / livePx).toFixed(5));
            if (apiKey && apiSecret) {
              const order = await placeBinanceMarketOrder(symbol, 'BUY', lot, 0, apiKey, apiSecret, useTestnet);
              if (order.executedQty) filledQty = Number(order.executedQty);
            }
            const id = `ORD-${Date.now()}-${Math.floor(Math.random() * 999)}`;
            await supabase.from('trades').insert({
              id,
              pair: symbol,
              side: 'BUY',
              status: 'OPEN',
              entry_price: livePx,
              current_price: livePx,
              quantity: filledQty,
              invested_usdt: lot,
              profit_usdt: 0,
              profit_pct: 0,
              take_profit_price: Number(
                (livePx * (1 + (tpPct + (zeroLoss ? BINANCE_ROUND_TRIP_FEE_PCT : 0)) / 100)).toFixed(4)
              ),
              opened_at: new Date().toISOString(),
            });
            const msg = `DCA RE-BUY #${pairOpen.length + 1} ${symbol} @ $${livePx} (-${dropPct.toFixed(2)}% dip) | $${lot} USDT`;
            await appendLog('TRADE', msg, symbol);
            if (settings.telegram_enabled) await sendTelegram(`<b>[AEGIS LIVE]</b> ${msg}`, telegramToken, telegramChatId);
          }
        }
      } else if (activeTrades.length < maxOpenTrades) {
        // Real-Time Market Data Analysis (Volume Spike & Momentum check)
        let ticker24h = null;
        try {
          ticker24h = await fetchPublicWithFallback(`/api/v3/ticker/24hr?symbol=${symbol}`, useTestnet);
        } catch {}

        const priceChangePercent = ticker24h ? Number(ticker24h.priceChangePercent || 0) : 0;
        const quoteVolume = ticker24h ? Number(ticker24h.quoteVolume || 0) : 100000;
        
        const hasHealthyVolume = quoteVolume > 200000; // > $200k volume
        const favorableMomentum = priceChangePercent > -5.0; // Avoid catastrophic freefall

        if (hasHealthyVolume && favorableMomentum) {
          let filledQty = Number((lot / livePx).toFixed(5));
          if (apiKey && apiSecret) {
            const order = await placeBinanceMarketOrder(symbol, 'BUY', lot, 0, apiKey, apiSecret, useTestnet);
            if (order.executedQty) filledQty = Number(order.executedQty);
          }
          const id = `ORD-${Date.now()}-${Math.floor(Math.random() * 999)}`;
          await supabase.from('trades').insert({
            id,
            pair: symbol,
            side: 'BUY',
            status: 'OPEN',
            entry_price: livePx,
            current_price: livePx,
            quantity: filledQty,
            invested_usdt: lot,
            profit_usdt: 0,
            profit_pct: 0,
            take_profit_price: Number(
              (livePx * (1 + (tpPct + (zeroLoss ? BINANCE_ROUND_TRIP_FEE_PCT : 0)) / 100)).toFixed(4)
            ),
            opened_at: new Date().toISOString(),
          });
          activeTrades.push({ pair: symbol });
          const detailedMsg = `🚀 <b>AEGIS LIVE ENTRY BUY</b>\nPair: <b>${symbol}</b>\nPrice: $${livePx}\nInvested: $${lot} USDT\n24h Change: ${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}%\nVolume: $${Math.round(quoteVolume).toLocaleString()}\nMode: ${zeroLoss ? 'Zero-Loss Shield ON' : 'Standard'}`;
          await appendLog('TRADE', detailedMsg, symbol);
          if (settings.telegram_enabled) await sendTelegram(detailedMsg, telegramToken, telegramChatId);
        }
      }
    }
  } catch (err) {
    console.error('[CYCLE ERROR]', err.message);
    await appendLog('ERROR', `Worker cycle error: ${err.message}`);
  }
}

async function startWorker() {
  console.log('[AEGIS WORKER] Started (Continuous Balance Sync + Trading Engine). Polling every 15s...');
  await logServerPublicIp();
  await runCycle();
  setInterval(runCycle, 15_000);
}

startWorker();
