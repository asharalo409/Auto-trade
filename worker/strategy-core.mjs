/**
 * Pure strategy decisions for the Aegis 24/7 execution worker.
 *
 * Everything here is deterministic and side-effect free: no Supabase, no Binance,
 * no timers, no module-level mutable state other than the tracker instance a
 * caller creates. `worker/bot-worker.mjs` calls these functions inside the live
 * 15s cycle and `worker/replay.mjs` calls the same functions over fixed candle
 * fixtures, so the replay harness asserts the invariants the engine actually
 * executes rather than a copy of them.
 */

/** Binance Spot minimum notional (USDT) for a market order. */
export const BINANCE_MIN_ORDER_USDT = 5.5;

/** Round-trip Spot taker fee (0.1% buy + 0.1% sell), in percent. */
export const BINANCE_ROUND_TRIP_FEE_PCT = 0.2;

/** The RSI buy band each one-tap preset pins. A preset is authoritative. */
export const PRESET_RSI_BANDS = {
  safe: { min: 40, max: 65 },
  balanced: { min: 40, max: 72 },
  scalping: { min: 35, max: 78 },
};

export function computeEma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

export function computeRsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function normalizeTradingMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'live' || v === 'real' ? 'live' : 'virtual';
}

export function normalizePairList(raw) {
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

/** Only the three shipped presets pin an RSI band; anything else is "auto". */
export function resolvePresetId(value) {
  const id = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRESET_RSI_BANDS, id) ? id : null;
}

/**
 * The 1h trend gate: a fresh BUY needs the 1h close at/above its EMA20 and the 1h
 * RSI inside the configured buy band. A selected preset pins that band exactly;
 * with no preset, DEMO uses a relaxed band (and a 2.5% EMA tolerance) so the
 * paper engine keeps scanning. Pure: the caller supplies the 1h closes.
 */
export function evaluateHigherTimeframeTrend({ closes, cfg }) {
  const ema20 = computeEma(closes, 20);
  const rsi = computeRsi(closes, 14);
  if (ema20 === null || rsi === null) {
    return { ok: true, reason: 'insufficient 1h history', ema20, rsi, relaxed: false };
  }
  const lastClose = closes[closes.length - 1];
  const relaxed = !cfg.strategyPreset && cfg.mode === 'virtual';
  const emaFloor = relaxed ? ema20 * 0.975 : ema20;
  const bullish = lastClose >= emaFloor;
  const rsiMin = Number(cfg.rsiMin ?? 40);
  const rsiMax = Number(cfg.rsiMax ?? (relaxed ? 78 : 72));
  const healthyRsi = rsi >= rsiMin && rsi <= rsiMax;
  return {
    ok: bullish && healthyRsi,
    relaxed,
    ema20,
    rsi,
    lastClose,
    rsiMin,
    rsiMax,
    reason: bullish
      ? `1h RSI ${rsi.toFixed(1)} outside the ${rsiMin}-${rsiMax} buy band`
      : `1h close ${lastClose.toFixed(4)} below 1h EMA20 ${ema20.toFixed(4)}`,
  };
}

export const DEMO_MTF_FALLBACK_VETO_LIMIT = 3;
export const DEMO_MTF_FALLBACK_WAIT_MS = 30 * 60_000;
export const DEMO_MTF_FALLBACK_COOLDOWN_MS = 20 * 60_000;

export function demoMtfFallbackKey(cfg, symbol) {
  // The preset is part of the streak key: switching strategy starts from a clean
  // veto count instead of inheriting the previous preset's tolerated streak.
  return `${cfg.scope || cfg.id || 'owner'}:${symbol}:${cfg.strategyPreset || 'auto'}`;
}

/**
 * Bounded DEMO fallback for the 1h trend veto. A selected preset is authoritative:
 * its RSI band (Safe's strict 40-65) is never overridden, so the fallback only
 * exists for workspaces that have not chosen a preset.
 */
