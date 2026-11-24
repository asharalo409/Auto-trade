import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BINANCE_MIN_ORDER_USDT,
  PRESET_RSI_BANDS,
  createMtfFallbackTracker,
  evaluateHigherTimeframeTrend,
  resolveEntryNotional,
  resolveReportWorkspaceMode,
  resolveTradingConfig,
} from '../worker/strategy-core.mjs';
import { runReplay } from '../worker/replay.mjs';

/**
 * Replay harness tests for the 24/7 worker's trading loop.
 *
 * Every assertion below runs through the same pure decisions the live 15s cycle
 * calls. The candle fixtures are fixed, so a regression in a guard shows up as a
 * changed trace instead of a real order.
 */

/** Alternating up/down moves, then a tail of flat closes → 20 closes (enough for EMA20). */
function closes(diffs: number[], start = 100): number[] {
  const out = [start];
  for (const diff of diffs) out.push(out[out.length - 1] + diff);
  return out;
}

function alternate(ups: number, downs: number): number[] {
  const diffs: number[] = [];
  let u = ups;
  let d = downs;
  while (u > 0 || d > 0) {
    if (u > 0) {
      diffs.push(1);
      u -= 1;
    }
    if (d > 0) {
      diffs.push(-1);
      d -= 1;
    }
  }
  return diffs;
}

/** Bullish 1h series with RSI ≈ 71.4: outside Safe's 40–65, inside Balanced's 40–72. */
const RSI_71 = closes([...alternate(10, 4), ...Array(5).fill(0)]);
/** Bullish 1h series with RSI ≈ 92.9: above every preset band, including DEMO's relaxed 78. */
const RSI_93 = closes([...alternate(13, 1), ...Array(5).fill(0)]);

const baseVirtual = (overrides: Record<string, unknown> = {}) => ({
  id: 'replay-workspace',
  trading_mode: 'virtual',
  demo_bot_running: true,
  live_bot_running: false,
  enabled_pairs: ['BTCUSDT'],
  multi_timeframe_filter: true,
  take_profit_pct: 1.2,
  trailing_stop_pct: 0.6,
  max_open_trades: 3,
  dca_enabled: true,
  dca_step_pct: 1.5,
  dca_max_buys: 3,
  max_amount_per_pair: 500,
  trade_amount: 10,
  zero_loss_shield: false,
  daily_max_loss_pct: 5,
  virtual_balance: 1000,
  ...overrides,
});

type Step = {
  price: number;
  closes1h?: number[];
  changePct24h?: number;
  quoteVolume?: number;
  crashBlocked?: boolean;
};

const fixture = (steps: Step[], extra: Record<string, unknown> = {}) => ({
  symbol: 'BTCUSDT',
  balance: 1000,
  cycles: steps.map((step) => ({
    closes1h: RSI_71,
    changePct24h: 1.5,
    quoteVolume: 5_000_000,
    ...step,
  })),
  ...extra,
});

const flat = (price: number, count: number, closes1h = RSI_71): Step[] =>
  Array.from({ length: count }, () => ({ price, closes1h }));

test('each preset pins its documented RSI band and unknown ids fall back to auto', () => {
  const safe = resolveTradingConfig({ strategy_preset: 'safe', trading_mode: 'virtual' });
  const balanced = resolveTradingConfig({ strategy_preset: 'balanced', trading_mode: 'virtual' });
  const scalping = resolveTradingConfig({ strategy_preset: 'scalping', trading_mode: 'virtual' });
  const auto = resolveTradingConfig({ strategy_preset: 'nonsense', trading_mode: 'virtual' });
  const autoLive = resolveTradingConfig({ trading_mode: 'live' });

  assert.deepEqual({ min: safe.rsiMin, max: safe.rsiMax }, PRESET_RSI_BANDS.safe);
  assert.deepEqual({ min: balanced.rsiMin, max: balanced.rsiMax }, PRESET_RSI_BANDS.balanced);
  assert.deepEqual({ min: scalping.rsiMin, max: scalping.rsiMax }, PRESET_RSI_BANDS.scalping);
  assert.equal(safe.strategyPreset, 'safe');
  assert.equal(auto.strategyPreset, null);
  assert.deepEqual({ min: auto.rsiMin, max: auto.rsiMax }, { min: 40, max: 78 });
  assert.deepEqual({ min: autoLive.rsiMin, max: autoLive.rsiMax }, { min: 40, max: 72 });
});

