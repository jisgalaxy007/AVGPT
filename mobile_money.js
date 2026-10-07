/**
 * mobile_money.js
 * Módulo de processamento de pagamentos móveis de Moçambique: e-Mola e M-Pesa.
 * 
 * Funcionalidades:
 * 1. Parser inteligente de SMS recebidos do gateway (celular com chip e-Mola / M-Pesa).
 * 2. Armazenamento com status 'RECEBIDO' na tabela mobile_payments.
 * 3. Validação quando o usuário cola o comprovativo no app cliente:
 *    - Extrai o ID da transação (TXID).
 *    - Verifica se existe e se já foi usado.
 *    - Identifica o pacote/plano correspondente pelo valor (MT).
 *    - Marca como 'USADO' e ativa/estende a licença do usuário na tabela users.
 */

const { query } = require('./db');

/**
 * Faz o parsing da mensagem SMS pura do e-Mola ou M-Pesa
 */
function parseSms(text) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();

  let service = null;
  let txId = null;
  let amount = null;
  let senderPhone = null;
  let senderName = null;

  // ----------------------------------------------------
  // 1. Detecção e-Mola
  // Ex: "ID Trans: PP261004.2203.Y98273. Recebeu 269.00MT de 876563910, BERNARDINA A AGOSTINHO as 22:03:13 04/10/2026. Conteudo: cona. O seu novo saldo e de 309.19MT. Em caso de duvida, ligue para 100."
  // ----------------------------------------------------
  if (/ID\s*Trans[:.]/i.test(raw) || /e-?mola/i.test(raw) || /PP\d{6}\./i.test(raw)) {
    service = 'emola';

    // Captura o ID Trans completo (ex: PP261004.2203.Y98273)
    const idMatch = raw.match(/ID\s*Trans[:\s]+(.*?)(?:\.\s+Recebeu|\s+Recebeu)/i) ||
                    raw.match(/ID\s*Trans[:\s]+([A-Za-z0-9._-]+)/i);
    if (idMatch) {
      txId = idMatch[1].replace(/\.$/, '').trim();
    }

    // Captura o valor (ex: Recebeu 269.00MT)
    const amtMatch = raw.match(/Recebeu\s+([0-9.,]+)\s*MT/i) || raw.match(/([0-9.,]+)\s*MT/i);
    if (amtMatch) {
      amount = parseFloat(amtMatch[1].replace(',', '.'));
    }

    // Captura remetente (ex: de 876563910, BERNARDINA A AGOSTINHO as...)
    const senderMatch = raw.match(/de\s+([0-9+]+)[,\s-]+([^.]+?)\s+as\s+/i);
    if (senderMatch) {
      senderPhone = senderMatch[1].trim();
      senderName = senderMatch[2].trim();
    }
  }

  // ----------------------------------------------------
  // 2. Detecção M-Pesa
  // Ex: "Confirmado DJ37LT9PBN9. Recebeste 5.00MT de 258846079459 - LIDIA aos 3/10/26 as 8:38 PM. O teu novo saldo M-Pesa e de 9.60MT. Em caso de duvida, liga 100. M-Pesa e facil!"
  // ----------------------------------------------------
  if (/Confirmado\s+[A-Za-z0-9]+/i.test(raw) || /m-?pesa/i.test(raw) || /Recebeste\s+[0-9.,]+\s*MT/i.test(raw)) {
    service = 'mpesa';

    // Captura o código de confirmação (ex: DJ37LT9PBN9)
    const idMatch = raw.match(/Confirmado\s+([A-Za-z0-9]+)/i);
    if (idMatch) {
      txId = idMatch[1].trim();
    }

    // Captura o valor (ex: Recebeste 5.00MT)
    const amtMatch = raw.match(/Recebeste\s+([0-9.,]+)\s*MT/i) || raw.match(/([0-9.,]+)\s*MT/i);
    if (amtMatch) {
      amount = parseFloat(amtMatch[1].replace(',', '.'));
    }

    // Captura remetente (ex: de 258846079459 - LIDIA aos...)
    const senderMatch = raw.match(/de\s+([0-9+]+)\s*[-,\s]\s*([^.]+?)\s+aos\s+/i);
    if (senderMatch) {
      senderPhone = senderMatch[1].trim();
      senderName = senderMatch[2].trim();
    }
  }

  // ----------------------------------------------------
  // Fallback: se o usuário colou apenas o ID diretamente
  // ----------------------------------------------------
  if (!txId) {
    const rawClean = raw.replace(/\s+/g, '');
    if (/^[A-Za-z0-9._-]{6,45}$/.test(rawClean)) {
      txId = rawClean;
      service = rawClean.startsWith('PP') ? 'emola' : 'mpesa';
    }
  }

  return {
    service: service || 'outro',
    txId: txId ? txId.toUpperCase() : null,
    amount: isNaN(amount) ? null : amount,
    senderPhone,
    senderName,
    rawMessage: raw,
  };
}

/**
 * Salva um SMS recebido do celular gateway na tabela mobile_payments
 */