export function createMtfFallbackTracker({
  limit = DEMO_MTF_FALLBACK_VETO_LIMIT,
  waitMs = DEMO_MTF_FALLBACK_WAIT_MS,
  cooldownMs = DEMO_MTF_FALLBACK_COOLDOWN_MS,
} = {}) {
  const state = new Map();

  function track(cfg, symbol, nowMs) {
    const key = demoMtfFallbackKey(cfg, symbol);
    const prev = state.get(key) || { vetos: 0, firstVetoAt: nowMs, lastOverrideAt: 0 };
    const next = { ...prev, vetos: prev.vetos + 1, firstVetoAt: prev.firstVetoAt || nowMs };
    const waitedMs = nowMs - next.firstVetoAt;
    const isDemo = cfg.mode === 'virtual' && !cfg.strategyPreset;
    const enoughVetos = next.vetos >= limit;
    const waitedLongEnough = waitedMs >= waitMs;
    const coolingDown = nowMs - next.lastOverrideAt < cooldownMs;
    const override = isDemo && (enoughVetos || waitedLongEnough) && !coolingDown;
    if (override) {
      state.set(key, { vetos: 0, firstVetoAt: nowMs, lastOverrideAt: nowMs });
    } else {
      state.set(key, next);
    }
    return { override, vetos: next.vetos, waitedMs };
  }

  function clear(cfg, symbol) {
    const key = demoMtfFallbackKey(cfg, symbol);
    const prev = state.get(key);
    if (!prev) return;
    if (prev.lastOverrideAt) {
      state.set(key, { vetos: 0, firstVetoAt: 0, lastOverrideAt: prev.lastOverrideAt });
    } else {
      state.delete(key);
    }
  }

  function reset() {
    state.clear();
  }

  return { track, clear, reset, size: () => state.size };
}

/**
 * Daily max-loss guard (Asia/Dhaka day): pause NEW risk once the realized loss for
 * the current day reaches `dailyMaxLossPct` of that day's opening equity. Exits are
 * never gated by this — only entries and DCA re-buys.
 */
export function evaluateDailyLossGuard({ realizedToday, equity, dailyMaxLossPct }) {
  const realized = Number(realizedToday) || 0;
  const limit = Number(dailyMaxLossPct) || 0;
  const dayOpenEquity = Math.max(1, (Number(equity) || 0) - realized);
  if (limit <= 0) return { halted: false, lossPct: 0, dayOpenEquity, realizedToday: realized };
  const lossPct = realized < 0 ? (Math.abs(realized) / dayOpenEquity) * 100 : 0;
  return { halted: lossPct >= limit, lossPct, dayOpenEquity, realizedToday: realized };
}

/**
 * Smart auto-compounding position sizing: a % of the live workspace balance,
 * clamped above the Binance notional floor so LIVE orders stay valid.
 */
export function resolveEntryNotional(cfg, balance) {
  if (!cfg.autoCompounding) return cfg.lotRequested;
  const pct = Math.min(100, Math.max(0.5, cfg.compoundAllocationPct));
  const sized = (Number(balance) || 0) * (pct / 100);
  const floor = cfg.mode === 'live' ? BINANCE_MIN_ORDER_USDT : 1;
  return Math.max(floor, Number(sized.toFixed(2)));
}

/** Whether the engine may open a brand-new position on any pair this cycle. */
export function canOpenAnotherTrade({
  activeTrades = [],
  maxOpenTrades = 5,
  dailyLossBreached = false,
  crashBlocked = false,
  mode = 'virtual',
  hasCredentials = false,
} = {}) {
  if (dailyLossBreached) return { allowed: false, reason: 'daily-loss-halt' };
  if (crashBlocked) return { allowed: false, reason: 'crash-guard' };
  if (activeTrades.length >= Math.max(1, Number(maxOpenTrades) || 1)) {
    return { allowed: false, reason: 'max-open-trades' };
  }
  if (mode === 'live' && !hasCredentials) return { allowed: false, reason: 'live-missing-keys' };
  return { allowed: true, reason: null };
}

/** Whether one more DCA re-buy is allowed on a pair that already has a position. */
export function planDcaRebuy({
  pairOpen = [],
  livePx,
  cfg,
  notional,
  totalInvested,
  dailyLossBreached = false,
  crashBlocked = false,
} = {}) {
  const open = Array.isArray(pairOpen) ? pairOpen : [];
  if (dailyLossBreached) return { ok: false, reason: 'daily-loss-halt', dropPct: 0 };
  if (crashBlocked) return { ok: false, reason: 'crash-guard', dropPct: 0 };
  if (!cfg?.dcaEnabled) return { ok: false, reason: 'dca-disabled', dropPct: 0 };
  const maxBuys = Math.max(1, Number(cfg.dcaMaxBuys) || 1);
  const lowestEntry = open.length
    ? Math.min(...open.map((t) => Number(t.entry_price) || 0))
    : 0;
  const dropPct = lowestEntry > 0 ? ((lowestEntry - Number(livePx)) / lowestEntry) * 100 : 0;
  if (open.length === 0) return { ok: false, reason: 'no-position', dropPct };
  if (open.length >= maxBuys) return { ok: false, reason: 'dca-cap', dropPct, maxBuys };
  if (dropPct < Number(cfg.dcaStepPct)) return { ok: false, reason: 'dip-too-small', dropPct };
  const cap = Number(cfg.maxPerPair);
  if (Number.isFinite(cap) && totalInvested + Number(notional) > cap) {
    return { ok: false, reason: 'pair-cap', dropPct };
  }
  return { ok: true, reason: null, dropPct, maxBuys };
}

