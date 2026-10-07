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
    console.log('Conectado ao PostgreSQL com sucesso. Verificando tabelas...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        transaction_id VARCHAR(255) UNIQUE,
        customer_email VARCHAR(255),
        amount NUMERIC(10, 2),
        currency VARCHAR(10) DEFAULT 'BRL',
        status VARCHAR(50) DEFAULT 'pending',
        gateway VARCHAR(50) DEFAULT 'escalapay',
        payload JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        uuid VARCHAR(255) UNIQUE,
        email VARCHAR(255) UNIQUE,
        name VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Tabela de ordens de pagamento Binance Pay
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        codigo VARCHAR(50) UNIQUE NOT NULL,
        amount NUMERIC(10, 4) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USDT',
        descricao TEXT,
        customer_id VARCHAR(255),
        customer_info JSONB,
        status VARCHAR(30) DEFAULT 'pending',
        binance_tx_id VARCHAR(255),
        binance_payload JSONB,
        access_token VARCHAR(255),
        expires_at TIMESTAMP WITH TIME ZONE,
        paid_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    console.log('Tabelas inicializadas com sucesso.');
  } catch (err) {
    console.error('Erro ao inicializar tabelas no banco de dados:', err);
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  initDatabase,
};
