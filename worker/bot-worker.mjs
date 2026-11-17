/**
 * Aegis Quant Terminal — 24/7 Render Execution Worker
 * Connects Supabase (settings/trades/logs) + Binance Spot API + Telegram Alerts
 * Binds an optional HTTP healthcheck port when process.env.PORT is set (Render Web Service compatible).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
const BINANCE_BASE_URL =
  process.env.BINANCE_TESTNET === 'true'
    ? 'https://testnet.binance.vision'
    : 'https://api.binance.com';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[WORKER ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Optional HTTP Healthcheck Server so Render Free Web Service stays healthy
const PORT = Number(process.env.PORT || 0);
if (PORT > 0) {
  http
    .createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          service: 'aegis-quant-worker',
          status: 'ok',
          timestamp: new Date().toISOString(),
        })
      );
    })
    .listen(PORT, '0.0.0.0', () => {
      console.log(`[WORKER] Healthcheck listening on port ${PORT}`);
    });
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[TELEGRAM ERROR]', err.message);
  }
}

async function appendLog(level, message, pair = null) {
  await supabase.from('logs').insert({ level, pair, message });
}

function signBinanceQuery(queryString) {
  return crypto
    .createHmac('sha256', BINANCE_API_SECRET)
    .update(queryString)
    .digest('hex');
}

async function fetchBinancePrices(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const param = encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(`${BINANCE_BASE_URL}/api/v3/ticker/price?symbols=${param}`);
  if (!res.ok) throw new Error(`Binance price HTTP ${res.status}`);
  const rows = await res.json();
  const map = {};
  for (const row of rows) {
    map[row.symbol] = Number(row.price);
  }
  return map;
}

async function placeBinanceMarketOrder(symbol, side, quoteOrderQty, quantity) {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    throw new Error('Binance API credentials missing');
  }
  const timestamp = Date.now();
  const params = new URLSearchParams({
    symbol,
    side,
    type: 'MARKET',
    timestamp: String(timestamp),
  });
  if (side === 'BUY') {
    params.set('quoteOrderQty', Number(quoteOrderQty).toFixed(2));
  } else {
    params.set('quantity', Number(quantity).toFixed(5));
  }
  const sig = signBinanceQuery(params.toString());
  params.set('signature', sig);

  const res = await fetch(`${BINANCE_BASE_URL}/api/v3/order?${params.toString()}`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.msg || `Binance order HTTP ${res.status}`);
  }
  return data;
}

async function runCycle() {
  try {
    const { data: settings, error: setErr } = await supabase
      .from('settings')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (setErr || !settings) return;

    // 1. Update Heartbeat
    await supabase
      .from('settings')
      .update({ last_heartbeat: new Date().toISOString() })
      .eq('id', settings.id);

    if (!settings.bot_enabled) {
      return; // Standby until operator switches Bot ON
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
    const prices = await fetchBinancePrices(symbolsToFetch);

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
    const zeroLoss = settings.zero_loss_mode !== false;
    const maxPerPair = Number(settings.max_amount_per_pair || 500);

    // 3. Evaluate Batch Sell-All or DCA Re-Buy per pair
    for (const symbol of enabledPairs) {
      const livePx = prices[symbol];
      if (!livePx) continue;
      const pairOpen = activeTrades.filter((t) => t.pair === symbol);

      if (pairOpen.length > 0) {
        const totalInvested = pairOpen.reduce((s, t) => s + Number(t.invested_usdt), 0);
        const totalPnl = pairOpen.reduce((s, t) => s + Number(t.profit_usdt), 0);
        const aggPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

        // Sell ALL stacked positions together when net ROI hits Take Profit
        if (aggPct >= tpPct && (!zeroLoss || totalPnl > 0)) {
          for (const tr of pairOpen) {
            if (BINANCE_API_KEY && BINANCE_API_SECRET) {
              await placeBinanceMarketOrder(symbol, 'SELL', 0, tr.quantity);
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
          const msg = `BATCH SELL ALL ${symbol} (${pairOpen.length} orders) @ $${livePx} | Profit +$${totalPnl.toFixed(2)} (+${aggPct.toFixed(2)}%)`;
          await appendLog('TRADE', msg, symbol);
          if (settings.telegram_enabled) await sendTelegram(`<b>[AEGIS LIVE]</b> ${msg}`);
          continue;
        }

        // DCA Re-Buy when price dips below lowest open entry
        if (dcaEnabled && pairOpen.length < dcaMaxBuys) {
          const lowestEntry = Math.min(...pairOpen.map((t) => Number(t.entry_price)));
          const dropPct = ((lowestEntry - livePx) / lowestEntry) * 100;
          if (dropPct >= dcaStepPct && totalInvested + lot <= maxPerPair) {
            let filledQty = Number((lot / livePx).toFixed(5));
            if (BINANCE_API_KEY && BINANCE_API_SECRET) {
              const order = await placeBinanceMarketOrder(symbol, 'BUY', lot, 0);
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
              take_profit_price: Number((livePx * (1 + tpPct / 100)).toFixed(4)),
              opened_at: new Date().toISOString(),
            });
            const msg = `DCA RE-BUY #${pairOpen.length + 1} ${symbol} @ $${livePx} (-${dropPct.toFixed(2)}% dip) | $${lot} USDT`;
            await appendLog('TRADE', msg, symbol);
            if (settings.telegram_enabled) await sendTelegram(`<b>[AEGIS LIVE]</b> ${msg}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[CYCLE ERROR]', err.message);
    await appendLog('ERROR', `Worker cycle error: ${err.message}`);
  }
}

console.log('[AEGIS WORKER] Started. Polling every 15s...');
runCycle();
setInterval(runCycle, 15_000);
