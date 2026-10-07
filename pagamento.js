/**
 * pagamento.js
 *
 * FLUXO CORRETO:
 * 1. App chama POST /api/pagamento/criar  → recebe código do pedido + valor + ID Binance do merchant
 * 2. Cliente paga via Binance Pay/Transfer → Binance gera um TXID para o cliente
 * 3. Cliente fornece o TXID no app
 * 4. App chama POST /api/pagamento/verificar { codigo, txid }
 *    → Backend busca esse TXID na Binance
 *    → Verifica se o valor bate
 *    → Verifica se o TXID ainda não foi usado
 *    → Se tudo OK → retorna access_token e libera acesso
 */

const crypto = require('crypto');
const { query } = require('./db');
const { getPayHistory, getDepositHistory } = require('./binance');

const ORDER_EXPIRY_MS = 60 * 60 * 1000; // 1 hora para o cliente pagar

function gerarCodigo() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let cod = 'AVGPT-';
  for (let i = 0; i < 6; i++) cod += chars[Math.floor(Math.random() * chars.length)];
  return cod;
}

function gerarAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

// -------------------------------------------------------
// 1. CRIAR PEDIDO
// -------------------------------------------------------
async function criarPedido({ amount, currency = 'USDT', descricao = '', customerInfo = {} }) {
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    throw new Error('Valor inválido para o pedido.');
  }

  const codigo = gerarCodigo();
  const expiresAt = new Date(Date.now() + ORDER_EXPIRY_MS);

  const { rows } = await query(
    `INSERT INTO orders (codigo, amount, currency, descricao, customer_info, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING *`,
    [codigo, parseFloat(amount), currency.toUpperCase(), descricao, JSON.stringify(customerInfo), expiresAt]
  );

  const order = rows[0];
  return {
    codigo: order.codigo,
    amount: parseFloat(order.amount),
    currency: order.currency,
    descricao: order.descricao,
    status: 'pending',
    expires_at: order.expires_at,
    instrucao: `Pague ${order.amount} ${order.currency} via Binance Pay. Após pagar, copie o TXID gerado pela Binance e cole no aplicativo para confirmar.`,
  };
}

