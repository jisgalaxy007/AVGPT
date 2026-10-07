const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const BINANCE_BASE = 'https://api.binance.com';

// Segurança: só aceita chamadas internas com uma chave interna compartilhada
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

app.use(express.json());

function verifyInternal(req, res, next) {
  if (INTERNAL_SECRET && req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Proxy genérico para qualquer endpoint da Binance (GET)
// Chamada: GET /proxy?endpoint=/sapi/v1/capital/deposit/hisrec&coin=USDT&...
app.get('/proxy', verifyInternal, async (req, res) => {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;

    if (!apiKey || !apiSecret) {
      return res.status(500).json({ error: 'Binance credentials not configured' });
    }

    // Remove o parâmetro 'endpoint' e usa o restante como query params
    const { endpoint, ...restParams } = req.query;
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint parameter' });
    }

    const timestamp = Date.now();
    const queryParams = new URLSearchParams({
      ...restParams,
      timestamp: timestamp.toString(),
      recvWindow: '60000',
    });
    const queryString = queryParams.toString();
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    const fullUrl = `${BINANCE_BASE}${endpoint}?${queryString}&signature=${signature}`;

    const response = await fetch(fullUrl, {
      headers: { 'X-MBX-APIKEY': apiKey },
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('[Binance Proxy] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'avgpt-binance-proxy',
    region: process.env.FLY_REGION || 'unknown',
    binance_configured: !!(process.env.BINANCE_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[avgpt-binance-proxy] Rodando na porta ${PORT} | Região: ${process.env.FLY_REGION || 'local'}`);
});
