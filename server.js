require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, query, initDatabase } = require('./db');
const binance = require('./binance');
const { criarPedido, buscarPedido, verificarPorTxid } = require('./pagamento');
const mobileMoney = require('./mobile_money');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Função geradora da página de redirecionamento para o App Android
function generateSuccessPage(req) {
  const queryString = req.originalUrl.includes('?') 
    ? req.originalUrl.substring(req.originalUrl.indexOf('?')) 
    : '';
  const deepLink = `avgpt://pagamento-sucesso${queryString}`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pagamento Confirmado - AVGPT</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
      color: #f8fafc;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      text-align: center;
    }
    .card {
      background: rgba(30, 41, 59, 0.9);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 40px 28px;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.5);
    }
    .icon-container {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      box-shadow: 0 10px 20px rgba(16, 185, 129, 0.3);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.05); }
      100% { transform: scale(1); }
    }
    .icon-container svg {
      width: 44px;
      height: 44px;
      fill: #ffffff;
    }
    h1 {
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 12px;
      color: #ffffff;
    }
    p {
      color: #94a3b8;
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 28px;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      color: white;
      text-decoration: none;
      font-weight: 600;
      font-size: 16px;
      border-radius: 14px;
      box-shadow: 0 8px 16px rgba(37, 99, 235, 0.3);
      transition: all 0.2s ease;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 20px rgba(37, 99, 235, 0.4);
    }
    .subtext {
      margin-top: 16px;
      font-size: 12px;
      color: #64748b;
    }
  </style>
  <script>
    // Redireciona o navegador do cliente para abrir o app
    window.location.href = "${deepLink}";
  </script>
</head>
<body>
  <div class="card">
    <div class="icon-container">
      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </div>
    <h1>Pagamento Aprovado!</h1>
    <p>Obrigado! Seu pagamento via EscalaPay foi confirmado com sucesso. Estamos abrindo o aplicativo <strong>AVGPT</strong> no seu celular...</p>
    
    <a href="${deepLink}" class="btn" id="openAppBtn">
      <span>Abrir Aplicativo AVGPT</span>
      <svg style="width: 18px; height: 18px; fill: currentColor;" viewBox="0 0 24 24">
        <path d="M5 13h11.86l-5.43 5.43 1.42 1.42L21.14 12l-8.29-8.29-1.42 1.42L16.86 11H5v2z"/>
      </svg>
    </a>
    
    <div class="subtext">
      Se o aplicativo não abrir automaticamente em alguns instantes, toque no botão acima.
    </div>
  </div>

  <script>
    // Se o cliente continuar na página após 1 segundo, tenta novamente
    setTimeout(function() {
      var btn = document.getElementById('openAppBtn');
      if (btn) {
        btn.focus();
      }
    }, 1200);
  </script>
</body>
</html>`;
}

// -------------------------------------------------------------
// ROTA PRINCIPAL: /pone
// (Também disponível em /pagamento-sucesso, /retorno, /payment-success)
// -------------------------------------------------------------
const handlePaymentSuccessRedirect = (req, res) => {
  console.log(`[${new Date().toISOString()}] Redirecionamento de pagamento acessado: ${req.originalUrl}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(generateSuccessPage(req));
};

app.get('/pone', handlePaymentSuccessRedirect);
app.get('/pagamento-sucesso', handlePaymentSuccessRedirect);
app.get('/payment-success', handlePaymentSuccessRedirect);
app.get('/retorno', handlePaymentSuccessRedirect);

