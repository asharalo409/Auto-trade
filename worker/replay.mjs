/**
 * Offline replay/simulation engine for the Aegis 24/7 trading loop.
 *
 * It walks a fixed candle fixture (one entry per simulated 15s cycle) through the
 * SAME pure decisions `worker/bot-worker.mjs` uses — presets, the 1h trend gate,
 * the bounded DEMO fallback, the daily-loss guard, DCA planning and position
 * sizing — and returns a step-by-step trace instead of touching Supabase, Binance
 * or Telegram. Tests assert on that trace; nothing here can place an order.
 */
import {
  BINANCE_ROUND_TRIP_FEE_PCT,
  canOpenAnotherTrade,
  createMtfFallbackTracker,
  evaluateDailyLossGuard,
  evaluateHigherTimeframeTrend,
  planDcaRebuy,
  resolveEntryNotional,
  resolveReportWorkspaceMode,
  resolveTradingConfig,
} from './strategy-core.mjs';

const VIRTUAL_BALANCE_START = 10_000;

/** Volume / momentum floors the live loop applies before it looks at the trend. */
const MIN_QUOTE_VOLUME = { virtual: 50_000, live: 200_000 };
const MIN_PRICE_CHANGE_PCT = { virtual: -8.0, live: -5.0 };

function sumBy(rows, pick) {
  return rows.reduce((total, row) => total + Number(pick(row) || 0), 0);
}

/**
 * The loop's exit arithmetic: fee-aware take profit, stop-loss and the trailing
 * stop that only arms once price has traded above the entry.
 */
export function evaluateExits({ pairOpen, livePx, cfg }) {
  const totalInvested = sumBy(pairOpen, (t) => t.invested_usdt);
  const totalPnl = sumBy(pairOpen, (t) => (Number(livePx) - Number(t.entry_price)) * Number(t.quantity || 0));
  const aggPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const fees = totalInvested * (BINANCE_ROUND_TRIP_FEE_PCT / 100);
  const net = totalPnl - fees;
  const requiredTp = cfg.zeroLoss ? cfg.tpPct + BINANCE_ROUND_TRIP_FEE_PCT : cfg.tpPct;

  const takeProfit = aggPct >= requiredTp && (!cfg.zeroLoss || net > 0);
  const stopLoss = cfg.stopLossEnabled && !cfg.zeroLoss && aggPct <= -cfg.stopLossPct;
  const peakPrice = pairOpen.reduce(
    (peak, t) => Math.max(peak, Number(t.peak_price) || Number(t.entry_price) || 0),
    0
  );
  const peakAboveEntry = pairOpen.some((t) => (Number(t.peak_price) || 0) > Number(t.entry_price || 0));
  const trailing =
    cfg.trailingStopPct > 0 &&
    peakAboveEntry &&
    peakPrice > 0 &&
    Number(livePx) <= peakPrice * (1 - cfg.trailingStopPct / 100) &&
    net > 0;

  return {
    totalInvested,
    totalPnl,
    aggPct,
    fees,
    net,
    peakPrice,
    takeProfit,
    stopLoss,
    trailing,
    exit: takeProfit ? 'TP_EXIT' : trailing ? 'TRAILING_EXIT' : stopLoss ? 'SL_EXIT' : null,
  };
}

/**
 * Replays `fixture.cycles` through the engine for ONE workspace and ONE mode.
 *
 * fixture = {
 *   symbol: 'BTCUSDT',
 *   seededClosedToday: -60,                       // realized PnL already booked today
 *   seededOpen: [{ entry_price, quantity, invested_usdt, peak_price }],
 *   balance: 1000,                                // demo balance (live: settings.balance_usdt)
 *   cycles: [{ price, closes1h, changePct24h, quoteVolume, crashBlocked }]
 * }
 */