/**
 * The workspace the trader is actually on: the engine switch that is currently ON
 * wins, then the account's own declared trading mode, then the workspace row.
 */
export function resolveReportWorkspaceMode(settings, cfg) {
  if (cfg.liveRunning && !cfg.demoRunning) return 'live';
  if (cfg.demoRunning && !cfg.liveRunning) return 'virtual';
  const accountMode = String(settings?.__account?.trading_mode || '')
    .trim()
    .toLowerCase();
  if (accountMode === 'live' || accountMode === 'virtual') return accountMode;
  const rowMode = String(
    settings?.workspace_mode ?? settings?.trading_mode ?? settings?.mode ?? ''
  )
    .trim()
    .toLowerCase();
  if (rowMode === 'live' || rowMode === 'virtual') return rowMode;
  return cfg.mode;
}

/**
 * Everything the 15s cycle needs comes from the Supabase settings row, so the bot
 * keeps running with zero browser tabs open. `is_running`/`trading_mode` are the
 * canonical columns; the legacy `bot_enabled`/`mode` pair is still honoured.
 *
 * `telegramToken` is injected so this stays pure (the worker passes its env token).
 */
export function resolveTradingConfig(settings, { telegramToken = '' } = {}) {
  const zeroLoss = Boolean(
    settings.zero_loss_shield ?? settings.zero_loss_mode ?? settings.sell_only_in_profit ?? true
  );
  const runFlag = settings.is_running ?? settings.bot_running ?? settings.engine_running;
  const isRunning =
    runFlag === null || runFlag === undefined ? Boolean(settings.bot_enabled) : Boolean(runFlag);
  const mode = normalizeTradingMode(
    settings.workspace_mode ?? settings.trading_mode ?? settings.mode
  );
  // DEMO and LIVE each own an independent power switch. Rows written before those
  // columns existed fall back to the single legacy flag scoped to their own mode.
  const demoFlag = settings.demo_bot_running;
  const liveFlag = settings.live_bot_running;
  const demoRunning =
    demoFlag === null || demoFlag === undefined ? isRunning && mode === 'virtual' : Boolean(demoFlag);
  const liveRunning =
    liveFlag === null || liveFlag === undefined ? isRunning && mode === 'live' : Boolean(liveFlag);
  // One-tap strategy preset chosen in the terminal decides the exact RSI buy band.
  const presetId = resolvePresetId(settings.strategy_preset);
  const rsiBand = presetId ? PRESET_RSI_BANDS[presetId] : null;
  return {
    isRunning: demoRunning || liveRunning,
    strategyPreset: presetId,
    rsiMin: rsiBand ? rsiBand.min : 40,
    rsiMax: rsiBand ? rsiBand.max : mode === 'virtual' ? 78 : 72,
    demoRunning,
    liveRunning,
    mode,
    telegramEnabled: settings.telegram_enabled !== false,
    // One shared @TaseenMarketBot talks to every user; only the chat differs.
    telegramToken: String(
      telegramToken || settings.telegram_bot_token || settings.bot_token || ''
    ).trim(),
    // Strictly this workspace's own chat — never the global TELEGRAM_CHAT_ID.
    telegramChatId: String(settings.chat_id || settings.telegram_chat_id || '').trim(),
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
    // Smart auto-compounding: size each ticket from the live workspace balance.
    autoCompounding: Boolean(settings.auto_compounding),
    compoundAllocationPct: Math.min(
      100,
      Math.max(0.5, Number(settings.compound_allocation_pct ?? 5))
    ),
    // Multi-timeframe bullish filter (15m/5m/1m signals must agree with 1h trend).
    multiTimeframeFilter: settings.multi_timeframe_filter !== false,
  };
}
