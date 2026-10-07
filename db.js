const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL?.includes('sslmode=disable')
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('Erro inesperado no cliente PostgreSQL:', err);
});

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.warn('AVISO: DATABASE_URL não definida. Executando sem banco de dados.');
    return;
  }

  const client = await pool.connect();
  try {
    console.log('Conectado ao PostgreSQL. Inicializando tabelas...');

    // -----------------------------------------------
    // 1. TABELA USERS (Usuários / Aparelhos)
    // -----------------------------------------------
    // Verifica se a tabela users existente tem a coluna device_id
    const { rows: colCheck } = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'device_id';
    `);

    if (colCheck.length === 0) {
      console.log('Migrando tabela users para o novo esquema com device_id...');
      await client.query(`DROP TABLE IF EXISTS users CASCADE;`);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        device_id         VARCHAR(64) PRIMARY KEY,
        user_name         VARCHAR(100) DEFAULT 'Jogador VIP',
        status            VARCHAR(20) DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','EXPIRADO','TESTE')),
        plano             VARCHAR(50) DEFAULT '15 Dias VIP',
        validade_ate      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW() + INTERVAL '15 days',
        data_registro     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        ultima_vez_online TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        total_compras     DECIMAL(10,2) DEFAULT 0.00,
        total_vezes_usou_bot INT DEFAULT 0,
        total_lucro       DECIMAL(10,2) DEFAULT 0.00,
        ganhos_hoje       DECIMAL(10,2) DEFAULT 0.00,
        perdas_hoje       DECIMAL(10,2) DEFAULT 0.00,
        ganhos_ontem      DECIMAL(10,2) DEFAULT 0.00,
        perdas_ontem      DECIMAL(10,2) DEFAULT 0.00,
        ganhos_mes        DECIMAL(10,2) DEFAULT 0.00,
        perdas_mes        DECIMAL(10,2) DEFAULT 0.00
      );
    `);

    // -----------------------------------------------
    // 2. TABELA CASAS (Casas de Apostas)
    // -----------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS casas (
        id           VARCHAR(50) PRIMARY KEY,
        nome         VARCHAR(100) NOT NULL,
        pais         VARCHAR(50) NOT NULL,
        descricao    TEXT,
        link         VARCHAR(255) NOT NULL,
        texto_botao  VARCHAR(100) DEFAULT 'SINCRONIZAR E JOGAR AGORA',
        rating       INT DEFAULT 5 CHECK (rating BETWEEN 1 AND 5),
        badge        VARCHAR(50) DEFAULT 'RECOMENDADA',
        criado_em    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // -----------------------------------------------
    // 3. TABELA PLANOS (Planos e Preços)
    // -----------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS planos (
        id          VARCHAR(50) PRIMARY KEY,
        nome        VARCHAR(100) NOT NULL,
        dias        INT NOT NULL,
        preco_mzn   DECIMAL(10,2) NOT NULL,
        preco_usdt  DECIMAL(10,4) NOT NULL,
        periodo     VARCHAR(100),
        is_popular  BOOLEAN DEFAULT FALSE,
        ativo       BOOLEAN DEFAULT TRUE
      );
    `);

    // -----------------------------------------------
    // 4. TABELA CONFIGURACOES (Sistema)
    // -----------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS configuracoes (
        id              SERIAL PRIMARY KEY,
        suporte_link    VARCHAR(255) NOT NULL DEFAULT '',
        aviso_admin     TEXT,
        versao_minima   VARCHAR(20) DEFAULT '1.0'
      );
    `);

    // Inserir configuração padrão se não existir
    await client.query(`
      INSERT INTO configuracoes (id, suporte_link, aviso_admin, versao_minima)
      VALUES (1, '', NULL, '1.0')
      ON CONFLICT (id) DO NOTHING;
    `);

    // -----------------------------------------------
    // 5. TABELA PAYMENTS (Pagamentos - já existia)
    // -----------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id             SERIAL PRIMARY KEY,
        transaction_id VARCHAR(255) UNIQUE,
        customer_email VARCHAR(255),
        amount         NUMERIC(10,2),
        currency       VARCHAR(10) DEFAULT 'BRL',
        status         VARCHAR(50) DEFAULT 'pending',
        gateway        VARCHAR(50) DEFAULT 'escalapay',
        payload        JSONB,
        created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // -----------------------------------------------
    // 6. TABELA ORDERS (Pedidos Binance Pay - já existia)
    // -----------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id              SERIAL PRIMARY KEY,
        codigo          VARCHAR(50) UNIQUE NOT NULL,
        amount          NUMERIC(10,4) NOT NULL,
        currency        VARCHAR(10) NOT NULL DEFAULT 'USDT',
        descricao       TEXT,
        customer_id     VARCHAR(255),
        customer_info   JSONB,
        status          VARCHAR(30) DEFAULT 'pending',
        binance_tx_id   VARCHAR(255),
        binance_payload JSONB,
        access_token    VARCHAR(255),
        expires_at      TIMESTAMP WITH TIME ZONE,
        paid_at         TIMESTAMP WITH TIME ZONE,
        created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // -----------------------------------------------
    // SEED: Planos padrão (só insere se ainda não existem)
    // -----------------------------------------------
    await client.query(`
      INSERT INTO planos (id, nome, dias, preco_mzn, preco_usdt, periodo, is_popular, ativo) VALUES
        ('plano_1d',  '1 Dia VIP',   1,  350.00,  6.00, '1 Dia',     FALSE, TRUE),
        ('plano_7d',  '7 Dias VIP',  7,  555.00, 12.22, '7 Dias',    FALSE, TRUE),
        ('plano_15d', '15 Dias VIP', 15, 799.00, 15.55, '15 Dias',   TRUE,  TRUE),
        ('plano_30d', '30 Dias VIP', 30, 899.00, 22.32, '30 Dias',   FALSE, TRUE)
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log('✅ Todas as tabelas inicializadas com sucesso.');
  } catch (err) {
    console.error('❌ Erro ao inicializar banco de dados:', err);
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  initDatabase,
};