// -------------------------------------------------------
// 2. VERIFICAR PAGAMENTO VIA TXID FORNECIDO PELO CLIENTE
// -------------------------------------------------------
async function verificarPorTxid(codigo, txid) {
  // --- Validação do pedido ---
  const { rows: pedidoRows } = await query('SELECT * FROM orders WHERE codigo = $1', [codigo.toUpperCase()]);
  if (pedidoRows.length === 0) {
    return { sucesso: false, status: 'not_found', mensagem: 'Pedido não encontrado.' };
  }

  const order = pedidoRows[0];

  if (order.status === 'paid') {
    return {
      sucesso: true,
      status: 'paid',
      mensagem: '✅ Pagamento já confirmado anteriormente.',
      access_token: order.access_token,
      paid_at: order.paid_at,
    };
  }

  if (new Date() > new Date(order.expires_at)) {
    await query(`UPDATE orders SET status='expired', updated_at=NOW() WHERE codigo=$1`, [codigo]);
    return { sucesso: false, status: 'expired', mensagem: 'Pedido expirado. Crie um novo pedido.' };
  }

  // --- Verificar se este TXID já foi usado em outro pedido ---
  const { rows: txUsado } = await query(
    `SELECT codigo FROM orders WHERE binance_tx_id = $1 AND status = 'paid'`,
    [txid]
  );
  if (txUsado.length > 0) {
    return {
      sucesso: false,
      status: 'txid_already_used',
      mensagem: `❌ Este TXID já foi utilizado para o pedido ${txUsado[0].codigo}. Cada transação só pode ser usada uma vez.`,
    };
  }

  const amountEsperado = parseFloat(order.amount);
  const TOLERANCIA = 0.02; // 2% de tolerância (cobre taxas de rede)

  // --- VERIFICAÇÃO 1: Buscar nas transações Binance Pay ---
  let txEncontrada = null;

  try {
    const payHistory = await getPayHistory({ limit: 100 });
    const transactions = Array.isArray(payHistory) ? payHistory : (payHistory.data || []);

    for (const tx of transactions) {
      const txOrderId = String(tx.orderId || tx.merchantTradeNo || tx.bizId || tx.id || '');
      const txRef     = String(tx.remark || tx.memo || tx.reference || tx.bizOrderNo || '');
      const txHash    = String(tx.transactionHash || tx.txHash || tx.hash || '');

      // Compara o TXID fornecido com todos os identificadores possíveis da Binance
      const match =
        txOrderId === txid ||
        txRef === txid ||
        txHash === txid ||
        txOrderId.toLowerCase() === txid.toLowerCase() ||
        txRef.toLowerCase() === txid.toLowerCase();

      if (match) {
        txEncontrada = { fonte: 'pay', tx, txId: txOrderId || txid };
        break;
      }
    }
  } catch (err) {
    console.warn('[verificarPorTxid] Falha ao buscar Pay history:', err.message);
  }

  // --- VERIFICAÇÃO 2: Buscar nos depósitos cripto (se não achou no Pay) ---
  if (!txEncontrada) {
    try {
      const deposits = await getDepositHistory({ limit: 100 });
      const depositList = Array.isArray(deposits) ? deposits : [];

      for (const dep of depositList) {
        const depTxId   = String(dep.txId || dep.id || '');
        const depTxHash = String(dep.transactionHash || dep.hash || '');

        const match =
          depTxId === txid ||
          depTxHash === txid ||
          depTxId.toLowerCase() === txid.toLowerCase();

        if (match) {
          txEncontrada = { fonte: 'deposit', tx: dep, txId: depTxId || txid };
          break;
        }
      }
    } catch (err) {
      console.warn('[verificarPorTxid] Falha ao buscar depósitos:', err.message);
    }
  }

  // --- TXID não encontrado na Binance ---
  if (!txEncontrada) {
    return {
      sucesso: false,
      status: 'txid_not_found',
      mensagem: '❌ TXID não encontrado na Binance. Verifique se o TXID está correto e se o pagamento já foi processado.',
    };
  }

  // --- Verificar o valor da transação ---
  const tx = txEncontrada.tx;
  const valorRecebido = parseFloat(tx.amount || tx.cryptoAmount || tx.transAmount || 0);
  const diff = Math.abs(valorRecebido - amountEsperado) / amountEsperado;

  if (diff > TOLERANCIA) {
    return {
      sucesso: false,
      status: 'wrong_amount',
      mensagem: `❌ Valor incorreto. Esperado: ${amountEsperado} ${order.currency}, Recebido: ${valorRecebido}. Por favor, pague o valor exato.`,
      esperado: amountEsperado,
      recebido: valorRecebido,
    };
  }

  // --- TUDO OK: Confirmar pagamento e gerar access_token ---
  const accessToken = gerarAccessToken();
  const txIdFinal = txEncontrada.txId || txid;

  await query(
    `UPDATE orders
     SET status='paid', binance_tx_id=$1, binance_payload=$2, access_token=$3, paid_at=NOW(), updated_at=NOW()
     WHERE codigo=$4`,
    [txIdFinal, JSON.stringify(tx), accessToken, codigo]
  );

  // Registra na tabela de payments para histórico unificado
  try {
    await query(
      `INSERT INTO payments (transaction_id, amount, currency, status, gateway, payload)
       VALUES ($1, $2, $3, 'paid', 'binance', $4)
       ON CONFLICT (transaction_id) DO NOTHING`,
      [txIdFinal, valorRecebido, order.currency, JSON.stringify(tx)]
    );
  } catch (_) {}

  return {
    sucesso: true,
    status: 'paid',
    mensagem: '✅ Pagamento confirmado! Acesso liberado.',
    access_token: accessToken,
    amount_confirmado: valorRecebido,
    currency: order.currency,
    binance_tx_id: txIdFinal,
    paid_at: new Date().toISOString(),
  };
}

// -------------------------------------------------------
// 3. BUSCAR PEDIDO
// -------------------------------------------------------
async function buscarPedido(codigo) {
  const { rows } = await query('SELECT * FROM orders WHERE codigo = $1', [codigo.toUpperCase()]);
  return rows.length > 0 ? rows[0] : null;
}

module.exports = { criarPedido, buscarPedido, verificarPorTxid };
