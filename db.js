// db.js — Supabase Postgres CRUD
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  max: 5,
  ssl: { rejectUnauthorized: false } // Supabase için genelde gerekli
});

const DB = {
  async upsertSession(s) {
    await pool.query(`
      insert into sessions(id,name,status,api_key,webhook_url,webhook_secret,created_at)
      values($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0))
      on conflict(id) do update set
        name=excluded.name,
        status=excluded.status,
        api_key=coalesce(excluded.api_key, sessions.api_key),
        webhook_url=coalesce(excluded.webhook_url, sessions.webhook_url),
        webhook_secret=coalesce(excluded.webhook_secret, sessions.webhook_secret)
    `, [s.id, s.name, s.status, s.api_key, s.webhook_url, s.webhook_secret, s.created_at]);
  },

  async setStatus(id, status) {
    await pool.query(`update sessions set status=$1 where id=$2`, [status, id]);
  },

  async setWebhook(id, url, secret) {
    await pool.query(`update sessions set webhook_url=$1, webhook_secret=$2 where id=$3`, [url, secret, id]);
  },

  async setApiKey(id, key) {
    await pool.query(`update sessions set api_key=$1 where id=$2`, [key, id]);
  },

  async get(id) {
    const r = await pool.query(`select * from sessions where id=$1`, [id]);
    return r.rows[0] || null;
  },

  async list() {
    const r = await pool.query(`select * from sessions order by created_at desc`);
    return r.rows;
  },

  async del(id) {
    await pool.query(`delete from sessions where id=$1`, [id]);
  }
};

module.exports = { DB, pool };
