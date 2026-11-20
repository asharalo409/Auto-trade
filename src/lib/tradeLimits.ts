/**
 * Binance Spot rejects new orders below this notional (MIN_NOTIONAL is $5).
 * Mirrored by BINANCE_MIN_ORDER_USDT in worker/bot-worker.mjs.
 */
export const MIN_TRADEABLE_USDT = 5.5;
