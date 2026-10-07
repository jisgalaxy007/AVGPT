/**
 * pagamento.js
 * 
 * Módulo de validação de pagamentos Cripto / Binance para AVGPT.
 * 
 * Suporta lógica flexível e proporcional:
 * - Se o valor for maior ou igual a um pacote: concede o pacote com horas/dias proporcionais (+/-).
 * - Se for menor que 1 pacote (ex: 1 USDT, 3 USDT): converte proporcionalmente em HORAS VIP.
 * - Suporta tanto USDT quanto Ordens P2P em moeda local (MT/MZN).
 */

const crypto = require('crypto');
const { query } = require('./db');
const { buscarTransacaoUniversal } = require('./binance');

const ORDER_EXPIRY_MS = 2 * 60 * 60 * 1000;

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
 * Calcula os dias/horas de acesso de forma flexível e proporcional
 */
function calcularAcessoFlexivel({ valorUsdt = 0, valorMzn = 0 }) {
  // Preços de referência oficiais:
  // 30 Dias: 22.32 USDT | 899 MT
  // 15 Dias: 15.55 USDT | 799 MT
  //  7 Dias: 12.22 USDT | 555 MT
  //  1 Dia:   6.00 USDT | 350 MT (~0.25 USDT/hora)

  // 1. Caso com valor em USDT (Depósitos, Binance Pay, Saques, P2P)
  if (valorUsdt > 0) {
    if (valorUsdt >= 21.00) {
      // 30 Dias ou proporcional se for maior
      const dias = Math.max(30, Math.floor((valorUsdt / 22.32) * 30));
      return {
        nomePlano: `${dias} Dias VIP`,
        dias: dias,
        horas: dias * 24,
      };
    } else if (valorUsdt >= 14.50) {
      // 15 Dias (+/-)
      return {
        nomePlano: '15 Dias VIP',
        dias: 15,
        horas: 15 * 24,
      };
    } else if (valorUsdt >= 11.00) {
      // 7 Dias (+/-)
      return {
        nomePlano: '7 Dias VIP',
        dias: 7,
        horas: 7 * 24,
      };
    } else if (valorUsdt >= 5.00) {
      // 1 Dia completo (+/-) com horas extras proporcionais (ex: 7.08 USDT = 28 horas)
      const horasTotais = Math.round((valorUsdt / 6.00) * 24);
      const dias = Math.floor(horasTotais / 24);
      return {
        nomePlano: dias >= 1 ? `${dias} Dia(s) VIP` : `${horasTotais} Horas VIP`,
        dias: dias,
        horas: horasTotais,
      };
    } else if (valorUsdt >= 0.50) {
      // Menor que 1 pacote (ex: 1 USDT, 2.99 USDT, 3 USDT): corta em horas!
      const horas = Math.max(1, Math.round((valorUsdt / 6.00) * 24));
      return {
        nomePlano: `${horas} Horas VIP`,
        dias: 0,
        horas: horas,
      };
    }
  }

  // 2. Caso com valor em MZN/MT (Ordens P2P em moeda local)
  if (valorMzn > 0) {
    if (valorMzn >= 850) {
      return { nomePlano: '30 Dias VIP', dias: 30, horas: 30 * 24 };
    } else if (valorMzn >= 700) {
      return { nomePlano: '15 Dias VIP', dias: 15, horas: 15 * 24 };
    } else if (valorMzn >= 500) {
      return { nomePlano: '7 Dias VIP', dias: 7, horas: 7 * 24 };
    } else if (valorMzn >= 300) {
      const horas = Math.round((valorMzn / 350) * 24);
      return { nomePlano: '1 Dia VIP', dias: 1, horas: horas };
    } else if (valorMzn >= 20) {
      // Menor que 1 pacote em MT: corta em horas!
      const horas = Math.max(1, Math.round((valorMzn / 350) * 24));
      return { nomePlano: `${horas} Horas VIP`, dias: 0, horas: horas };
    }
  }

  return null;
}

