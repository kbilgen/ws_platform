// db.js — Supabase Postgres CRUD (sağlamlaştırılmış)
const { Pool } = require('pg');

// DEBUG: Environment variables'ları logla
console.log('=== ENV DEBUG ===');
console.log('SUPABASE_DB_URL exists:', !!process.env.SUPABASE_DB_URL);
console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);
console.log('SUPABASE_DB_URL length:', process.env.SUPABASE_DB_URL?.length || 0);
console.log('DATABASE_URL length:', process.env.DATABASE_URL?.length || 0);
console.log('=================');

// 1) Bağlantı dizesini ENV'den oku (SUPABASE_DB_URL öncelikli, yoksa DATABASE_URL)
const RAW_CONN =
  (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').trim();

console.log('Final RAW_CONN length:', RAW_CONN.length);
console.log('Final RAW_CONN preview:', RAW_CONN.substring(0, 50) + '...');

if (!RAW_CONN) {
  console.error(
    'FATAL: SUPABASE_DB_URL / DATABASE_URL tanımlı değil! ' +
    'Railway Variables ekranında postgresql://... bağlantı dizesini ekleyin.'
  );
  throw new Error('Missing SUPABASE_DB_URL / DATABASE_URL');
}

// 2) Pool ayarları (IPv6 sorunu için optimized)
const pool = new Pool({
  connectionString: RAW_CONN,
  ssl: { rejectUnauthorized: false },
  max: 3,                       // düşürüldü
  min: 1,                       // minimum bağlantı
  idleTimeoutMillis: 10_000,    // kısaltıldı
  connectionTimeoutMillis: 8_000, // kısaltıldı
  acquireTimeoutMillis: 8_000,  // yeni: acquire timeout
  // IPv6 sorunları için retry logic
  retryDelayMs: 1000,
});

// Bağlantı havuzundaki beklenmeyen hataları logla ama crash'e sebep olma
pool.on('error', (err) => {
  console.error('PG POOL ERROR (non-fatal):', err?.message || err);
  // Pool error'ları genellikle idle connection'larda olur, crash'e sebep olmaz
});

// Connection test fonksiyonu
async function testConnection() {
  let retries = 3;
  while (retries > 0) {
    try {
      console.log('Testing database connection...');
      const client = await pool.connect();
      const result = await client.query('SELECT NOW()');
      client.release();
      console.log('Database connection successful:', result.rows[0].now);
      return true;
    } catch (error) {
      retries--;
      console.error(`Database connection failed (${3-retries}/3):`, error.message);
      if (retries > 0) {
        console.log('Retrying in 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  console.error('Database connection failed after 3 attempts. App will continue but DB operations may fail.');
  return false;
}

// Startup'ta connection test et (ama crash etme)
testConnection().catch(err => {
  console.error('Initial DB test failed:', err.message);
});

// 3) CRUD metotları - her birinde error handling
const DB = {
  async upsertSession(s) {
    try {
      await pool.query(
        `
        insert into sessions (id, name, status, api_key, webhook_url, webhook_secret, created_at)
        values ($1, $2, $3, $4, $5, $6, to_timestamp($7/1000.0))
        on conflict (id) do update set
          name = excluded.name,
          status = excluded.status,
          api_key = coalesce(excluded.api_key, sessions.api_key),
          webhook_url = coalesce(excluded.webhook_url, sessions.webhook_url),
          webhook_secret = coalesce(excluded.webhook_secret, sessions.webhook_secret)
        `,
        [s.id, s.name, s.status, s.api_key, s.webhook_url, s.webhook_secret, s.created_at]
      );
    } catch (error) {
      console.error('DB upsertSession error:', error.message);
      throw error;
    }
  },

  async setStatus(id, status) {
    try {
      await pool.query(`update sessions set status = $1 where id = $2`, [status, id]);
    } catch (error) {
      console.error('DB setStatus error:', error.message);
      throw error;
    }
  },

  async setWebhook(id, url, secret) {
    try {
      await pool.query(
        `update sessions set webhook_url = $1, webhook_secret = $2 where id = $3`,
        [url, secret, id]
      );
    } catch (error) {
      console.error('DB setWebhook error:', error.message);
      throw error;
    }
  },

  async setApiKey(id, key) {
    try {
      await pool.query(`update sessions set api_key = $1 where id = $2`, [key, id]);
    } catch (error) {
      console.error('DB setApiKey error:', error.message);
      throw error;
    }
  },

  async get(id) {
    try {
      const r = await pool.query(`select * from sessions where id = $1`, [id]);
      return r.rows[0] || null;
    } catch (error) {
      console.error('DB get error:', error.message);
      throw error;
    }
  },

  async list() {
    try {
      const r = await pool.query(`select * from sessions order by created_at desc`);
      return r.rows;
    } catch (error) {
      console.error('DB list error:', error.message);
      throw error;
    }
  },

  async del(id) {
    try {
      await pool.query(`delete from sessions where id = $1`, [id]);
    } catch (error) {
      console.error('DB del error:', error.message);
      throw error;
    }
  },

  // Teşhis için basit ping
  async ping() {
    try {
      const r = await pool.query('select now() as now');
      return r.rows[0].now;
    } catch (error) {
      console.error('DB ping error:', error.message);
      throw error;
    }
  }
};

module.exports = { DB, pool };