test("Safe's 40-65 band holds across a full replay even though the DEMO fallback is armed", () => {
  const tracker = createMtfFallbackTracker();
  const { cfg, trace, state } = runReplay({
    settings: baseVirtual({ strategy_preset: 'safe' }),
    fixture: fixture(flat(100, 10)),
    tracker,
  });

  // The fixture sits inside the relaxed DEMO ceiling (78), so only the preset vetoes it.
  assert.equal(cfg.strategyPreset, 'safe');
  assert.equal(cfg.rsiMax, 65);

  assert.equal(trace.length, 10, 'one decision per replayed cycle');
  assert.deepEqual(
    [...new Set(trace.map((row: any) => row.action))],
    ['SKIP'],
    'no paper entry is taken anywhere in the replay'
  );
  assert.ok(trace.every((row: any) => row.reason === 'mtf-veto'));
  assert.match(String(trace[0].detail), /1h RSI 71\.4 outside the 40-65 buy band/);
  assert.equal(state.open.length, 0);

  // The fallback tracker itself refuses to override a preset — 10 consecutive vetos
  // would have bought three times over without the preset guard.
  const safeCfg = { ...cfg, scope: 'safe-workspace' };
  for (let i = 0; i < 10; i += 1) {
    const decision = tracker.track(safeCfg, 'BTCUSDT', i * 60_000);
    assert.equal(decision.override, false);
  }
});

test('without a preset the bounded DEMO fallback still fires after three vetos', () => {
  const { cfg, trace } = runReplay({
    settings: baseVirtual({ multi_timeframe_filter: true }),
    fixture: fixture(flat(100, 4, RSI_93)),
  });

  assert.equal(cfg.strategyPreset, null);
  assert.equal(cfg.rsiMax, 78, 'relaxed DEMO ceiling applies for auto workspaces');

  const entry = trace.find((row: any) => row.action === 'ENTRY');
  assert.ok(entry, 'the third consecutive veto is overridden');
  assert.equal(entry.cycle, 2);
  assert.equal(entry.reason, 'mtf-fallback');
  assert.deepEqual(
    trace.filter((row: any) => row.cycle < 2).map((row: any) => row.reason),
    ['mtf-veto', 'mtf-veto']
  );
});

test('a Balanced preset accepts the same candles Safe rejects', () => {
  const safe = runReplay({
    settings: baseVirtual({ strategy_preset: 'safe' }),
    fixture: fixture(flat(100, 1)),
  });
  const balanced = runReplay({
    settings: baseVirtual({ strategy_preset: 'balanced' }),
    fixture: fixture(flat(100, 1)),
  });

  assert.equal(safe.trace[0].action, 'SKIP');
  assert.equal(balanced.trace[0].action, 'ENTRY');
  assert.equal(balanced.trace[0].rsi, 71.43);
  assert.equal(balanced.trace[0].notional, 10);
});

test('the 1h trend gate is what vetoes, not a broken fixture', () => {
  const cfg = resolveTradingConfig({ strategy_preset: 'safe', trading_mode: 'virtual' });
  const trend = evaluateHigherTimeframeTrend({ closes: RSI_71, cfg });
  assert.equal(trend.ok, false);
  assert.ok(trend.rsi !== null && trend.rsi > 65 && trend.rsi < 72);
  assert.ok(trend.lastClose! >= trend.ema20!, 'price is above EMA20, so only RSI vetoes');
});

