/**
 * pagamento.js
 * 
 * Módulo de validação de pagamentos Cripto / Binance para AVGPT.
 * 
 * Suporta dois modos:
 * 1. Modo Direto (Recomendado): O cliente informa apenas o TXID / Hash e o device_id.
 *    O backend consulta a Binance, valida unicidade, confere o valor em USDT contra os pacotes,
 *    e ativa a licença do usuário diretamente.
 * 2. Modo Pedido: O app cria um pedido previamente (código AVGPT-XXXX) e valida com o TXID.
 */

const crypto = require('crypto');
const { query } = require('./db');
const { buscarTransacaoUniversal, getAccountBalances } = require('./binance');

const ORDER_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 horas de validade para pedidos pendentes

function gerarCodigo() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let cod = 'AVGPT-';
  for (let i = 0; i < 6; i++) cod += chars[Math.floor(Math.random() * chars.length)];
  return cod;
}

function gerarAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 1. Criar pedido de pagamento opcional (gera código AVGPT-XXXX)
 */
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
    instrucao: `Pague ${order.amount} ${order.currency} via Binance Pay ou para a carteira. Após pagar, informe o TXID para liberar seu acesso.`,
  };
}

/**
 * 2. Resgatar / Verificar pagamento por TXID na Binance
 * Funciona tanto com código de pedido quanto diretamente com device_id + txid!
 */
