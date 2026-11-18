import express from 'express';
import { createServer as createViteServer } from 'vite';
import crypto from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  app.use(express.json());

  // Binance Spot Account Verification Proxy endpoint
  app.post('/api/binance/verify', async (req, res) => {
    try {
      const { apiKey, apiSecret, useTestnet } = req.body;
      if (!apiKey || !apiSecret) {
        return res.status(400).json({ ok: false, detail: 'API Key and Secret required' });
      }

      const endpoints = useTestnet
        ? ['https://testnet.binance.vision']
        : ['https://api1.binance.com', 'https://api2.binance.com', 'https://api3.binance.com'];

      let lastErr = null;
      for (const base of endpoints) {
        try {
          const timestamp = String(Date.now());
          const query = `recvWindow=15000&timestamp=${timestamp}`;
          const signature = crypto.createHmac('sha256', apiSecret.trim()).update(query).digest('hex');

          const response = await fetch(`${base}/api/v3/account?${query}&signature=${signature}`, {
            method: 'GET',
            headers: { 'X-MBX-APIKEY': apiKey.trim() },
            signal: AbortSignal.timeout(8000),
          });

          const data = await response.json();
          if (response.status === 418 || response.status === 429 || response.status >= 500) {
            lastErr = new Error(`Binance HTTP ${response.status}`);
            continue;
          }
          if (!response.ok) {
            return res.status(400).json({ ok: false, detail: data.msg || `Binance HTTP ${response.status}` });
          }

          const usdt = data.balances?.find((b: { asset: string }) => b.asset === 'USDT');
          const totalUsdt = usdt ? Number((Number(usdt.free || 0) + Number(usdt.locked || 0)).toFixed(2)) : 0;

          return res.json({
            ok: true,
            balance: totalUsdt,
            detail: `Connected! Live Spot Balance: $${totalUsdt.toFixed(2)} USDT`,
          });
        } catch (err: any) {
          lastErr = err;
        }
      }

      return res.status(400).json({
        ok: false,
        detail: lastErr?.message || 'Failed to connect to Binance endpoints. Check API Key/Secret.',
      });
    } catch (err: any) {
      return res.status(500).json({ ok: false, detail: err.message || 'Server verification error' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`[AEGIS SERVER] Running on port ${port}`);
  });
}

startServer();
