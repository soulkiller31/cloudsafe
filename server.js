require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const path = require('path');
const morgan = require('morgan');
const cors = require('cors');
const cron = require('node-cron');

const { initDb, pool, query } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ─── Middleware ───────────────────────────────────────────────────────────────
if (isProd) app.set('trust proxy', 1);
app.use(morgan(isProd ? 'combined' : 'dev'));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions stored in PostgreSQL
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

app.use(passport.initialize());
app.use(passport.session());
require('./config/passport');

// ─── Routes ───────────────────────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const apiRoutes  = require('./routes/api');
const adminRoutes = require('./routes/admin');

app.use('/auth',  authRoutes);
app.use('/api',   apiRoutes);
app.use('/admin', adminRoutes);

// ─── Page routes ──────────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/dashboard', ensureAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('/backup/:type', ensureAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'backup.html')));

function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

// ─── Health check (Render uses this) ─────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Auto-sync cron every 30 minutes ─────────────────────────────────────────
cron.schedule('*/30 * * * *', async () => {
  try {
    const { rows: users } = await query('SELECT id, email FROM users');
    for (const user of users) {
      const { rows: autoBackups } = await query(
        'SELECT type FROM backups WHERE user_id = $1 AND auto_sync = 1', [user.id]
      );
      for (const b of autoBackups) {
        console.log(`[CRON] Auto-sync: ${b.type} for ${user.email}`);
        // Actual sync is triggered per-service; log the queue here
      }
    }
  } catch (err) {
    console.error('[CRON] Error:', err.message);
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 CloudSafe running on port ${PORT}`);
    console.log(`🔒 Admin → /admin\n`);
  });
}).catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});

module.exports = app;