async function registrarSmsRecebido(rawMessage) {
  const parsed = parseSms(rawMessage);

  if (!parsed || !parsed.txId) {
    throw new Error('Não foi possível identificar o ID da transação na mensagem SMS fornecida.');
  }

  const { rows } = await query(
    `INSERT INTO mobile_payments (service, tx_id, amount, sender_phone, sender_name, raw_message, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'RECEBIDO')
     ON CONFLICT (tx_id) DO UPDATE SET
       raw_message = EXCLUDED.raw_message,
       amount = COALESCE(EXCLUDED.amount, mobile_payments.amount)
     RETURNING *`,
    [
      parsed.service,
      parsed.txId,
      parsed.amount || 0.00,
      parsed.senderPhone,
      parsed.senderName,
      rawMessage,
    ]
  );

  return rows[0];
}

/**
 * Valida o comprovativo colado pelo cliente, verifica se é válido, se já foi usado,
 * e ativa/estende o plano do usuário correspondente ao valor.
 */
async function resgatarPagamento({ deviceId, comprovativo }) {
  if (!deviceId) {
    throw new Error('device_id é obrigatório para resgatar o plano.');
  }
  if (!comprovativo) {
    throw new Error('Mensagem ou ID do comprovativo não fornecido.');
  }

  // Tenta fazer o parsing para extrair o txId
  const parsed = parseSms(comprovativo);
  const txIdBusca = parsed && parsed.txId ? parsed.txId : comprovativo.trim().toUpperCase();

  // Busca na tabela de pagamentos móveis
  const { rows: pagamentos } = await query(
    `SELECT * FROM mobile_payments WHERE UPPER(tx_id) = $1`,
    [txIdBusca]
  );

  if (pagamentos.length === 0) {
    return {
      sucesso: false,
      status: 'nao_encontrado',
      mensagem: '❌ Comprovativo não encontrado no sistema. Se você acabou de pagar, aguarde 30 a 60 segundos para o robô sincronizar o SMS e tente novamente.',
      tx_id: txIdBusca,
    };
  }

  const pagamento = pagamentos[0];

  // Verifica se já foi usado
  if (pagamento.status === 'USADO') {
    return {
      sucesso: false,
      status: 'ja_usado',
      mensagem: `❌ Este comprovativo já foi utilizado anteriormente no aparelho ${pagamento.usado_por_device_id || 'outro usuário'} em ${new Date(pagamento.usado_em).toLocaleString('pt-PT')}!`,
      tx_id: pagamento.tx_id,
      usado_em: pagamento.usado_em,
    };
  }

  // Pagamento está 'RECEBIDO' e disponível!
  const valorRecebido = parseFloat(pagamento.amount);

  // Determina qual plano conceder pelo valor pago em MZN (MT)
  const { rows: planos } = await query(
    `SELECT * FROM planos WHERE ativo = true ORDER BY preco_mzn DESC`
  );

  let planoEscolhido = null;
  let diasConcedidos = 1;

  for (const p of planos) {
    if (valorRecebido >= parseFloat(p.preco_mzn)) {
      planoEscolhido = p;
      diasConcedidos = p.dias;
      break;
    }
  }

  // Se o valor for menor que o plano mais baixo (ex: teste de 5 MT), garante pelo menos 1 dia
  const nomePlano = planoEscolhido ? planoEscolhido.nome : `${diasConcedidos} Dia(s) VIP`;

  // Marca o comprovativo como USADO
  await query(
    `UPDATE mobile_payments 
     SET status = 'USADO',
         usado_por_device_id = $1,
         usado_em = NOW(),
         plano_ativado = $2
     WHERE id = $3`,
    [deviceId, nomePlano, pagamento.id]
  );

  // Ativa / estende o usuário na tabela users
  const { rows: userRows } = await query(
    `INSERT INTO users (device_id, user_name, status, plano, validade_ate, total_compras, ultima_vez_online)
     VALUES ($1, 'Jogador VIP', 'ATIVO', $2, NOW() + ($3 || ' days')::INTERVAL, $4, NOW())
     ON CONFLICT (device_id) DO UPDATE
     SET status = 'ATIVO',
         plano = $2,
         validade_ate = GREATEST(NOW(), users.validade_ate) + ($3 || ' days')::INTERVAL,
         total_compras = users.total_compras + $4,
         ultima_vez_online = NOW()
     RETURNING *;`,
    [deviceId, nomePlano, diasConcedidos.toString(), valorRecebido]
  );

  const user = userRows[0];

  return {
    sucesso: true,
    status: 'ativado',
    mensagem: `🎉 Parabéns! Pagamento de ${valorRecebido.toFixed(2)} MT confirmado via ${pagamento.service.toUpperCase()}. O plano "${nomePlano}" foi ativado com sucesso!`,
    tx_id: pagamento.tx_id,
    servico: pagamento.service,
    valor_mt: valorRecebido,
    dias_adicionados: diasConcedidos,
    validade_ate: user.validade_ate,
    user,
  };
}

module.exports = {
  parseSms,
  registrarSmsRecebido,
  resgatarPagamento,
};
