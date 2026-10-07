/**
 * binance.js
 * Módulo de integração Binance para o AVGPT.
 * 
 * Roteado através do proxy avgpt-binance-proxy em São Paulo (gru)
 * para contornar o bloqueio geográfico de IPs sul-africanos.
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
 * 1. Histórico de Depósitos Cripto Recebidos (USDT, BTC, etc.)
 * Por padrão, busca os últimos 89 dias se não especificado
 */
async function getDepositHistory(options = {}) {
  const now = Date.now();
  const ninetyDaysAgo = now - 89 * 24 * 60 * 60 * 1000;

  const params = {
    startTime: String(options.startTime || ninetyDaysAgo),
    endTime: String(options.endTime || now),
  };
  if (options.coin) params.coin = options.coin.toUpperCase();
  if (options.status !== undefined) params.status = String(options.status);
  if (options.limit) params.limit = String(options.limit || 100);

  return await proxyRequest('/sapi/v1/capital/deposit/hisrec', params);
}

/**
 * 2. Histórico de Saques (Withdrawals)
 * Importante: permite verificar transações onde o cliente transferiu para a carteira
 */
async function getWithdrawHistory(options = {}) {
  const now = Date.now();
  const ninetyDaysAgo = now - 89 * 24 * 60 * 60 * 1000;

  const params = {
    startTime: String(options.startTime || ninetyDaysAgo),
    endTime: String(options.endTime || now),
  };
  if (options.coin) params.coin = options.coin.toUpperCase();
  if (options.status !== undefined) params.status = String(options.status);
  if (options.limit) params.limit = String(options.limit || 100);

  return await proxyRequest('/sapi/v1/capital/withdraw/history', params);
}

/**
 * 3. Histórico de Transações Binance Pay (C2C / Transferências Diretas)
 */
async function getPayHistory(options = {}) {
  const now = Date.now();
  const ninetyDaysAgo = now - 89 * 24 * 60 * 60 * 1000;

  const params = {
    startTimestamp: String(options.startTimestamp || ninetyDaysAgo),
    endTimestamp: String(options.endTimestamp || now),
  };
  if (options.limit) params.limit = String(options.limit || 100);

  const res = await proxyRequest('/sapi/v1/pay/transactions', params);
  return res.data || res || [];
}

/**
 * 4. Histórico de Depósitos Fiat Recebidos
 */
async function getFiatOrders(options = {}) {
  const params = { transactionType: '0' }; // 0 = Depósito
  if (options.beginTime) params.beginTime = String(options.beginTime);
  if (options.endTime) params.endTime = String(options.endTime);
  if (options.page) params.page = String(options.page || 1);
  if (options.rows) params.rows = String(options.rows || 50);

  return await proxyRequest('/sapi/v1/fiat/orders', params);
}

/**
 * 5. Saldos da Conta Spot
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

/**
 * 6. Busca Universal de Transação por TXID / Hash / OrderID na Binance
 * Varre depósitos cripto, saques (teste/transferência), e Binance Pay
 */
async function buscarTransacaoUniversal(txidBuscado) {
  if (!txidBuscado) return null;
  const termo = txidBuscado.trim();
  const termoLower = termo.toLowerCase();

  // 1. Busca em Depósitos Cripto
  try {
    const depositos = await getDepositHistory();
    const lista = Array.isArray(depositos) ? depositos : [];
    for (const d of lista) {
      const dTx = String(d.txId || '').toLowerCase();
      const dId = String(d.id || '').toLowerCase();
      if (dTx === termoLower || dId === termoLower || dTx.includes(termoLower)) {
        return {
          encontrado: true,
          fonte: 'deposito',
          txId: d.txId || d.id,
          amount: parseFloat(d.amount),
          coin: d.coin || 'USDT',
          status: d.status === 1 ? 'sucesso' : 'pendente',
          confirmacoes: d.confirmTimes,
          network: d.network,
          raw: d,
        };
      }
    }
  } catch (err) {
    console.warn('[buscarTransacaoUniversal] Erro depósitos:', err.message);
  }

  // 2. Busca em Saques / Transferências
  try {
    const saques = await getWithdrawHistory();
    const listaSaques = Array.isArray(saques) ? saques : [];
    for (const s of listaSaques) {
      const sTx = String(s.txId || '').toLowerCase();
      const sId = String(s.id || '').toLowerCase();
      if (sTx === termoLower || sId === termoLower || sTx.includes(termoLower)) {
        return {
          encontrado: true,
          fonte: 'saque_transferencia',
          txId: s.txId || s.id,
          amount: parseFloat(s.amount),
          coin: s.coin || 'USDT',
          status: s.status === 6 ? 'sucesso' : 'processando', // 6 = Completo
          network: s.network,
          address: s.address,
          raw: s,
        };
      }
    }
  } catch (err) {
    console.warn('[buscarTransacaoUniversal] Erro saques:', err.message);
  }

  // 3. Busca em Binance Pay
  try {
    const payHistory = await getPayHistory();
    const listaPay = Array.isArray(payHistory) ? payHistory : (payHistory.data || []);
    for (const p of listaPay) {
      const pOrder = String(p.orderId || p.merchantTradeNo || '').toLowerCase();
      const pRef = String(p.remark || p.memo || '').toLowerCase();
      if (pOrder === termoLower || pRef.includes(termoLower)) {
        return {
          encontrado: true,
          fonte: 'binance_pay',
          txId: p.orderId || termo,
          amount: parseFloat(p.amount || p.cryptoAmount || 0),
          coin: p.currency || 'USDT',
          status: 'sucesso',
          raw: p,
        };
      }
    }
  } catch (err) {
    console.warn('[buscarTransacaoUniversal] Erro pay:', err.message);
  }

  return null;
}

module.exports = {
  getDepositHistory,
  getWithdrawHistory,
  getFiatOrders,
  getPayHistory,
  getAccountBalances,
  buscarTransacaoUniversal,
};
