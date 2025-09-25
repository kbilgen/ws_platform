// db.js — Supabase Postgres CRUD (sağlamlaştırılmış)
const { Pool } = require('pg');

// 1) Bağlantı dizesini ENV'den oku (SUPABASE_DB_URL öncelikli, yoksa DATABASE_URL)
const RAW_CONN =
  (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').trim();

if (!RAW_CONN) {
  // Env yanlış/eksik ise burada patlatalım ki logdan hemen görülsün
  console.error(
    'FATAL: SUPABASE_DB_URL / DATABASE_URL tanımlı değil! ' +
    'Railway Variables ekranında postgresql://... bağlantı dizesini ekleyin.'
  );
  throw new Error('Missing SUPABASE_DB_URL / DATABASE_URL');
}

// 2) Pool ayarları (Supabase için SSL gerekli)
const pool = new Pool({
  connectionString: RAW_CONN,
  ssl: { rejectUnauthorized: false },
  max: 5,                       // aynı anda en fazla 5 bağlantı
  idleTimeoutMillis: 30_000,    // 30 sn idle
  connectionTimeoutMillis: 10_000
});

// Bağlantı havuzundaki beklenmeyen hataları logla
pool.on('error', (err) => {
  console.error('PG POOL ERROR:', err?.message || err);
});

// 3) CRUD metotları
const DB = {
  async upsertSession(s) {
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
  },

  async setStatus(id, status) {
    await pool.query(`update sessions set status = $1 where id = $2`, [status, id]);
  },

  async setWebhook(id, url, secret) {
    await pool.query(
      `update sessions set webhook_url = $1, webhook_secret = $2 where id = $3`,
      [url, secret, id]
    );
  },

  async setApiKey(id, key) {
    await pool.query(`update sessions set api_key = $1 where id = $2`, [key, id]);
  },

  async get(id) {
    const r = await pool.query(`select * from sessions where id = $1`, [id]);
    return r.rows[0] || null;
  },

  async list() {
    const r = await pool.query(`select * from sessions order by created_at desc`);
    return r.rows;
  },

  async del(id) {
    await pool.query(`delete from sessions where id = $1`, [id]);
  },

  // Teşhis için basit ping
  async ping() {
    const r = await pool.query('select now() as now');
    return r.rows[0].now;
  }
};

module.exports = { DB, pool };