async function verificarPorTxid({ codigo = null, txid, deviceId = null }) {
  if (!txid) {
    return { sucesso: false, status: 'txid_ausente', mensagem: 'TXID da transação não fornecido.' };
  }

  const txidLimpo = txid.trim();

  // ----------------------------------------------------
  // Passo 1: Verificar se este TXID já foi utilizado no banco (Anti-reuso)
  // ----------------------------------------------------
  const { rows: txUsadoEmOrders } = await query(
    `SELECT codigo, customer_info, paid_at FROM orders WHERE LOWER(binance_tx_id) = LOWER($1) AND status = 'paid'`,
    [txidLimpo]
  );
  const { rows: txUsadoEmPayments } = await query(
    `SELECT transaction_id, created_at FROM payments WHERE LOWER(transaction_id) = LOWER($1) AND status = 'paid'`,
    [txidLimpo]
  );

  if (txUsadoEmOrders.length > 0 || txUsadoEmPayments.length > 0) {
    return {
      sucesso: false,
      status: 'txid_already_used',
      mensagem: `❌ Este comprovativo/TXID (${txidLimpo}) já foi utilizado anteriormente no sistema! Cada transação só pode ser resgatada uma vez.`,
      txid: txidLimpo,
    };
  }

  // ----------------------------------------------------
  // Passo 2: Buscar a transação na Binance (depósitos, Binance Pay, saques/transferências)
  // ----------------------------------------------------
  const txEncontrada = await buscarTransacaoUniversal(txidLimpo);

  if (!txEncontrada) {
    return {
      sucesso: false,
      status: 'txid_not_found',
      mensagem: `❌ Transação com TXID/Hash "${txidLimpo}" não foi localizada na Binance. Verifique se o código foi digitado corretamente e se a transação já foi confirmada na rede.`,
      txid: txidLimpo,
    };
  }

  const valorPagoUsdt = parseFloat(txEncontrada.amount);

  // ----------------------------------------------------
  // Passo 3: Buscar planos e validar se o valor em USDT corresponde a um pacote
  // ----------------------------------------------------
  const { rows: planos } = await query(
    `SELECT * FROM planos WHERE ativo = true ORDER BY preco_usdt ASC`
  );

  // Tolerância de até 0.20 USDT para variações de taxa de rede
  const planoEscolhido = planos.find((p) => {
    const preco = parseFloat(p.preco_usdt);
    return Math.abs(valorPagoUsdt - preco) <= 0.20;
  });

  if (!planoEscolhido) {
    const listaValores = planos.map(p => `${parseFloat(p.preco_usdt).toFixed(2)} USDT (${p.nome})`).join(', ');
    return {
      sucesso: false,
      status: 'valor_invalido',
      mensagem: `❌ O valor pago de ${valorPagoUsdt.toFixed(2)} USDT não corresponde a nenhum pacote VIP ativo. Pacotes válidos: ${listaValores}. Nenhuma licença foi ativada.`,
      valor_recebido: valorPagoUsdt,
      txid: txidLimpo,
      planos_disponiveis: planos.map(p => ({
        id: p.id,
        nome: p.nome,
        preco_usdt: parseFloat(p.preco_usdt),
        dias: p.dias,
      })),
    };
  }

  // ----------------------------------------------------
  // Passo 4: Pagamento Válido! Ativar Licença e Gravar
  // ----------------------------------------------------
  const accessToken = gerarAccessToken();
  const txIdFinal = txEncontrada.txId || txidLimpo;
  const diasAdicionados = planoEscolhido.dias;
  const nomePlano = planoEscolhido.nome;

  // Atualiza ou insere na tabela orders
  if (codigo) {
    await query(
      `UPDATE orders 
       SET status='paid', binance_tx_id=$1, binance_payload=$2, access_token=$3, paid_at=NOW(), updated_at=NOW()
       WHERE UPPER(codigo)=$4`,
      [txIdFinal, JSON.stringify(txEncontrada.raw), accessToken, codigo.toUpperCase()]
    );
  } else {
    // Cria o registro diretamente
    const codGerado = gerarCodigo();
    await query(
      `INSERT INTO orders (codigo, amount, currency, descricao, status, binance_tx_id, binance_payload, access_token, paid_at)
       VALUES ($1, $2, 'USDT', $3, 'paid', $4, $5, $6, NOW())`,
      [codGerado, valorPagoUsdt, nomePlano, txIdFinal, JSON.stringify(txEncontrada.raw), accessToken]
    );
  }

  // Registra no histórico consolidado de payments
  try {
    await query(
      `INSERT INTO payments (transaction_id, amount, currency, status, gateway, payload)
       VALUES ($1, $2, 'USDT', 'paid', 'binance', $3)
       ON CONFLICT (transaction_id) DO NOTHING`,
      [txIdFinal, valorPagoUsdt, JSON.stringify(txEncontrada.raw)]
    );
  } catch (_) {}

  // Se device_id foi fornecido, ativa/estende o usuário na tabela users
  let userUpdated = null;
  if (deviceId) {
    try {
      const { rows: uRows } = await query(
        `INSERT INTO users (device_id, user_name, status, plano, validade_ate, total_compras, ultima_vez_online)
         VALUES ($1, 'Jogador VIP', 'ATIVO', $2, NOW() + ($3 || ' days')::INTERVAL, $4, NOW())
         ON CONFLICT (device_id) DO UPDATE
         SET status = 'ATIVO',
             plano = $2,
             validade_ate = GREATEST(NOW(), users.validade_ate) + ($3 || ' days')::INTERVAL,
             total_compras = users.total_compras + $4,
             ultima_vez_online = NOW()
         RETURNING *;`,
        [deviceId, nomePlano, diasAdicionados.toString(), valorPagoUsdt]
      );
      if (uRows.length > 0) userUpdated = uRows[0];
    } catch (uErr) {
      console.warn('[verificarPorTxid] Erro ao atualizar usuário:', uErr.message);
    }
  }

  return {
    sucesso: true,
    status: 'paid',
    mensagem: `🎉 Pagamento de ${valorPagoUsdt.toFixed(2)} USDT confirmado via Binance! O plano "${nomePlano}" foi ativado com sucesso!`,
    access_token: accessToken,
    amount_confirmado: valorPagoUsdt,
    currency: 'USDT',
    binance_tx_id: txIdFinal,
    fonte_binance: txEncontrada.fonte,
    dias_adicionados: diasAdicionados,
    validade_ate: userUpdated ? userUpdated.validade_ate : null,
    user: userUpdated,
    paid_at: new Date().toISOString(),
  };
}

/**
 * 3. Buscar Pedido por Código
 */
async function buscarPedido(codigo) {
  const { rows } = await query('SELECT * FROM orders WHERE UPPER(codigo) = $1', [codigo.toUpperCase()]);
  return rows.length > 0 ? rows[0] : null;
}

module.exports = {
  criarPedido,
  buscarPedido,
  verificarPorTxid,
};
