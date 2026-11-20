/**
 * AEGIS QUANT — shareable PnL card renderer.
 *
 * Builds a dark-gold/emerald 1080x1080 PNG for every profitable close so the
 * Telegram alert can carry the same visual card the web terminal shows.
 * `@napi-rs/canvas` is imported lazily: when the native binary is unavailable on
 * the host the caller simply falls back to the text alert instead of crashing.
 */

import { fileURLToPath } from 'node:url';

const CARD_SIZE = 1080;
/** Bundled TTFs so the card renders identically on a fontless container. */
const FONT_DIR = fileURLToPath(new URL('./assets/fonts/', import.meta.url));
const HEAD_FONT = 'AegisDisplay';
const MONO_FONT = 'AegisMono';
const head = (size) => `bold ${size}px "${HEAD_FONT}"`;
const mono = (size) => `${size}px "${MONO_FONT}"`;

let canvasModulePromise = null;

async function loadCanvasModule() {
  if (!canvasModulePromise) {
    canvasModulePromise = import('@napi-rs/canvas').catch((err) => {
      console.warn('[PNL CARD] @napi-rs/canvas unavailable:', err.message);
      return null;
    });
  }
  return canvasModulePromise;
}

function money(value, digits = 2) {
  const n = Number(value || 0);
  return `$${Math.abs(n).toFixed(digits)}`;
}

function priceText(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '$0.00';
  if (n >= 1000)
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * @returns {Promise<Buffer|null>} PNG buffer, or null when the renderer is unavailable.
 */
export async function renderPnlCard({
  symbol,
  side = 'LONG SPOT',
  roiPct = 0,
  netProfitUsd = 0,
  entryPrice = 0,
  exitPrice = 0,
  mode = 'LIVE',
  closedAt = new Date(),
} = {}) {
  const canvasLib = await loadCanvasModule();
  if (!canvasLib?.createCanvas) return null;

  try {
    const { createCanvas, GlobalFonts } = canvasLib;
    try {
      GlobalFonts.registerFromPath(`${FONT_DIR}Rajdhani-Bold.ttf`, HEAD_FONT);
      GlobalFonts.registerFromPath(`${FONT_DIR}ShareTechMono-Regular.ttf`, MONO_FONT);
    } catch (err) {
      console.warn('[PNL CARD] font registration failed:', err.message);
    }

    const canvas = createCanvas(CARD_SIZE, CARD_SIZE);
    const ctx = canvas.getContext('2d');

    // Background: deep terminal black with a cyan/emerald bloom.
    const bg = ctx.createLinearGradient(0, 0, CARD_SIZE, CARD_SIZE);
    bg.addColorStop(0, '#05080d');
    bg.addColorStop(0.55, '#071019');
    bg.addColorStop(1, '#03060a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);

    const glow = ctx.createRadialGradient(820, 150, 40, 820, 150, 760);
    glow.addColorStop(0, 'rgba(16, 185, 129, 0.30)');
    glow.addColorStop(0.45, 'rgba(20, 120, 160, 0.12)');
    glow.addColorStop(1, 'rgba(3, 6, 10, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);

    // Cyber grid.
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.09)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= CARD_SIZE; i += 60) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, CARD_SIZE);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(CARD_SIZE, i);
      ctx.stroke();
    }

    // Card frame with gold-emerald border.
    const frame = ctx.createLinearGradient(80, 80, CARD_SIZE - 80, CARD_SIZE - 80);
    frame.addColorStop(0, '#f5c76a');
    frame.addColorStop(0.5, '#10b981');
    frame.addColorStop(1, '#38bdf8');
    ctx.strokeStyle = frame;
    ctx.lineWidth = 4;
    roundRect(ctx, 56, 56, CARD_SIZE - 112, CARD_SIZE - 112, 46);
    ctx.stroke();

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // Branding.
    ctx.fillStyle = '#f5c76a';
    ctx.font = head(74);
    ctx.fillText('AEGIS QUANT', 112, 196);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.95)';
    ctx.font = mono(26);
    ctx.fillText('MARKET TERMINAL PRO', 114, 240);

    // Mode pill.
    ctx.textAlign = 'right';
    ctx.fillStyle = mode === 'LIVE' ? 'rgba(244, 63, 94, 0.18)' : 'rgba(56, 189, 248, 0.16)';
    roundRect(ctx, CARD_SIZE - 300, 130, 188, 62, 31);
    ctx.fill();
    ctx.fillStyle = mode === 'LIVE' ? '#fda4af' : '#7dd3fc';
    ctx.font = mono(24);
    ctx.fillText(mode === 'LIVE' ? 'LIVE SPOT' : 'DEMO ENGINE', CARD_SIZE - 206, 172);

    // Pair + side.
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f8fafc';
    ctx.font = head(118);
    ctx.fillText(String(symbol || 'BTCUSDT'), 110, 408);
    ctx.fillStyle = '#34d399';
    ctx.font = mono(30);
    ctx.fillText(String(side).toUpperCase(), 116, 450);

    // ROI.
    const roi = Number(roiPct || 0);
    ctx.fillStyle = '#64748b';
    ctx.font = mono(24);
    ctx.fillText('RETURN ON INVESTMENT', 112, 552);
    ctx.fillStyle = roi >= 0 ? '#34d399' : '#fb7185';
    ctx.font = head(176);
    ctx.fillText(`${roi >= 0 ? '+' : '-'}${Math.abs(roi).toFixed(2)}%`, 106, 706);

    // Net profit.
    const profit = Number(netProfitUsd || 0);
    ctx.fillStyle = '#64748b';
    ctx.font = mono(24);
    ctx.fillText('NET PROFIT', 112, 770);
    ctx.fillStyle = profit >= 0 ? '#a7f3d0' : '#fecdd3';
    ctx.font = head(84);
    ctx.fillText(`${profit >= 0 ? '+' : '-'}${money(profit)} USD`, 108, 852);

    // Entry / exit panels.
    const panelY = 864;
    const panelW = 400;
    const panels = [
      { label: 'ENTRY PRICE', value: priceText(entryPrice) },
      { label: 'EXIT PRICE', value: priceText(exitPrice) },
    ];
    panels.forEach((panel, index) => {
      const x = 112 + index * (panelW + 44);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
      roundRect(ctx, x, panelY, panelW, 100, 20);
      ctx.fill();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
      ctx.lineWidth = 1.5;
      roundRect(ctx, x, panelY, panelW, 100, 20);
      ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.font = mono(20);
      ctx.fillText(panel.label, x + 24, panelY + 38);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = head(46);
      ctx.fillText(panel.value, x + 24, panelY + 86);
    });

    // Footer.
    ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
    ctx.font = mono(20);
    const stamp = new Date(closedAt instanceof Date ? closedAt : Date.now())
      .toISOString()
      .replace('T', ' ')
      .slice(0, 16);
    ctx.fillText(`CLOSED ${stamp} UTC`, 112, 1008);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(245, 199, 106, 0.9)';
    ctx.fillText('auto-trade-qxp7.onrender.com', CARD_SIZE - 112, 1008);

    return canvas.toBuffer('image/png');
  } catch (err) {
    console.warn('[PNL CARD] render failed:', err.message);
    return null;
  }
}
