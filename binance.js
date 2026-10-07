/**
 * binance.js
 * Módulo de integração Binance para o AVGPT.
 * 
 * Como a Binance bloqueia requisições vindas da África do Sul (jnb),
 * as chamadas são roteadas através do app avgpt-binance-proxy em São Paulo (gru),
 * de onde a Binance API é acessível sem restrições.
 */

const PROXY_URL = process.env.BINANCE_PROXY_URL || 'https://avgpt-binance-proxy.fly.dev';
const PROXY_SECRET = process.env.BINANCE_PROXY_SECRET || '';

/**
 * Faz uma requisição ao proxy Binance em gru
 */
async function proxyRequest(endpoint, params = {}) {
  const queryParams = new URLSearchParams({ endpoint, ...params });
  const url = `${PROXY_URL}/proxy?${queryParams.toString()}`;

  const response = await fetch(url, {
    headers: {
      'x-internal-secret': PROXY_SECRET,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data.msg || data.error || JSON.stringify(data);
    throw new Error(`Binance Proxy Erro (${response.status}): ${errorMsg}`);
  }

  return data;
}

/**
 * 1. Histórico de Depósitos Cripto Recebidos (USDT, BTC, ETH, etc.)
 */
async function getDepositHistory(options = {}) {
  const params = {};
  if (options.coin) params.coin = options.coin.toUpperCase();
  if (options.status !== undefined) params.status = String(options.status);
  if (options.limit) params.limit = String(options.limit);
  if (options.startTime) params.startTime = String(options.startTime);
  if (options.endTime) params.endTime = String(options.endTime);

  return await proxyRequest('/sapi/v1/capital/deposit/hisrec', params);
}

/**
 * 2. Histórico de Depósitos Fiat Recebidos (PIX, BRL, EUR, USD)
 */
async function getFiatOrders(options = {}) {
  const params = { transactionType: '0' }; // 0 = Depósito
  if (options.beginTime) params.beginTime = String(options.beginTime);
  if (options.endTime) params.endTime = String(options.endTime);
  if (options.page) params.page = String(options.page);
  if (options.rows) params.rows = String(options.rows || 50);

  return await proxyRequest('/sapi/v1/fiat/orders', params);
}

/**
 * 3. Histórico de Transações Binance Pay
 */
async function getPayHistory(options = {}) {
  const params = {};
  if (options.limit) params.limit = String(options.limit);
  if (options.startTimestamp) params.startTimestamp = String(options.startTimestamp);
  if (options.endTimestamp) params.endTimestamp = String(options.endTimestamp);

  const res = await proxyRequest('/sapi/v1/pay/transactions', params);
  return res.data || res || [];
}

/**
 * 4. Saldos da Conta Spot
 */
async function getAccountBalances() {
  const account = await proxyRequest('/api/v3/account');
  const balances = (account.balances || []).filter(
    (b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
  );
  return {
    canTrade: account.canTrade,
    canDeposit: account.canDeposit,
    canWithdraw: account.canWithdraw,
    balances,
  };
}

module.exports = {
  getDepositHistory,
  getFiatOrders,
  getPayHistory,
  getAccountBalances,
};