/**
 * 1. Criar pedido opcional
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
    instrucao: `Pague ${order.amount} ${order.currency} via Binance Pay, P2P ou para a carteira. Após pagar, informe o TXID para liberar seu acesso.`,
  };
}

/**
 * 2. Resgatar / Verificar pagamento por TXID na Binance
 * Lógica Flexível: aceita +/- e calcula dias ou horas proporcionais!
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
  // Passo 2: Buscar a transação na Binance (P2P, depósitos, Binance Pay, saques)
  // ----------------------------------------------------
  const txEncontrada = await buscarTransacaoUniversal(txidLimpo);

  if (!txEncontrada) {
    return {
      sucesso: false,
      status: 'txid_not_found',
      mensagem: `❌ Transação com TXID/Hash/Ordem "${txidLimpo}" não foi localizada na Binance. Verifique se o código foi digitado corretamente e se a transação já foi confirmada na rede ou no P2P.`,
      txid: txidLimpo,
    };
  }

  // Validação de status da ordem na Binance
  if (txEncontrada.status && txEncontrada.status !== 'sucesso') {
    return {
      sucesso: false,
      status: 'ordem_incompleta',
      mensagem: `❌ A ordem Binance "${txidLimpo}" está com status "${txEncontrada.status}". O pagamento precisa estar CONCLUÍDO para ser validado.`,
      txid: txidLimpo,
    };
  }

  const valorPagoUsdt = parseFloat(txEncontrada.amount || 0);
  const valorPagoMzn = parseFloat(txEncontrada.totalPriceFiat || 0);

  // ----------------------------------------------------
  // Passo 3: Cálculo Flexível de Pacote (+/- e corte em horas)
  // ----------------------------------------------------
  const acessoCalculado = calcularAcessoFlexivel({
    valorUsdt: valorPagoUsdt,
    valorMzn: valorPagoMzn,
  });

  if (!acessoCalculado) {
    const displayValor = valorPagoMzn > 0 ? `${valorPagoMzn.toFixed(2)} MT` : `${valorPagoUsdt.toFixed(2)} USDT`;
    return {
      sucesso: false,
      status: 'valor_insuficiente',
      mensagem: `❌ O valor de ${displayValor} da transação ${txidLimpo} é insuficiente para ativar qualquer período de acesso (mínimo de 0.50 USDT ou 20 MT).`,
      valor_usdt: valorPagoUsdt,
      valor_mzn: valorPagoMzn,
      txid: txidLimpo,
    };
  }

  // ----------------------------------------------------
  // Passo 4: Pagamento Confirmado! Ativar Licença e Gravar
  // ----------------------------------------------------
  const accessToken = gerarAccessToken();
  const txIdFinal = txEncontrada.txId || txidLimpo;
  const horasTotais = acessoCalculado.horas;
  const nomePlano = acessoCalculado.nomePlano;

  // Atualiza ou insere na tabela orders
  if (codigo) {
    await query(
      `UPDATE orders 
       SET status='paid', binance_tx_id=$1, binance_payload=$2, access_token=$3, paid_at=NOW(), updated_at=NOW()
       WHERE UPPER(codigo)=$4`,
      [txIdFinal, JSON.stringify(txEncontrada.raw), accessToken, codigo.toUpperCase()]
    );
  } else {
    const codGerado = gerarCodigo();
    await query(
      `INSERT INTO orders (codigo, amount, currency, descricao, status, binance_tx_id, binance_payload, access_token, paid_at)
       VALUES ($1, $2, $3, $4, 'paid', $5, $6, $7, NOW())`,
      [
        codGerado,
        valorPagoUsdt > 0 ? valorPagoUsdt : valorPagoMzn,
        valorPagoUsdt > 0 ? 'USDT' : 'MZN',
        nomePlano,
        txIdFinal,
        JSON.stringify(txEncontrada.raw),
        accessToken,
      ]
    );
  }

  // Registra no histórico consolidado de payments
  try {
    await query(
      `INSERT INTO payments (transaction_id, amount, currency, status, gateway, payload)
       VALUES ($1, $2, $3, 'paid', 'binance', $4)
       ON CONFLICT (transaction_id) DO NOTHING`,
      [
        txIdFinal,
        valorPagoUsdt > 0 ? valorPagoUsdt : valorPagoMzn,
        valorPagoUsdt > 0 ? 'USDT' : 'MZN',
        JSON.stringify(txEncontrada.raw),
      ]
    );
  } catch (_) {}

  // Se device_id foi fornecido, ativa/estende o usuário na tabela users pelo número de HORAS calculadas!
  let userUpdated = null;
  if (deviceId) {
    try {
      const { rows: uRows } = await query(
        `INSERT INTO users (device_id, user_name, status, plano, validade_ate, total_compras, ultima_vez_online)
         VALUES ($1, 'Jogador VIP', 'ATIVO', $2, NOW() + ($3 || ' hours')::INTERVAL, $4, NOW())
         ON CONFLICT (device_id) DO UPDATE
         SET status = 'ATIVO',
             plano = $2,
             validade_ate = GREATEST(NOW(), users.validade_ate) + ($3 || ' hours')::INTERVAL,
             total_compras = users.total_compras + $4,
             ultima_vez_online = NOW()
         RETURNING *;`,
        [deviceId, nomePlano, horasTotais.toString(), valorPagoUsdt]
      );
      if (uRows.length > 0) userUpdated = uRows[0];
    } catch (uErr) {
      console.warn('[verificarPorTxid] Erro ao atualizar usuário:', uErr.message);
    }
  }

  const displayValorConfirmado = valorPagoMzn > 0
    ? `${valorPagoMzn.toFixed(2)} MT (${valorPagoUsdt.toFixed(2)} USDT)`
    : `${valorPagoUsdt.toFixed(2)} USDT`;

  return {
    sucesso: true,
    status: 'paid',
    mensagem: `🎉 Pagamento de ${displayValorConfirmado} confirmado via Binance (${txEncontrada.fonte})! O acesso "${nomePlano}" (${horasTotais} horas) foi ativado com sucesso!`,
    access_token: accessToken,
    amount_confirmado: valorPagoUsdt > 0 ? valorPagoUsdt : valorPagoMzn,
    currency: valorPagoUsdt > 0 ? 'USDT' : 'MZN',
    binance_tx_id: txIdFinal,
    fonte_binance: txEncontrada.fonte,
    horas_adicionadas: horasTotais,
    dias_equivalentes: acessoCalculado.dias,
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
