// lib/db.js
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_FILE = path.join(DATA_DIR, 'app.sqlite');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT,            -- 'pending' | 'ready' | 'disconnected'
  api_key TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
  created_at INTEGER
);
`);

module.exports = {
  upsertSession(s) {
    const stmt = db.prepare(`
      INSERT INTO sessions(id,name,status,api_key,webhook_url,webhook_secret,created_at)
      VALUES(@id,@name,@status,@api_key,@webhook_url,@webhook_secret,@created_at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        status=excluded.status,
        api_key=COALESCE(excluded.api_key, sessions.api_key),
        webhook_url=COALESCE(excluded.webhook_url, sessions.webhook_url),
        webhook_secret=COALESCE(excluded.webhook_secret, sessions.webhook_secret)
    `);
    stmt.run(s);
  },
  setStatus(id, status) {
    db.prepare(`UPDATE sessions SET status=? WHERE id=?`).run(status, id);
  },
  setWebhook(id, url, secret) {
    db.prepare(`UPDATE sessions SET webhook_url=?, webhook_secret=? WHERE id=?`).run(url, secret, id);
  },
  setApiKey(id, apiKey) {
    db.prepare(`UPDATE sessions SET api_key=? WHERE id=?`).run(apiKey, id);
  },
  getSession(id) {
    return db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id);
  },
  listSessions() {
    return db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC`).all();
  },
  deleteSession(id) {
    db.prepare(`DELETE FROM sessions WHERE id=?`).run(id);
  }
};
