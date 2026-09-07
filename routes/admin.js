const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// ─── Admin auth middleware ────────────────────────────────────────────────────
function ensureAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

// ─── GET /admin ───────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin/dashboard');
  res.redirect('/admin/login');
});

router.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin/dashboard');
  res.sendFile(require('path').join(__dirname, '..', 'public', 'admin-login.html'));
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === (process.env.ADMIN_USERNAME || 'admin') &&
      password === (process.env.ADMIN_PASSWORD || 'admin123')) {
    req.session.isAdmin = true;
    return res.json({ success: true, redirect: '/admin/dashboard' });
  }
  res.status(401).json({ success: false, error: 'Invalid credentials' });
});

router.get('/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

router.get('/dashboard', ensureAdmin, (req, res) =>
  res.sendFile(require('path').join(__dirname, '..', 'public', 'admin.html')));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN API
// ═══════════════════════════════════════════════════════════════════════════════

// Overview stats
router.get('/api/stats', ensureAdmin, async (req, res) => {
  try {
    const { rows: [{ count: totalUsers }] }   = await query('SELECT COUNT(*) FROM users');
    const { rows: [{ count: totalItems }] }   = await query('SELECT COUNT(*) FROM backup_items');
    const { rows: [{ sum: totalStorage }] }   = await query('SELECT SUM(storage_used) FROM users');
    const { rows: recentLogs } = await query('SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT 20');
    const { rows: backupsByType } = await query(`
      SELECT type, COUNT(*) as count, SUM(size_bytes) as size
      FROM backup_items GROUP BY type`);

    res.json({
      totalUsers:       parseInt(totalUsers),
      totalBackupItems: parseInt(totalItems),
      totalStorageUsed: parseInt(totalStorage || 0),
      backupsByType,
      recentLogs
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// All users
router.get('/api/users', ensureAdmin, async (req, res) => {
  try {
    const { rows: users } = await query(
      'SELECT id,email,name,avatar,storage_used,storage_limit,created_at,last_login FROM users ORDER BY created_at DESC'
    );
    const result = await Promise.all(users.map(async u => {
      const { rows: backups }           = await query('SELECT * FROM backups WHERE user_id=$1', [u.id]);
      const { rows: [{ count }] }       = await query('SELECT COUNT(*) FROM backup_items WHERE user_id=$1', [u.id]);
      return { ...u, backups, totalItems: parseInt(count) };
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Single user detail
router.get('/api/users/:id', ensureAdmin, async (req, res) => {
  try {
    const { rows: [user] } = await query(
      'SELECT id,email,name,avatar,storage_used,storage_limit,created_at,last_login FROM users WHERE id=$1',
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'Not found' });
    const { rows: backups } = await query('SELECT * FROM backups WHERE user_id=$1', [user.id]);
    const { rows: logs }    = await query(
      'SELECT * FROM sync_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [user.id]);
    res.json({ user, backups, logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// User's backed-up items
router.get('/api/users/:id/items/:type', ensureAdmin, async (req, res) => {
  try {
    const { id, type } = req.params;
    const page   = parseInt(req.query.page) || 1;
    const limit  = 50;
    const offset = (page - 1) * limit;
    const { rows: [backup] } = await query('SELECT * FROM backups WHERE user_id=$1 AND type=$2', [id, type]);
    if (!backup) return res.json({ items: [], total: 0 });
    const { rows: items }        = await query(
      'SELECT * FROM backup_items WHERE backup_id=$1 ORDER BY backed_up_at DESC LIMIT $2 OFFSET $3',
      [backup.id, limit, offset]
    );
    const { rows: [{ count }] } = await query('SELECT COUNT(*) FROM backup_items WHERE backup_id=$1', [backup.id]);
    res.json({ items, total: parseInt(count), page, backup });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete user
router.delete('/api/users/:id', ensureAdmin, async (req, res) => {
  try {
    const { rows: [user] } = await query('SELECT id,email FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Not found' });
    // CASCADE handles backup_items and backups
    await query('DELETE FROM sync_logs WHERE user_id=$1', [user.id]);
    await query('DELETE FROM users WHERE id=$1', [user.id]);
    res.json({ success: true, message: `Deleted ${user.email}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update storage limit
router.patch('/api/users/:id/storage', ensureAdmin, async (req, res) => {
  try {
    const limitBytes = Math.round(parseFloat(req.body.limitGB) * 1073741824);
    await query('UPDATE users SET storage_limit=$1 WHERE id=$2', [limitBytes, req.params.id]);
    res.json({ success: true, newLimit: limitBytes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// All logs (with user info)
router.get('/api/logs', ensureAdmin, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT l.*, u.email, u.name FROM sync_logs l
      LEFT JOIN users u ON l.user_id = u.id
      ORDER BY l.created_at DESC LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Force backup trigger
router.post('/api/users/:id/force-backup', ensureAdmin, async (req, res) => {
  try {
    const { type } = req.body;
    await query("UPDATE backups SET status='pending' WHERE user_id=$1 AND type=$2", [req.params.id, type]);
    await query(
      'INSERT INTO sync_logs (user_id,type,action,status,message) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, type, 'admin_force_backup', 'triggered', `Admin triggered ${type} backup`]
    );
    res.json({ success: true, message: `${type} backup triggered` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
