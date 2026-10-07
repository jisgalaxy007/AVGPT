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
 * 1. Histórico de Depósitos Cripto Recebidos (On-chain / Blockchain)
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
 * 2. Histórico de Saques / Transferências Externas
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
 * 3. Histórico de Transações Binance Pay
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
 * 4. Histórico de Ordens P2P / C2C (Comprar e Vender USDT via e-Mola, M-Pesa, etc.)
 */
async function getP2POrders(options = {}) {
  const now = Date.now();
  const ninetyDaysAgo = now - 89 * 24 * 60 * 60 * 1000;

  const params = {
    startTimestamp: String(options.startTimestamp || ninetyDaysAgo),
    endTimestamp: String(options.endTimestamp || now),
    tradeType: (options.tradeType || 'BUY').toUpperCase(),
    page: String(options.page || 1),
    rows: String(options.rows || 100),
  };

  const res = await proxyRequest('/sapi/v1/c2c/orderMatch/listUserOrderHistory', params);
  return res.data || res || [];
}

/**
 * 5. Histórico de Depósitos Fiat Recebidos
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
 * 6. Saldos da Conta Spot
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
 * 7. Busca Universal de Transação por TXID / Hash / OrderID na Binance
 * Varre:
 *   - Depósitos Cripto On-chain (txId / hash)
 *   - Ordens P2P / C2C (orderNumber, ex: 22940163959255494656)
 *   - Binance Pay (orderId)
 *   - Saques / Transferências (txId / hash)
 */
async function buscarTransacaoUniversal(txidBuscado) {
  if (!txidBuscado) return null;
  const termo = txidBuscado.trim();
  const termoLower = termo.toLowerCase();

  // 1. Busca em Ordens P2P / C2C (Compras e Vendas P2P)
  try {
    const [p2pBuy, p2pSell] = await Promise.allSettled([
      getP2POrders({ tradeType: 'BUY' }),
      getP2POrders({ tradeType: 'SELL' }),
    ]);

    const listaP2p = [
      ...(p2pBuy.status === 'fulfilled' && Array.isArray(p2pBuy.value) ? p2pBuy.value : []),
      ...(p2pSell.status === 'fulfilled' && Array.isArray(p2pSell.value) ? p2pSell.value : []),
    ];

    for (const p of listaP2p) {
      const pOrder = String(p.orderNumber || '').toLowerCase();
      const pAdv = String(p.advNo || '').toLowerCase();
      if (pOrder === termoLower || pAdv === termoLower) {
        return {
          encontrado: true,
          fonte: 'binance_p2p',
          txId: p.orderNumber,
          amount: parseFloat(p.amount || p.takerAmount || 0),
          totalPriceFiat: parseFloat(p.totalPrice || 0),
          fiat: p.fiat || 'MZN',
          coin: p.asset || 'USDT',
          status: p.orderStatus === 'COMPLETED' ? 'sucesso' : p.orderStatus.toLowerCase(),
          contraparte: p.counterPartNickName,
          metodo_pagamento: p.payMethodName,
          createTime: p.createTime,
          raw: p,
        };
      }
    }
  } catch (err) {
    console.warn('[buscarTransacaoUniversal] Erro P2P:', err.message);
  }

  // 2. Busca em Depósitos Cripto On-chain
  try {
    const depositos = await getDepositHistory();
    const lista = Array.isArray(depositos) ? depositos : [];
    for (const d of lista) {
      const dTx = String(d.txId || '').toLowerCase();
      const dId = String(d.id || '').toLowerCase();
      if (dTx === termoLower || dId === termoLower || dTx.includes(termoLower)) {
        return {
          encontrado: true,
          fonte: 'deposito_onchain',
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

  // 4. Busca em Saques / Transferências
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
          status: s.status === 6 ? 'sucesso' : 'processando',
          network: s.network,
          address: s.address,
          raw: s,
        };
      }
    }
  } catch (err) {
    console.warn('[buscarTransacaoUniversal] Erro saques:', err.message);
  }

  return null;
}

module.exports = {
  getDepositHistory,
  getWithdrawHistory,
  getP2POrders,
  getPayHistory,
  getFiatOrders,
  getAccountBalances,
  buscarTransacaoUniversal,
};
