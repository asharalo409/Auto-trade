import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

const BINANCE_MAINNET_ENDPOINTS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];
const BINANCE_TESTNET_ENDPOINTS = ['https://testnet.binance.vision'];

let cachedPublicIp: string | null = null;
let cachedPublicIpAt = 0;

async function getServerPublicIp(): Promise<string | null> {
  if (cachedPublicIp && Date.now() - cachedPublicIpAt < 5 * 60_000) {
    return cachedPublicIp;
  }
  const ipRegex = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})\b/;
  for (const url of ['https://api.ipify.org?format=json', 'https://ifconfig.me/ip']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
      if (!res.ok) continue;
      const raw = await res.text();
      const match = raw.match(ipRegex);
      if (match) {
        cachedPublicIp = match[1];
        cachedPublicIpAt = Date.now();
        return cachedPublicIp;
      }
    } catch {
      // try next IP lookup
    }
  }
  return cachedPublicIp;
}

function signQuery(queryString: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function fetchBinanceTickerPrices(useTestnet: boolean): Promise<Map<string, number>> {
  const endpoints = useTestnet
    ? BINANCE_TESTNET_ENDPOINTS
    : ['https://data-api.binance.vision', ...BINANCE_MAINNET_ENDPOINTS];

  const priceMap = new Map<string, number>();
  for (const base of endpoints) {
    try {
      const res = await fetch(`${base}/api/v3/ticker/price`, {
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const rows = (await res.json()) as Array<{ symbol: string; price: string }>;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const p = Number(row.price);
          if (row.symbol && Number.isFinite(p) && p > 0) {
            priceMap.set(row.symbol, p);
          }
        }
        return priceMap;
      }
    } catch {
      // try next endpoint
    }
  }
  return priceMap;
}

export const APYHUB_EMAIL_URL =
  'https://api.eu.apyhub.com/apyhub/verify-email-validity-and-deliverability';
const APYHUB_TIMEOUT_MS = 9000;

export interface ApyhubEmailCheck {
  ok: boolean;
  status: 'valid' | 'invalid' | 'not_configured' | 'unavailable';
  data?: boolean;
  upstreamStatus?: number | null;
  detail?: string;
}

/**
 * ApyHub email checks: format, domain (MX) and — unless disabled — disposable domains.
 * This confirms the address can receive mail; it is NOT a mailbox ownership check.
 * `data` is the documented boolean verdict. Transport/auth problems are reported as
 * `unavailable` so callers can tell them apart from a genuinely invalid address.
 */
export async function verifyEmailWithApyhub(
  email: string,
  options: { token?: string; disposableChecks?: boolean; timeoutMs?: number } = {}
): Promise<ApyhubEmailCheck> {
  const token = String(options.token ?? '').trim();
  if (!token) {
    return {
      ok: false,
      status: 'not_configured',
      upstreamStatus: null,
      detail: 'APY_TOKEN is not configured on the server',
    };
  }

  const disposableChecks = options.disposableChecks !== false;

  try {
    const apyRes = await fetch(APYHUB_EMAIL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apy-token': token,
      },
      body: JSON.stringify({ email, disposable_checks: disposableChecks }),
      signal: AbortSignal.timeout(options.timeoutMs ?? APYHUB_TIMEOUT_MS),
    });

    const payload = (await apyRes.json().catch(() => ({}))) as {
      data?: unknown;
      message?: string;
      error?: string;
    };

    if (apyRes.status === 429) {
      return {
        ok: false,
        status: 'unavailable',
        upstreamStatus: 429,
        detail: 'ApyHub rate limit reached — try again in a moment',
      };
    }

    if (apyRes.status === 401 || apyRes.status === 403) {
      return {
        ok: false,
        status: 'unavailable',
        upstreamStatus: apyRes.status,
        detail: `ApyHub rejected APY_TOKEN (HTTP ${apyRes.status})`,
      };
    }

    if (apyRes.status >= 500) {
      return {
        ok: false,
        status: 'unavailable',
        upstreamStatus: apyRes.status,
        detail: `ApyHub service error (HTTP ${apyRes.status})`,
      };
    }

    if (!apyRes.ok) {
      return {
        ok: false,
        status: 'unavailable',
        upstreamStatus: apyRes.status,
        detail:
          payload.message || payload.error || `ApyHub rejected the request (HTTP ${apyRes.status})`,
      };
    }

    if (typeof payload.data !== 'boolean') {
      return {
        ok: false,
        status: 'unavailable',
        upstreamStatus: apyRes.status,
        detail: 'ApyHub response did not include a boolean `data` verdict',
      };
    }

    return {
      ok: true,
      status: payload.data ? 'valid' : 'invalid',
      data: payload.data,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      status: 'unavailable',
      upstreamStatus: isTimeout ? 504 : null,
      detail: isTimeout
        ? 'ApyHub request timed out'
        : err instanceof Error
          ? `ApyHub unreachable: ${err.message}`
          : 'ApyHub unreachable',
    };
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/api/server-ip', async (_req, res) => {
    const ip = await getServerPublicIp();
    res.json({ ok: Boolean(ip), ip });
  });

  // Server-side Telegram proxy (prevents client ISP/CORS/network failures)
  app.post('/api/telegram/send', async (req, res) => {
    const rawToken = String(req.body?.botToken ?? '').trim().replace(/^["']|["']$/g, '');
    const cleanToken = rawToken.replace(/^bot/i, '').trim();
    const chatId = String(req.body?.chatId ?? '').trim();
    const text = String(req.body?.text ?? '').trim();
    const maskedToken =
      cleanToken.length > 10
        ? `${cleanToken.slice(0, 6)}...${cleanToken.slice(-4)}`
        : '(invalid)';

    if (!cleanToken || !chatId || !text) {
      console.warn('[TELEGRAM PROXY] Rejecting incomplete payload:', {
        hasToken: Boolean(cleanToken),
        hasChatId: Boolean(chatId),
        textLength: text.length,
      });
      return res.status(400).json({
        ok: false,
        detail: 'Missing Telegram Bot Token, Chat ID, or message text',
      });
    }

    const endpoint = `https://api.telegram.org/bot${cleanToken}/sendMessage`;
    const maskedEndpoint = `https://api.telegram.org/bot${maskedToken}/sendMessage`;

    try {
      const tgRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const data = (await tgRes.json().catch(() => ({}))) as {
        ok?: boolean;
        error_code?: number;
        description?: string;
        result?: { message_id?: number };
      };

      if (!tgRes.ok || !data.ok) {
        console.warn(
          `[TELEGRAM PROXY] Rejected by Telegram (HTTP ${tgRes.status}, code=${data.error_code ?? 'none'}, endpoint=${maskedEndpoint}): ${data.description ?? 'unknown'}`
        );
        return res.status(200).json({
          ok: false,
          upstreamStatus: tgRes.status,
          errorCode: data.error_code ?? null,
          endpoint: maskedEndpoint,
          detail: data.description || `Telegram HTTP ${tgRes.status}`,
        });
      }

      console.info('[TELEGRAM PROXY OK]', {
        endpoint: maskedEndpoint,
        chatId,
        messageId: data.result?.message_id ?? null,
      });

      return res.json({
        ok: true,
        detail: 'Dispatched to Telegram',
        messageId: data.result?.message_id ?? null,
        endpoint: maskedEndpoint,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to reach Telegram Bot API';
      console.warn(`[TELEGRAM PROXY NETWORK] endpoint=${maskedEndpoint} error=${msg}`);
      return res.status(200).json({
        ok: false,
        upstreamStatus: 502,
        endpoint: maskedEndpoint,
        detail: msg,
      });
    }
  });

  // Server-side ApyHub email validation (APY_TOKEN never leaves the server)
  app.post('/api/email/validate', async (req, res) => {
    const email = String(req.body?.email ?? '').trim();
    // Disposable-domain rejection stays on unless a caller explicitly opts out.
    const disposableChecks = req.body?.disposable_checks !== false;

    if (!email || email.length > 254 || !email.includes('@')) {
      return res.status(400).json({
        ok: false,
        status: 'invalid_input',
        data: null,
        detail: 'A valid email address is required',
      });
    }

    const result = await verifyEmailWithApyhub(email, {
      token: process.env.APY_TOKEN,
      disposableChecks,
    });

    const domain = email.split('@').pop()?.toLowerCase() ?? '';
    console.info('[APYHUB EMAIL CHECK]', {
      domain,
      status: result.status,
      data: result.data ?? null,
      upstreamStatus: result.upstreamStatus ?? 200,
      disposableChecks,
    });

    return res.status(200).json({ ...result, disposableChecks });
  });

  // Server-side signed Binance Spot + All-Wallet (Funding/Earn/Margin) Real Balance endpoint
  app.post('/api/binance/balance', async (req, res) => {
    const apiKey = String(req.body?.apiKey ?? '').replace(/^["'\s]+|["'\s]+$/g, '');
    const apiSecret = String(req.body?.apiSecret ?? '').replace(/^["'\s]+|["'\s]+$/g, '');
    const useTestnet = Boolean(req.body?.useTestnet);

    if (!apiKey || !apiSecret) {
      return res.status(400).json({
        ok: false,
        detail: 'Missing Binance API Key or Secret',
      });
    }

    const endpoints = useTestnet ? BINANCE_TESTNET_ENDPOINTS : BINANCE_MAINNET_ENDPOINTS;
    let lastErrorDetail = 'Unable to reach Binance Spot API';
    let lastStatus = 502;
    let lastCode: number | null = null;

    for (const base of endpoints) {
      try {
        // Sync server time to avoid timestamp drift (-1021)
        let serverTime = Date.now();
        try {
          const timeRes = await fetch(`${base}/api/v3/time`, {
            signal: AbortSignal.timeout(4000),
          });
          if (timeRes.ok) {
            const timeJson = (await timeRes.json()) as { serverTime?: number };
            if (typeof timeJson.serverTime === 'number') {
              serverTime = timeJson.serverTime;
            }
          }
        } catch {
          // fallback to local Date.now()
        }

        const buildSignedUrl = (apiPath: string, extra: Record<string, string> = {}) => {
          const p = new URLSearchParams({
            ...extra,
            recvWindow: '15000',
            timestamp: String(serverTime),
          });
          p.set('signature', signQuery(p.toString(), apiSecret));
          return `${base}${apiPath}?${p.toString()}`;
        };

        const accountRes = await fetch(
          buildSignedUrl('/api/v3/account', { omitZeroBalances: 'true' }),
          {
            method: 'GET',
            headers: { 'X-MBX-APIKEY': apiKey },
            signal: AbortSignal.timeout(9000),
          }
        );

        const data = (await accountRes.json().catch(() => ({}))) as {
          code?: number;
          msg?: string;
          canTrade?: boolean;
          accountType?: string;
          balances?: Array<{ asset: string; free: string; locked: string }>;
        };

        if (accountRes.status === 418 || accountRes.status === 429 || accountRes.status >= 500) {
          lastStatus = accountRes.status;
          lastErrorDetail = data.msg || `Binance HTTP ${accountRes.status} (${base})`;
          continue;
        }

        if (!accountRes.ok) {
          lastStatus = accountRes.status;
          lastCode = typeof data.code === 'number' ? data.code : null;
          lastErrorDetail = data.msg || `Binance HTTP ${accountRes.status}`;
          console.warn(
            `[BINANCE BALANCE] Upstream rejected (${base}, HTTP ${accountRes.status}, code=${lastCode ?? 'none'}): ${lastErrorDetail}`
          );
          // Geo-block (451): try next endpoint, stop on auth/IP/signature error
          if (accountRes.status === 451) continue;
          const serverIp = await getServerPublicIp();
          let friendlyDetail = lastErrorDetail;
          if (lastCode === -2015) {
            friendlyDetail = `${lastErrorDetail} — Whitelist Server IP ${serverIp ?? '(see below)'}, enable 'Reading' permission, and check Mainnet/Testnet.`;
          } else if (lastCode === -1022) {
            friendlyDetail = `${lastErrorDetail} — Double-check your Binance API Secret for typos or extra spaces.`;
          }
          return res.status(200).json({
            ok: false,
            upstreamStatus: accountRes.status,
            code: lastCode,
            detail: friendlyDetail,
            serverIp,
          });
        }

        const prices = await fetchBinanceTickerPrices(useTestnet);
        const stableCoins = new Set(['USDT', 'FDUSD', 'USDC', 'BUSD', 'TUSD']);
        const valueAssetUsd = (asset: string, total: number): number => {
          if (!Number.isFinite(total) || total <= 0) return 0;
          if (stableCoins.has(asset)) return total;
          const directPrice = prices.get(`${asset}USDT`) ?? prices.get(`${asset}FDUSD`);
          if (directPrice) return total * directPrice;
          if (asset === 'BTC') return total * (prices.get('BTCUSDT') ?? 0);
          const btcRatio = prices.get(`${asset}BTC`);
          const btcUsd = prices.get('BTCUSDT');
          if (btcRatio && btcUsd) return total * btcRatio * btcUsd;
          return 0;
        };

        let usdtFree = 0;
        let usdtLocked = 0;
        let stablecoinUsd = 0;
        let spotUsd = 0;
        let fundingUsd = 0;
        let earnUsd = 0;

        const assetsMap = new Map<
          string,
          { asset: string; free: number; locked: number; total: number; usdValue: number }
        >();

        const mergeAsset = (asset: string, free: number, locked: number, usdValue: number) => {
          const prev = assetsMap.get(asset);
          const total = free + locked;
          if (prev) {
            prev.free = Number((prev.free + free).toFixed(6));
            prev.locked = Number((prev.locked + locked).toFixed(6));
            prev.total = Number((prev.total + total).toFixed(6));
            prev.usdValue = Number((prev.usdValue + usdValue).toFixed(2));
          } else {
            assetsMap.set(asset, {
              asset,
              free: Number(free.toFixed(6)),
              locked: Number(locked.toFixed(6)),
              total: Number(total.toFixed(6)),
              usdValue: Number(usdValue.toFixed(2)),
            });
          }
        };

        for (const row of data.balances ?? []) {
          const free = Number(row.free || 0);
          const locked = Number(row.locked || 0);
          const total = free + locked;
          if (!Number.isFinite(total) || total <= 0) continue;

          const usdValue = valueAssetUsd(row.asset, total);
          if (row.asset === 'USDT') {
            usdtFree += free;
            usdtLocked += locked;
            stablecoinUsd += total;
          } else if (stableCoins.has(row.asset)) {
            stablecoinUsd += total;
          }
          spotUsd += usdValue;
          mergeAsset(row.asset, free, locked, usdValue);
        }

        const walletBreakdown: Array<{ walletName: string; balanceUsd: number }> = [];
        let allWalletTotalUsd: number | null = null;

        // Query Binance Funding, Simple Earn & Cross-Wallet overview on Mainnet
        // (Many users hold USDT in Funding/Overview/Earn rather than Spot)
        if (!useTestnet) {
          const [fundingResult, earnResult, walletsResult] = await Promise.allSettled([
            fetch(buildSignedUrl('/sapi/v1/asset/get-funding-asset'), {
              method: 'POST',
              headers: { 'X-MBX-APIKEY': apiKey },
              signal: AbortSignal.timeout(5000),
            }).then(async (r) => (r.ok ? r.json() : [])),
            fetch(buildSignedUrl('/sapi/v1/simple-earn/flexible/position', { size: '50' }), {
              method: 'GET',
              headers: { 'X-MBX-APIKEY': apiKey },
              signal: AbortSignal.timeout(5000),
            }).then(async (r) => (r.ok ? r.json() : null)),
            fetch(buildSignedUrl('/sapi/v1/asset/wallet/balance', { quoteAsset: 'USDT' }), {
              method: 'GET',
              headers: { 'X-MBX-APIKEY': apiKey },
              signal: AbortSignal.timeout(5000),
            }).then(async (r) => (r.ok ? r.json() : null)),
          ]);

          if (fundingResult.status === 'fulfilled' && Array.isArray(fundingResult.value)) {
            for (const row of fundingResult.value as Array<{
              asset?: string;
              free?: string;
              locked?: string;
              freeze?: string;
            }>) {
              const asset = String(row.asset || '').trim();
              if (!asset) continue;
              const free = Number(row.free || 0);
              const locked = Number(row.locked || 0) + Number(row.freeze || 0);
              const total = free + locked;
              if (!Number.isFinite(total) || total <= 0) continue;
              const usdValue = valueAssetUsd(asset, total);
              fundingUsd += usdValue;
              if (asset === 'USDT') {
                usdtFree += free;
                usdtLocked += locked;
                stablecoinUsd += total;
              } else if (stableCoins.has(asset)) {
                stablecoinUsd += total;
              }
              mergeAsset(asset, free, locked, usdValue);
            }
          }

          if (
            earnResult.status === 'fulfilled' &&
            earnResult.value &&
            Array.isArray((earnResult.value as { rows?: unknown[] }).rows)
          ) {
            for (const row of (earnResult.value as {
              rows: Array<{ asset?: string; totalAmount?: string }>;
            }).rows) {
              const asset = String(row.asset || '').trim();
              const total = Number(row.totalAmount || 0);
              if (!asset || !Number.isFinite(total) || total <= 0) continue;
              const usdValue = valueAssetUsd(asset, total);
              earnUsd += usdValue;
              if (asset === 'USDT') {
                usdtLocked += total;
                stablecoinUsd += total;
              } else if (stableCoins.has(asset)) {
                stablecoinUsd += total;
              }
              mergeAsset(asset, 0, total, usdValue);
            }
          }

          if (walletsResult.status === 'fulfilled' && Array.isArray(walletsResult.value)) {
            let sum = 0;
            for (const w of walletsResult.value as Array<{
              activate?: boolean;
              balance?: string;
              walletName?: string;
            }>) {
              const bal = Number(w.balance || 0);
              if (Number.isFinite(bal) && bal > 0) {
                sum += bal;
                walletBreakdown.push({
                  walletName: String(w.walletName || 'Wallet'),
                  balanceUsd: Number(bal.toFixed(2)),
                });
              }
            }
            if (sum > 0) {
              allWalletTotalUsd = sum;
            }
          }
        }

        const assets = Array.from(assetsMap.values()).sort((a, b) => b.usdValue - a.usdValue);
        const combinedCoinUsd = spotUsd + fundingUsd + earnUsd;
        const totalPortfolioUsd =
          allWalletTotalUsd !== null && allWalletTotalUsd > combinedCoinUsd
            ? allWalletTotalUsd
            : combinedCoinUsd;

        if (walletBreakdown.length === 0) {
          if (spotUsd > 0) walletBreakdown.push({ walletName: 'Spot', balanceUsd: Number(spotUsd.toFixed(2)) });
          if (fundingUsd > 0) walletBreakdown.push({ walletName: 'Funding', balanceUsd: Number(fundingUsd.toFixed(2)) });
          if (earnUsd > 0) walletBreakdown.push({ walletName: 'Earn', balanceUsd: Number(earnUsd.toFixed(2)) });
        }

        console.info('[BINANCE BALANCE OK]', {
          base,
          spotUsd: Number(spotUsd.toFixed(2)),
          fundingUsd: Number(fundingUsd.toFixed(2)),
          earnUsd: Number(earnUsd.toFixed(2)),
          totalPortfolioUsd: Number(totalPortfolioUsd.toFixed(2)),
          assetCount: assets.length,
        });

        return res.json({
          ok: true,
          usdtFree: Number(usdtFree.toFixed(2)),
          usdtLocked: Number(usdtLocked.toFixed(2)),
          totalUsdt: Number((usdtFree + usdtLocked).toFixed(2)),
          stablecoinUsd: Number(stablecoinUsd.toFixed(2)),
          spotUsd: Number(spotUsd.toFixed(2)),
          fundingUsd: Number(fundingUsd.toFixed(2)),
          earnUsd: Number(earnUsd.toFixed(2)),
          totalPortfolioUsd: Number(totalPortfolioUsd.toFixed(2)),
          walletBreakdown,
          assets: assets.slice(0, 12),
          canTrade: Boolean(data.canTrade),
          accountType: data.accountType ?? 'SPOT',
          lastSyncedAt: new Date().toISOString(),
        });
      } catch (err) {
        lastErrorDetail = err instanceof Error ? err.message : 'Network error reaching Binance';
        console.warn(`[BINANCE BALANCE] Fetch exception (${base}): ${lastErrorDetail}`);
      }
    }

    const serverIp = await getServerPublicIp();
    return res.status(200).json({
      ok: false,
      upstreamStatus: lastStatus,
      code: lastCode,
      detail: lastErrorDetail,
      serverIp,
    });
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[AEGIS SERVER] Listening on http://0.0.0.0:${PORT} (${IS_PROD ? 'prod' : 'dev'})`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    console.error('[AEGIS SERVER FATAL]', err);
    process.exit(1);
  });
}