test('DCA stops at the per-pair buy cap', () => {
  const settings = baseVirtual({
    strategy_preset: 'balanced',
    dca_max_buys: 3,
    dca_step_pct: 1.0,
    take_profit_pct: 20,
    trailing_stop_pct: 0,
  });
  const prices = [100, 95, 90, 85, 80];
  const { cfg, trace, state } = runReplay({
    settings,
    fixture: fixture(prices.map((price) => ({ price }))),
  });

  // dca_max_buys caps the lots held per pair, entry included: 3 lots = 2 re-buys.
  assert.equal(cfg.dcaMaxBuys, 3);
  assert.deepEqual(
    trace.map((row: any) => row.action),
    ['ENTRY', 'DCA', 'DCA', 'HOLD', 'HOLD']
  );
  assert.equal(trace.filter((row: any) => row.action === 'DCA').length, 2);
  assert.equal(trace[3].reason, 'dca-cap');
  assert.equal(state.open.length, 3, 'one entry + two re-buys, never a fourth lot');
  assert.equal(
    state.open.reduce((sum: number, row: any) => sum + row.invested_usdt, 0),
    30
  );

  // The cap is a hard ceiling even when the dip keeps deepening.
  const capped = runReplay({
    settings: { ...settings, dca_max_buys: 2 },
    fixture: fixture(prices.map((price) => ({ price }))),
  });
  assert.deepEqual(
    capped.trace.map((row: any) => row.action),
    ['ENTRY', 'DCA', 'HOLD', 'HOLD', 'HOLD']
  );
  assert.equal(capped.state.open.length, 2);
});

test('DCA also stops at the per-pair notional cap', () => {
  const { trace, state } = runReplay({
    settings: baseVirtual({
      strategy_preset: 'balanced',
      dca_step_pct: 1.0,
      max_amount_per_pair: 15,
      take_profit_pct: 20,
      trailing_stop_pct: 0,
    }),
    fixture: fixture([{ price: 100 }, { price: 95 }]),
  });

  assert.equal(trace[1].action, 'HOLD');
  assert.equal(trace[1].reason, 'pair-cap');
  assert.equal(state.open.length, 1);
});

test('the daily-loss guard blocks new entries but not exits', () => {
  const halted = runReplay({
    settings: baseVirtual({ strategy_preset: 'balanced' }),
    fixture: fixture(flat(100, 2), { balance: 940, seededClosedToday: -60 }),
  });

  assert.deepEqual(
    halted.trace.map((row: any) => [row.action, row.reason]),
    [
      ['SKIP', 'daily-loss-halt'],
      ['SKIP', 'daily-loss-halt'],
    ]
  );
  assert.equal(halted.trace[0].dailyLossHalted, true);
  assert.equal(halted.trace[0].dailyLossPct, 6, '60 loss on 1000 opening equity');
  assert.equal(halted.state.open.length, 0);

  // Same day, same halt, but a position already in profit must still be closed.
  const exiting = runReplay({
    settings: baseVirtual({ strategy_preset: 'balanced' }),
    fixture: fixture([{ price: 103 }], {
      balance: 940,
      seededClosedToday: -60,
      seededOpen: [{ entry_price: 100, quantity: 0.1, invested_usdt: 10, peak_price: 101 }],
    }),
  });

  assert.equal(exiting.trace[0].dailyLossHalted, true);
  assert.equal(exiting.trace[0].action, 'TP_EXIT');
  assert.equal(exiting.state.open.length, 0, 'the exit ran despite the halt');
  assert.ok(exiting.state.realizedToday < -59, 'the close is booked on top of the loss');

  // Guard off → the identical candle is tradeable again.
  const allowed = runReplay({
    settings: baseVirtual({ strategy_preset: 'balanced', daily_max_loss_pct: 0 }),
    fixture: fixture(flat(100, 1), { balance: 940, seededClosedToday: -60 }),
  });
  assert.equal(allowed.trace[0].action, 'ENTRY');
  assert.equal(allowed.trace[0].dailyLossHalted, false);
});