// -------------------------------------------------------------
// WEBHOOK ESCALAPAY: Recebe notificação de pagamento e grava no banco
// -------------------------------------------------------------
app.post('/webhook/escalapay', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[Webhook EscalaPay] Notificação recebida:', JSON.stringify(payload));

    const transactionId = payload.id || payload.transaction_id || payload.order_id || `tx_${Date.now()}`;
    const status = payload.status || 'paid';
    const amount = payload.amount || payload.total || 0;
    const customerEmail = payload.customer?.email || payload.email || null;

    if (process.env.DATABASE_URL) {
      await query(`
        INSERT INTO payments (transaction_id, customer_email, amount, status, gateway, payload, updated_at)
        VALUES ($1, $2, $3, $4, 'escalapay', $5, NOW())
        ON CONFLICT (transaction_id) 
        DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload, updated_at = NOW();
      `, [transactionId, customerEmail, amount, status, JSON.stringify(payload)]);
      console.log(`[Webhook EscalaPay] Transação ${transactionId} gravada/atualizada com status: ${status}`);
    }

    return res.status(200).json({ success: true, message: 'Webhook processado com sucesso.' });
  } catch (error) {
    console.error('[Webhook EscalaPay] Erro ao processar:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------------------------------------------------
// ROTAS BINANCE: Leitura de pagamentos, depósitos e saldos
// -------------------------------------------------------------

// 1. Depósitos Cripto Recebidos (USDT, BTC, etc.)
app.get('/api/binance/deposits', async (req, res) => {
  try {
    const { coin, status, limit } = req.query;
    const deposits = await binance.getDepositHistory({
      coin,
      status: status !== undefined ? parseInt(status) : undefined,
      limit: limit ? parseInt(limit) : 50,
    });
    res.json({ success: true, count: deposits.length, data: deposits });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Depósitos Fiat Recebidos (PIX, BRL, etc.)
app.get('/api/binance/fiat', async (req, res) => {
  try {
    const orders = await binance.getFiatOrders(req.query);
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Transações Binance Pay
app.get('/api/binance/pay', async (req, res) => {
  try {
    const payHistory = await binance.getPayHistory(req.query);
    res.json({ success: true, count: payHistory.length, data: payHistory });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Saques / Transferências
app.get('/api/binance/withdraws', async (req, res) => {
  try {
    const withdraws = await binance.getWithdrawHistory(req.query);
    res.json({ success: true, count: withdraws.length, data: withdraws });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Ordens P2P / C2C (Compras e Vendas P2P em Moeda Local MZN)
app.get('/api/binance/p2p', async (req, res) => {
  try {
    const [p2pBuy, p2pSell] = await Promise.allSettled([
      binance.getP2POrders({ tradeType: 'BUY', ...req.query }),
      binance.getP2POrders({ tradeType: 'SELL', ...req.query }),
    ]);

    const ordens = [
      ...(p2pBuy.status === 'fulfilled' && Array.isArray(p2pBuy.value) ? p2pBuy.value : []),
      ...(p2pSell.status === 'fulfilled' && Array.isArray(p2pSell.value) ? p2pSell.value : []),
    ];

    res.json({ success: true, count: ordens.length, data: ordens });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Histórico Completo de Transações da Binance (P2P + Depósitos + Saques + Pay)
app.get('/api/binance/historico-completo', async (req, res) => {
  try {
    const [deposits, withdraws, pay, p2pBuy, p2pSell, balances] = await Promise.allSettled([
      binance.getDepositHistory(),
      binance.getWithdrawHistory(),
      binance.getPayHistory(),
      binance.getP2POrders({ tradeType: 'BUY' }),
      binance.getP2POrders({ tradeType: 'SELL' }),
      binance.getAccountBalances(),
    ]);

    const ordensP2p = [
      ...(p2pBuy.status === 'fulfilled' && Array.isArray(p2pBuy.value) ? p2pBuy.value : []),
      ...(p2pSell.status === 'fulfilled' && Array.isArray(p2pSell.value) ? p2pSell.value : []),
    ];

    res.json({
      success: true,
      p2p_c2c: ordensP2p,
      depositos_onchain: deposits.status === 'fulfilled' ? deposits.value : [],
      saques_transferencias: withdraws.status === 'fulfilled' ? withdraws.value : [],
      binance_pay: pay.status === 'fulfilled' ? pay.value : [],
      saldos: balances.status === 'fulfilled' ? balances.value : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Saldos da Carteira
app.get('/api/binance/balance', async (req, res) => {
  try {
    const balances = await binance.getAccountBalances();
    res.json({ success: true, data: balances });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Sincronizar depósitos da Binance para o banco PostgreSQL
app.post('/api/binance/sync', async (req, res) => {
  try {
    const deposits = await binance.getDepositHistory({ limit: 50 });
    let synced = 0;

    for (const d of deposits) {
      const txId = d.txId || `binance_${d.id}`;
      const amount = parseFloat(d.amount);
      const coin = d.coin;
      const status = d.status === 1 ? 'paid' : d.status === 0 ? 'pending' : 'credited';

      if (process.env.DATABASE_URL) {
        await query(`
          INSERT INTO payments (transaction_id, customer_email, amount, currency, status, gateway, payload, updated_at)
          VALUES ($1, $2, $3, $4, $5, 'binance', $6, NOW())
          ON CONFLICT (transaction_id)
          DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload, updated_at = NOW();
        `, [txId, d.address || null, amount, coin, status, JSON.stringify(d)]);
        synced++;
      }
    }

    res.json({ success: true, message: `${synced} pagamentos/depósitos Binance sincronizados.`, totalDeposits: deposits.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// ROTAS DE PEDIDO E VERIFICAÇÃO DE PAGAMENTO BINANCE PAY / CRIPTO
// ============================================================
// FLUXO UNIVERSAL:
//   O cliente cola apenas o TXID / Hash e o device_id (igual ao e-Mola / M-Pesa!).
//   Opcionalmente, pode enviar também o código de pedido (codigo).
// -------------------------------------------------------------

// 1. CRIAR PEDIDO (Opcional)
app.post('/api/pagamento/criar', async (req, res) => {
  try {
    const { amount, currency, descricao, customerInfo } = req.body;
    if (!amount) {
      return res.status(400).json({ success: false, error: 'Informe o valor (amount) do pagamento.' });
    }
    const pedido = await criarPedido({ amount, currency, descricao, customerInfo });
    res.json({ success: true, data: pedido });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. CONSULTAR STATUS DO PEDIDO
app.get('/api/pagamento/:codigo', async (req, res) => {
  try {
    const pedido = await buscarPedido(req.params.codigo);
    if (!pedido) return res.status(404).json({ success: false, error: 'Pedido não encontrado.' });
    const { access_token, binance_payload, ...safe } = pedido;
    res.json({ success: true, data: safe });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. VERIFICAR PAGAMENTO VIA TXID (Modo Universal: Direto ou com Código)
//    Body: { txid: "0x...", device_id: "DEV-..." } OU { codigo: "AVGPT-...", txid: "..." }
app.post('/api/pagamento/verificar', async (req, res) => {
  try {
    const txid = req.body.txid || req.body.tx_id || req.body.hash || req.body.comprovativo;
    const codigo = req.body.codigo || null;
    const deviceId = req.body.device_id || req.body.deviceId || null;

    if (!txid) {
      return res.status(400).json({
        success: false,
        error: 'Informe o TXID / Hash da transação Binance (txid).',
      });
    }

    const resultado = await verificarPorTxid({ codigo, txid, deviceId });

    const httpStatus = resultado.sucesso ? 200
      : resultado.status === 'txid_not_found' ? 404
      : resultado.status === 'txid_already_used' ? 409
      : resultado.status === 'valor_invalido' ? 422
      : 400;

    res.status(httpStatus).json(resultado);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. VALIDAR ACCESS TOKEN (app verifica se o token ainda é válido em sessões futuras)
//    Body: { access_token: "abc123..." }
app.post('/api/pagamento/validar-token', async (req, res) => {
  try {
    const { access_token } = req.body;
    if (!access_token) {
      return res.status(400).json({ success: false, error: 'Token não informado.' });
    }

    const { rows } = await query(
      `SELECT codigo, amount, currency, descricao, paid_at, binance_tx_id
       FROM orders WHERE access_token = $1 AND status = 'paid'`,
      [access_token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Token inválido ou pagamento não confirmado.' });
    }

    res.json({
      success: true,
      acesso: true,
      mensagem: '✅ Token válido. Acesso liberado.',
      pedido: rows[0],
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. LISTAR PEDIDOS (admin)
app.get('/api/pagamento', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT codigo, amount, currency, descricao, status, binance_tx_id, paid_at, created_at, expires_at
       FROM orders ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {

    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// APIs DE PAGAMENTOS
// -------------------------------------------------------------
app.get('/api/payments', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM payments ORDER BY created_at DESC LIMIT 50');
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/payments/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { rows } = await query('SELECT * FROM payments WHERE transaction_id = $1', [transactionId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pagamento não encontrado.' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// -------------------------------------------------------------
// APIs DE USUÁRIOS E APARELHOS (users)
// -------------------------------------------------------------

// Obter dados do usuário pelo device_id (calcula status ATIVO/EXPIRADO com base na validade)
app.get('/api/users/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { rows } = await query('SELECT * FROM users WHERE device_id = $1', [deviceId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }

    let user = rows[0];
    const agora = new Date();
    const validade = new Date(user.validade_ate);

    // Se a validade expirou e status ainda constava ATIVO, atualiza no banco
    if (agora > validade && user.status === 'ATIVO') {
      await query(`UPDATE users SET status = 'EXPIRADO' WHERE device_id = $1`, [deviceId]);
      user.status = 'EXPIRADO';
    }

    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sincronizar/Cadastrar aparelho (Login do App Android)
app.post('/api/users/sync', async (req, res) => {
  try {
    const { device_id, user_name, plano } = req.body;
    if (!device_id) {
      return res.status(400).json({ success: false, error: 'device_id é obrigatório.' });
    }

    const { rows: existente } = await query('SELECT * FROM users WHERE device_id = $1', [device_id]);

    if (existente.length > 0) {
      // Atualiza última vez online e nome se fornecido
      const nomeFinal = user_name || existente[0].user_name;
      const { rows: updated } = await query(`
        UPDATE users 
        SET ultima_vez_online = NOW(),
            user_name = $2,
            status = CASE WHEN validade_ate < NOW() THEN 'EXPIRADO' ELSE status END
        WHERE device_id = $1
        RETURNING *;
      `, [device_id, nomeFinal]);

      return res.json({ success: true, is_new: false, data: updated[0] });
    }

    // Novo usuário - concede plano inicial de 15 dias VIP
    const nome = user_name || 'Jogador VIP';
    const planoNome = plano || '15 Dias VIP';
    const { rows: novo } = await query(`
      INSERT INTO users (device_id, user_name, plano, status, validade_ate, data_registro, ultima_vez_online)
      VALUES ($1, $2, $3, 'ATIVO', NOW() + INTERVAL '15 days', NOW(), NOW())
      RETURNING *;
    `, [device_id, nome, planoNome]);

    res.status(201).json({ success: true, is_new: true, data: novo[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Atualizar estatísticas de jogo e bot do usuário
app.post('/api/users/stats', async (req, res) => {
  try {
    const {
      device_id,
      total_vezes_usou_bot,
      total_lucro,
      ganhos_hoje,
      perdas_hoje,
      ganhos_ontem,
      perdas_ontem,
      ganhos_mes,
      perdas_mes
    } = req.body;

    if (!device_id) {
      return res.status(400).json({ success: false, error: 'device_id é obrigatório.' });
    }

    const { rows } = await query(`
      UPDATE users SET
        total_vezes_usou_bot = COALESCE($2, total_vezes_usou_bot),
        total_lucro = COALESCE($3, total_lucro),
        ganhos_hoje = COALESCE($4, ganhos_hoje),
        perdas_hoje = COALESCE($5, perdas_hoje),
        ganhos_ontem = COALESCE($6, ganhos_ontem),
        perdas_ontem = COALESCE($7, perdas_ontem),
        ganhos_mes = COALESCE($8, ganhos_mes),
        perdas_mes = COALESCE($9, perdas_mes),
        ultima_vez_online = NOW()
      WHERE device_id = $1
      RETURNING *;
    `, [
      device_id,
      total_vezes_usou_bot,
      total_lucro,
      ganhos_hoje,
      perdas_hoje,
      ganhos_ontem,
      perdas_ontem,
      ganhos_mes,
      perdas_mes
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// APIs DE CASAS DE APOSTAS (casas)
// -------------------------------------------------------------
app.get('/api/casas', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM casas ORDER BY rating DESC, criado_em ASC');
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/casas', async (req, res) => {
  try {
    const { id, nome, pais, descricao, link, texto_botao, rating, badge } = req.body;
    if (!id || !nome || !pais || !link) {
      return res.status(400).json({ success: false, error: 'id, nome, pais e link são obrigatórios.' });
    }

    const { rows } = await query(`
      INSERT INTO casas (id, nome, pais, descricao, link, texto_botao, rating, badge, criado_em)
      VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'SINCRONIZAR E JOGAR AGORA'), COALESCE($7, 5), COALESCE($8, 'RECOMENDADA'), NOW())
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome,
        pais = EXCLUDED.pais,
        descricao = EXCLUDED.descricao,
        link = EXCLUDED.link,
        texto_botao = EXCLUDED.texto_botao,
        rating = EXCLUDED.rating,
        badge = EXCLUDED.badge
      RETURNING *;
    `, [id, nome, pais, descricao, link, texto_botao, rating, badge]);

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/casas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await query('DELETE FROM casas WHERE id = $1', [id]);
    res.json({ success: true, message: `Casa ${id} removida com sucesso.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// APIs DE PLANOS E PREÇOS (planos)
// -------------------------------------------------------------
app.get('/api/planos', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM planos WHERE ativo = true ORDER BY dias ASC');
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/planos', async (req, res) => {
  try {
    const { id, nome, dias, preco_mzn, preco_usdt, periodo, is_popular, ativo } = req.body;
    if (!id || !nome || !dias || preco_mzn === undefined || preco_usdt === undefined) {
      return res.status(400).json({ success: false, error: 'id, nome, dias, preco_mzn e preco_usdt são obrigatórios.' });
    }

    const { rows } = await query(`
      INSERT INTO planos (id, nome, dias, preco_mzn, preco_usdt, periodo, is_popular, ativo)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, FALSE), COALESCE($8, TRUE))
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome,
        dias = EXCLUDED.dias,
        preco_mzn = EXCLUDED.preco_mzn,
        preco_usdt = EXCLUDED.preco_usdt,
        periodo = EXCLUDED.periodo,
        is_popular = EXCLUDED.is_popular,
        ativo = EXCLUDED.ativo
      RETURNING *;
    `, [id, nome, dias, preco_mzn, preco_usdt, periodo, is_popular, ativo]);

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// APIs DE CONFIGURAÇÕES DO SISTEMA (configuracoes)
// -------------------------------------------------------------
app.get('/api/configuracoes', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM configuracoes WHERE id = 1');
    res.json({ success: true, data: rows[0] || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/configuracoes', async (req, res) => {
  try {
    const { suporte_link, aviso_admin, versao_minima } = req.body;
    const { rows } = await query(`
      INSERT INTO configuracoes (id, suporte_link, aviso_admin, versao_minima)
      VALUES (1, COALESCE($1, ''), $2, COALESCE($3, '1.0'))
      ON CONFLICT (id) DO UPDATE SET
        suporte_link = COALESCE($1, configuracoes.suporte_link),
        aviso_admin = $2,
        versao_minima = COALESCE($3, configuracoes.versao_minima)
      RETURNING *;
    `, [suporte_link, aviso_admin, versao_minima]);

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// APIs DE PAGAMENTOS MÓVEIS (e-Mola e M-Pesa - Moçambique)
// -------------------------------------------------------------

// 1. Webhook para o app gateway Android (celular receptor de SMS)
// Cabeçalho Obrigatório: x-api-key: emola-secret-key-2026 (ou GATEWAY_API_KEY)
// Corpo da Requisição (JSON): { "sms": "Texto completo do SMS...", "phone": "Número..." }
const handleIncomingSms = async (req, res) => {
  try {
    const expectedKey = process.env.GATEWAY_API_KEY || 'emola-secret-key-2026';
    const providedKey = req.headers['x-api-key'] || req.headers['x-apikey'] || req.headers['authorization'];

    // Validação do Cabeçalho Obrigatório x-api-key
    if (!providedKey || providedKey !== expectedKey) {
      console.warn(`[MobileMoney] Requisição de webhook rejeitada por x-api-key ausente ou inválida.`);
      return res.status(401).json({
        success: false,
        error: 'Não autorizado. Cabeçalho obrigatório x-api-key ausente ou inválido.',
      });
    }

    // Suporte ao formato exato enviado pelo app Android:
    // { "sms": "Texto completo...", "phone": "Número..." }
    const rawMessage = req.body.sms || req.body.message || req.body.raw_sms || req.body.text;
    const phone = req.body.phone || req.body.sender || null;

    if (!rawMessage) {
      return res.status(400).json({ success: false, error: 'Campo "sms" não fornecido no corpo da requisição.' });
    }

    const registrado = await mobileMoney.registrarSmsRecebido(rawMessage, phone);
    console.log(`[MobileMoney] Novo SMS registrado: ${registrado.service.toUpperCase()} | ID: ${registrado.tx_id} | Valor: ${registrado.amount} MT | Tel: ${registrado.sender_phone || 'N/A'}`);

    res.status(200).json({
      success: true,
      message: 'SMS registrado com sucesso com status RECEBIDO.',
      data: registrado,
    });
  } catch (err) {
    console.error('[MobileMoney] Erro ao registrar SMS:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
};

// Registra as rotas para garantir suporte total a qualquer URL configurada no App Android
app.post('/api/mobile/webhook', handleIncomingSms);
app.post('/api/sms', handleIncomingSms);
app.post('/api/sms/webhook', handleIncomingSms);
app.post('/webhook/sms', handleIncomingSms);
app.post('/webhook/emola', handleIncomingSms);
app.post('/webhook/mpesa', handleIncomingSms);
app.post('/api/webhook/sms', handleIncomingSms);
app.post('/sms', handleIncomingSms);

// 2. Resgatar / Validar comprovativo (App do cliente final)
// O cliente cola a mensagem de confirmação completa no app
// Body: { device_id: "DEV-4A7B8C9D", comprovativo: "ID Trans: PP261004.2203.Y98273..." }
const handleResgate = async (req, res) => {
  try {
    const deviceId = req.body.device_id || req.body.deviceId;
    const comprovativo = req.body.comprovativo || req.body.mensagem || req.body.tx_id || req.body.txid;

    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'device_id é obrigatório.' });
    }
    if (!comprovativo) {
      return res.status(400).json({ success: false, error: 'Comprovativo ou TXID não fornecido.' });
    }

    const resultado = await mobileMoney.resgatarPagamento({ deviceId, comprovativo });

    const httpStatus = resultado.sucesso ? 200
      : resultado.status === 'nao_encontrado' ? 404
      : resultado.status === 'ja_usado' ? 409
      : resultado.status === 'valor_invalido' ? 422
      : 400;

    res.status(httpStatus).json(resultado);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

app.post('/api/mobile/resgatar', handleResgate);
app.post('/api/mobile/validar', handleResgate);

// 3. Consultar status de um TXID móvel específico
app.get('/api/mobile/status/:txid', async (req, res) => {
  try {
    const { txid } = req.params;
    const { rows } = await query('SELECT * FROM mobile_payments WHERE UPPER(tx_id) = $1', [txid.toUpperCase()]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transação não encontrada.' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Listar transações recebidas (Admin / Histórico)
app.get('/api/mobile/transactions', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM mobile_payments ORDER BY created_at DESC LIMIT 100');
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Testar parser de SMS (sem salvar)
app.post('/api/mobile/parse', (req, res) => {
  const text = req.body.message || req.body.text || req.body.sms;
  if (!text) return res.status(400).json({ error: 'Texto não fornecido.' });
  const parsed = mobileMoney.parseSms(text);
  res.json({ success: true, parsed });
});

// -------------------------------------------------------------
// HEALTH CHECK & STATUS
// -------------------------------------------------------------
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    await query('SELECT 1');
    dbStatus = 'connected';
  } catch (e) {
    dbStatus = `error: ${e.message}`;
  }

  res.json({
    status: 'ok',
    app: 'AVGPT',
    database: dbStatus,
    binance: !!process.env.BINANCE_API_KEY ? 'configured' : 'missing',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    app: 'AVGPT Backend API',
    status: 'online',
    version: '1.3.0',
    endpoints: {
      redirect_rota_pone: '/pone (Abre o App Android via avgpt://pagamento-sucesso)',
      webhook_escalapay: '/webhook/escalapay',
      binance_deposits: '/api/binance/deposits',
      binance_fiat: '/api/binance/fiat',
      binance_pay: '/api/binance/pay',
      binance_balance: '/api/binance/balance',
      binance_sync: 'POST /api/binance/sync',
      pagamento_criar: 'POST /api/pagamento/criar',
      pagamento_verificar: 'POST /api/pagamento/verificar',
      pagamento_validar_token: 'POST /api/pagamento/validar-token',
      mobile_webhook: 'POST /api/mobile/webhook (Recebe SMS puro de e-Mola / M-Pesa)',
      mobile_resgatar: 'POST /api/mobile/resgatar (Cliente valida comprovativo colado)',
      mobile_status: 'GET /api/mobile/status/:txid',
      mobile_transactions: 'GET /api/mobile/transactions',
      mobile_parse: 'POST /api/mobile/parse',
      users_sync: 'POST /api/users/sync',
      users_get: 'GET /api/users/:deviceId',
      users_stats: 'POST /api/users/stats',
      casas: 'GET /api/casas, POST /api/casas',
      planos: 'GET /api/planos, POST /api/planos',
      configuracoes: 'GET /api/configuracoes, POST /api/configuracoes',
      payments: '/api/payments',
      health: '/health'
    }
  });
});

// Inicialização do servidor
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`=========================================`);
  console.log(`AVGPT Backend iniciado na porta ${PORT}`);
  console.log(`Rota de redirecionamento: http://localhost:${PORT}/pone`);
  console.log(`Binance API configurada: ${!!process.env.BINANCE_API_KEY}`);
  console.log(`=========================================`);
  await initDatabase();
});
