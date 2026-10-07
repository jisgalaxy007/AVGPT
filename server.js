require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, query, initDatabase } = require('./db');

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
// ROTA PRINCIPAL SOLICITADA: /pone
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
// APIs ADICIONAIS: Consulta e Listagem de Pagamentos
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
// ROTA HEALTH CHECK & STATUS
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
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    app: 'AVGPT Backend API',
    status: 'online',
    version: '1.0.0',
    endpoints: {
      redirect_rota_pone: '/pone (Abre o App Android via avgpt://pagamento-sucesso)',
      webhook_escalapay: '/webhook/escalapay',
      health: '/health',
      payments: '/api/payments'
    }
  });
});

// Inicialização do servidor
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`=========================================`);
  console.log(`AVGPT Backend iniciado na porta ${PORT}`);
  console.log(`Rota de redirecionamento: http://localhost:${PORT}/pone`);
  console.log(`=========================================`);
  await initDatabase();
});