test('every live entry respects the $5.50 Binance notional floor', () => {
  assert.equal(BINANCE_MIN_ORDER_USDT, 5.5);
  assert.equal(
    resolveEntryNotional(
      { autoCompounding: true, compoundAllocationPct: 5, mode: 'live', lotRequested: 10 },
      100
    ),
    5.5,
    '5% of $100 is below the exchange minimum, so it is clamped up'
  );
  assert.equal(
    resolveEntryNotional(
      { autoCompounding: true, compoundAllocationPct: 5, mode: 'virtual', lotRequested: 10 },
      100
    ),
    5,
    'DEMO is not bound by the exchange floor'
  );

  const liveSettings = {
    id: 'live-workspace',
    trading_mode: 'live',
    live_bot_running: true,
    demo_bot_running: false,
    enabled_pairs: ['BTCUSDT'],
    multi_timeframe_filter: false,
    auto_compounding: true,
    compound_allocation_pct: 5,
    take_profit_pct: 20,
    trailing_stop_pct: 0,
    balance_usdt: 100,
  };

  const funded = runReplay({
    settings: liveSettings,
    mode: 'live',
    credentials: true,
    fixture: fixture(flat(50, 1)),
  });
  assert.equal(funded.trace[0].action, 'ENTRY');
  assert.equal(funded.trace[0].notional, BINANCE_MIN_ORDER_USDT);

  const underfunded = runReplay({
    settings: { ...liveSettings, balance_usdt: 4 },
    mode: 'live',
    credentials: true,
    fixture: fixture(flat(50, 1)),
  });
  assert.equal(underfunded.trace[0].action, 'SKIP');
  assert.equal(underfunded.trace[0].reason, 'insufficient-live-balance');
  assert.equal(underfunded.state.open.length, 0);
});

test('a live workspace without linked API keys never records a phantom trade', () => {
  const { trace } = runReplay({
    settings: {
      id: 'no-keys',
      trading_mode: 'live',
      live_bot_running: true,
      enabled_pairs: ['BTCUSDT'],
      multi_timeframe_filter: false,
      balance_usdt: 500,
    },
    mode: 'live',
    credentials: false,
    fixture: fixture(flat(50, 2)),
  });

  assert.deepEqual(
    trace.map((row: any) => [row.action, row.reason]),
    [
      ['SKIP', 'live-missing-keys'],
      ['SKIP', 'live-missing-keys'],
    ]
  );
});

test('the daily report mode follows the workspace the trader is actually on', () => {
  const demoSwitch = resolveTradingConfig({
    trading_mode: 'live', // stale row: the DEMO switch is the truth
    demo_bot_running: true,
    live_bot_running: false,
  });
  assert.equal(resolveReportWorkspaceMode({ trading_mode: 'live' }, demoSwitch), 'virtual');

  const liveSwitch = resolveTradingConfig({
    trading_mode: 'virtual',
    demo_bot_running: false,
    live_bot_running: true,
  });
  assert.equal(resolveReportWorkspaceMode({ trading_mode: 'virtual' }, liveSwitch), 'live');

  const idleWithAccount = resolveTradingConfig({ trading_mode: 'virtual' });
  assert.equal(
    resolveReportWorkspaceMode(
      { trading_mode: 'virtual', __account: { trading_mode: 'live' } },
      idleWithAccount
    ),
    'live',
    "the account's own mode outranks the stale workspace row"
  );
  assert.equal(resolveReportWorkspaceMode({ trading_mode: 'virtual' }, idleWithAccount), 'virtual');

  // End-to-end through the replay: DEMO engine running on a row that claims LIVE.
  const replay = runReplay({
    settings: baseVirtual({ strategy_preset: 'balanced', trading_mode: 'live' }),
    fixture: fixture(flat(100, 1)),
  });
  assert.equal(replay.reportMode, 'virtual');
});

test('the crash guard pauses entries and resumes after it clears', () => {
  const blocked = runReplay({
    settings: baseVirtual({ strategy_preset: 'balanced' }),
    fixture: fixture([{ price: 100, crashBlocked: true }, { price: 100 }]),
  });

  assert.equal(blocked.trace[0].action, 'SKIP');
  assert.equal(blocked.trace[0].reason, 'crash-guard');
  assert.equal(blocked.trace[1].action, 'ENTRY');
});