/**
 * @param {{
 *   settings?: Record<string, any>,
 *   mode?: 'live' | 'virtual',
 *   credentials?: boolean,
 *   fixture?: Record<string, any>,
 *   tracker?: ReturnType<typeof createMtfFallbackTracker>,
 *   startedAt?: number,
 * }} options
 */
export function runReplay({
  settings = {},
  mode,
  credentials = false,
  fixture = {},
  tracker = null,
  // A realistic epoch, not 0: the fallback tracker's first-override cooldown check
  // compares against `lastOverrideAt = 0`, so a replay starting at t=0 would look
  // like it is still cooling down.
  startedAt = Date.UTC(2026, 0, 1),
} = {}) {
  const cfg = resolveTradingConfig(settings);
  cfg.mode = mode || (cfg.demoRunning ? 'virtual' : 'live');
  cfg.hasCredentials = Boolean(credentials);
  if (!cfg.scope) cfg.scope = 'replay';

  const symbol = fixture.symbol || cfg.pairs[0] || 'BTCUSDT';
  const fallback = tracker || createMtfFallbackTracker();
  const cycles = Array.isArray(fixture.cycles) ? fixture.cycles : [];

  let balance =
    cfg.mode === 'live'
      ? Number(settings.balance_usdt ?? fixture.balance ?? 0)
      : Number(fixture.balance ?? settings.virtual_balance ?? VIRTUAL_BALANCE_START);
  let realizedToday = Number(fixture.seededClosedToday || 0);

  const open = (fixture.seededOpen || []).map((row) => ({
    pair: row.pair || symbol,
    mode: cfg.mode,
    entry_price: Number(row.entry_price),
    quantity: Number(row.quantity ?? Number(row.invested_usdt) / Number(row.entry_price)),
    invested_usdt: Number(row.invested_usdt),
    peak_price: Number(row.peak_price ?? row.entry_price),
  }));

  const trace = [];

  cycles.forEach((step, index) => {
    const nowMs = startedAt + index * 60_000;
    const price = Number(step.price);
    const crashBlocked = Boolean(step.crashBlocked);

    // 1. Daily max-loss guard — evaluated against this cycle's balance/equity.
    const guard = evaluateDailyLossGuard({
      realizedToday,
      equity: balance,
      dailyMaxLossPct: cfg.dailyMaxLossPct,
    });

    const activity = []; // one or more actions per cycle
    const pairOpen = open.filter((t) => t.pair === symbol);

    if (pairOpen.length > 0) {
      // 2. Refresh PnL + peak watermark, then evaluate the exits.
      for (const tr of pairOpen) {
        const profit = (price - Number(tr.entry_price)) * Number(tr.quantity || 0);
        tr.profit_usdt = Number(profit.toFixed(2));
        tr.peak_price = Math.max(Number(tr.peak_price) || 0, Number(tr.entry_price) || 0, price);
      }
      const exits = evaluateExits({ pairOpen, livePx: price, cfg });

      if (exits.exit) {
        const closedAt = index;
        for (const tr of pairOpen) {
          tr.status = 'CLOSED';
          tr.exit_price = price;
          tr.profit_usdt = (price - Number(tr.entry_price)) * Number(tr.quantity || 0);
          tr.closed_at = closedAt;
        }
        const remaining = open.filter((t) => !pairOpen.includes(t));
        open.length = 0;
        open.push(...remaining);
        balance += exits.totalInvested + exits.net;
        realizedToday += exits.net;
        activity.push({
          action: exits.exit,
          reason: null,
          notional: exits.totalInvested,
          netPnl: exits.net,
          aggPct: exits.aggPct,
        });
      } else {
        // 3. DCA re-buy on a dip, subject to the per-pair buy cap and pair cap.
        const notional = resolveEntryNotional(cfg, balance);
        const plan = planDcaRebuy({
          pairOpen,
          livePx: price,
          cfg,
          notional,
          totalInvested: exits.totalInvested,
          dailyLossBreached: guard.halted,
          crashBlocked,
        });
        if (plan.ok) {
          open.push({
            pair: symbol,
            mode: cfg.mode,
            entry_price: price,
            quantity: Number((notional / price).toFixed(8)),
            invested_usdt: notional,
            peak_price: price,
          });
          balance -= notional;
          activity.push({
            action: 'DCA',
            reason: null,
            notional,
            dropPct: plan.dropPct,
            buyIndex: pairOpen.length + 1,
          });
        } else {
          activity.push({ action: 'HOLD', reason: plan.reason, notional: 0 });
        }
      }
    } else {
      // 4. Fresh-entry chain, in the same order as the live cycle.
      const gate = canOpenAnotherTrade({
        activeTrades: open,
        maxOpenTrades: cfg.maxOpenTrades,
        dailyLossBreached: guard.halted,
        crashBlocked,
        mode: cfg.mode,
        hasCredentials: cfg.hasCredentials,
      });

      if (!gate.allowed) {
        activity.push({ action: 'SKIP', reason: gate.reason, notional: 0 });
      } else {
        const changePct24h = Number(step.changePct24h ?? 0);
        const quoteVolume = Number(step.quoteVolume ?? 5_000_000);
        const healthyVolume = quoteVolume > MIN_QUOTE_VOLUME[cfg.mode];
        const favorableMomentum = changePct24h > MIN_PRICE_CHANGE_PCT[cfg.mode];

        if (!healthyVolume || !favorableMomentum) {
          activity.push({
            action: 'SKIP',
            reason: !healthyVolume ? 'low-volume' : 'adverse-momentum',
            notional: 0,
          });
        } else {
          let trend = null;
          let trendReason = null;
          let usedFallback = false;

          if (cfg.multiTimeframeFilter) {
            trend = evaluateHigherTimeframeTrend({ closes: step.closes1h || [], cfg });
            if (!trend.ok) {
              const fb = fallback.track(cfg, symbol, nowMs);
              if (!fb.override) {
                activity.push({
                  action: 'SKIP',
                  reason: 'mtf-veto',
                  detail: trend.reason,
                  vetos: fb.vetos,
                  notional: 0,
                });
              } else {
                usedFallback = true;
                trendReason = `demo-fallback:${fb.vetos}`;
              }
            } else {
              fallback.clear(cfg, symbol);
            }
          }

          if (activity.length === 0) {
            // 5. Size the ticket, then require enough balance to fund it.
            const notional = resolveEntryNotional(cfg, balance);
            if (notional > balance) {
              activity.push({
                action: 'SKIP',
                reason: cfg.mode === 'live' ? 'insufficient-live-balance' : 'insufficient-virtual-balance',
                notional,
              });
            } else {
              open.push({
                pair: symbol,
                mode: cfg.mode,
                entry_price: price,
                quantity: Number((notional / price).toFixed(8)),
                invested_usdt: notional,
                peak_price: price,
              });
              balance -= notional;
              activity.push({
                action: 'ENTRY',
                reason: usedFallback ? 'mtf-fallback' : null,
                notional,
                rsi: trend ? Number(trend.rsi?.toFixed(2)) : null,
              });
            }
          }
        }
      }
    }

    for (const stepActivity of activity) {
      trace.push({
        cycle: index,
        symbol,
        price,
        openCount: open.length,
        balance: Number(balance.toFixed(2)),
        realizedToday: Number(realizedToday.toFixed(2)),
        dailyLossHalted: guard.halted,
        dailyLossPct: Number(guard.lossPct.toFixed(2)),
        crashBlocked,
        ...stepActivity,
      });
    }
  });

  return {
    cfg,
    trace,
    reportMode: resolveReportWorkspaceMode(settings, cfg),
    state: {
      balance: Number(balance.toFixed(2)),
      realizedToday: Number(realizedToday.toFixed(2)),
      open,
      closed: trace.filter((row) => row.action === 'TP_EXIT' || row.action === 'TRAILING_EXIT' || row.action === 'SL_EXIT'),
    },
  };
}
