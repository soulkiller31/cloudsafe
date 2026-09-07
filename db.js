const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ─── Run a query ──────────────────────────────────────────────────────────────
async function query(text, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

// ─── Create all tables ────────────────────────────────────────────────────────
async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      avatar TEXT,
      access_token TEXT,
      refresh_token TEXT,
      storage_used BIGINT DEFAULT 0,
      storage_limit BIGINT DEFAULT 32212254720,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_login TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS backups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'idle',
      total_items INTEGER DEFAULT 0,
      backed_up_items INTEGER DEFAULT 0,
      size_bytes BIGINT DEFAULT 0,
      last_synced TIMESTAMPTZ,
      auto_sync INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS backup_items (
      id SERIAL PRIMARY KEY,
      backup_id INTEGER NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      item_id TEXT,
      name TEXT,
      size_bytes BIGINT DEFAULT 0,
      metadata TEXT,
      local_path TEXT,
      backed_up_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sync_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      action TEXT,
      status TEXT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('[DB] Tables ready');
}

module.exports = { query, initDb, pool };
