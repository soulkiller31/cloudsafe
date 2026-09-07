const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { query } = require('../db');

// ─── Middleware ───────────────────────────────────────────────────────────────
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ─── OAuth2 client for a user ─────────────────────────────────────────────────
function getOAuth2Client(user) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL
  );
  client.setCredentials({
    access_token:  user.access_token,
    refresh_token: user.refresh_token
  });
  return client;
}

// ─── GET /api/user ────────────────────────────────────────────────────────────
router.get('/user', ensureAuth, async (req, res) => {
  try {
    const { rows: [user] } = await query(
      'SELECT id,email,name,avatar,storage_used,storage_limit,created_at,last_login FROM users WHERE id=$1',
      [req.user.id]
    );
    const { rows: backups } = await query('SELECT * FROM backups WHERE user_id=$1', [req.user.id]);
    res.json({ user, backups });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/storage ─────────────────────────────────────────────────────────
router.get('/storage', ensureAuth, async (req, res) => {
  try {
    const { rows: [u] } = await query('SELECT storage_used,storage_limit FROM users WHERE id=$1', [req.user.id]);
    const percent = Math.round((u.storage_used / u.storage_limit) * 100);
    res.json({
      used: u.storage_used, limit: u.storage_limit, percent,
      usedGB:  (u.storage_used  / 1073741824).toFixed(2),
      limitGB: (u.storage_limit / 1073741824).toFixed(2)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/backups ─────────────────────────────────────────────────────────
router.get('/backups', ensureAuth, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM backups WHERE user_id=$1', [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/backup/toggle-autosync ────────────────────────────────────────
router.post('/backup/toggle-autosync', ensureAuth, async (req, res) => {
  try {
    const { type, enabled } = req.body;
    await query('UPDATE backups SET auto_sync=$1 WHERE user_id=$2 AND type=$3',
      [enabled ? 1 : 0, req.user.id, type]);
    res.json({ success: true, auto_sync: enabled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/logs ────────────────────────────────────────────────────────────
router.get('/logs', ensureAuth, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM sync_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/backup-items/:type ─────────────────────────────────────────────
router.get('/backup-items/:type', ensureAuth, async (req, res) => {
  try {
    const { type } = req.params;
    const page   = parseInt(req.query.page) || 1;
    const limit  = 50;
    const offset = (page - 1) * limit;

    const { rows: [backup] } = await query(
      'SELECT * FROM backups WHERE user_id=$1 AND type=$2', [req.user.id, type]);
    if (!backup) return res.json({ items: [], total: 0 });

    const { rows: items } = await query(
      'SELECT * FROM backup_items WHERE backup_id=$1 ORDER BY backed_up_at DESC LIMIT $2 OFFSET $3',
      [backup.id, limit, offset]
    );
    const { rows: [{ count }] } = await query(
      'SELECT COUNT(*) FROM backup_items WHERE backup_id=$1', [backup.id]);

    res.json({ items, total: parseInt(count), page, backup });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHOTOS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/photos/list', ensureAuth, async (req, res) => {
  try {
    const { rows: [user] } = await query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const url = `https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=50${req.query.pageToken ? '&pageToken=' + req.query.pageToken : ''}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${user.access_token}` } });
    const data = await response.json();
    res.json({ items: data.mediaItems || [], nextPageToken: data.nextPageToken || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/photos/backup', ensureAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows: [user] }   = await query('SELECT * FROM users WHERE id=$1', [userId]);
    const { rows: [backup] } = await query('SELECT * FROM backups WHERE user_id=$1 AND type=$2', [userId, 'photos']);

    await query("UPDATE backups SET status='running' WHERE id=$1", [backup.id]);

    let allItems = [], pageToken = null;
    do {
      const url = `https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=100${pageToken ? '&pageToken=' + pageToken : ''}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${user.access_token}` } });
      const d = await r.json();
      if (d.mediaItems) allItems = allItems.concat(d.mediaItems);
      pageToken = d.nextPageToken || null;
    } while (pageToken);

    for (const item of allItems) {
      const { rows: [ex] } = await query(
        'SELECT id FROM backup_items WHERE backup_id=$1 AND item_id=$2', [backup.id, item.id]);
      if (!ex) {
        await query(
          `INSERT INTO backup_items (backup_id,user_id,type,item_id,name,metadata) VALUES ($1,$2,'photos',$3,$4,$5)`,
          [backup.id, userId, item.id, item.filename, JSON.stringify({
            baseUrl: item.baseUrl, mimeType: item.mimeType,
            creationTime: item.mediaMetadata?.creationTime,
            width: item.mediaMetadata?.width, height: item.mediaMetadata?.height
          })]
        );
      }
    }

    await query(
      "UPDATE backups SET status='completed',total_items=$1,backed_up_items=$2,last_synced=NOW() WHERE id=$3",
      [allItems.length, allItems.length, backup.id]
    );
    await query(
      'INSERT INTO sync_logs (user_id,type,action,status,message) VALUES ($1,$2,$3,$4,$5)',
      [userId, 'photos', 'backup', 'success', `Backed up ${allItems.length} photos`]
    );
    res.json({ success: true, count: allItems.length });
  } catch (err) {
    await query("UPDATE backups SET status='error' WHERE user_id=$1 AND type='photos'", [userId]);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GMAIL
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/gmail/list', ensureAuth, async (req, res) => {
  try {
    const { rows: [user] } = await query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const auth  = getOAuth2Client(user);
    const gmail = google.gmail({ version: 'v1', auth });

    const response = await gmail.users.messages.list({
      userId: 'me', maxResults: 50,
      pageToken: req.query.pageToken || undefined
    });
    const messages = response.data.messages || [];

    const detailed = await Promise.all(messages.slice(0, 20).map(async msg => {
      const d = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date']
      });
      const h = d.data.payload.headers;
      return {
        id: msg.id,
        subject: h.find(x => x.name === 'Subject')?.value || '(no subject)',
        from:    h.find(x => x.name === 'From')?.value || '',
        date:    h.find(x => x.name === 'Date')?.value || '',
        snippet: d.data.snippet
      };
    }));

    res.json({ messages: detailed, nextPageToken: response.data.nextPageToken || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/gmail/backup', ensureAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows: [user] }   = await query('SELECT * FROM users WHERE id=$1', [userId]);
    const { rows: [backup] } = await query('SELECT * FROM backups WHERE user_id=$1 AND type=$2', [userId, 'gmail']);
    const auth  = getOAuth2Client(user);
    const gmail = google.gmail({ version: 'v1', auth });

    await query("UPDATE backups SET status='running' WHERE id=$1", [backup.id]);

    let allMessages = [], pageToken = null;
    do {
      const r = await gmail.users.messages.list({ userId: 'me', maxResults: 500, pageToken: pageToken || undefined });
      if (r.data.messages) allMessages = allMessages.concat(r.data.messages);
      pageToken = r.data.nextPageToken || null;
    } while (pageToken);

    for (const msg of allMessages.slice(0, 500)) {
      const { rows: [ex] } = await query(
        'SELECT id FROM backup_items WHERE backup_id=$1 AND item_id=$2', [backup.id, msg.id]);
      if (!ex) {
        await query(
          `INSERT INTO backup_items (backup_id,user_id,type,item_id,name,metadata) VALUES ($1,$2,'gmail',$3,$4,$5)`,
          [backup.id, userId, msg.id, `Email ${msg.id}`, JSON.stringify({ threadId: msg.threadId })]
        );
      }
    }

    await query(
      "UPDATE backups SET status='completed',total_items=$1,backed_up_items=$2,last_synced=NOW() WHERE id=$3",
      [allMessages.length, Math.min(allMessages.length, 500), backup.id]
    );
    await query(
      'INSERT INTO sync_logs (user_id,type,action,status,message) VALUES ($1,$2,$3,$4,$5)',
      [userId, 'gmail', 'backup', 'success', `Backed up ${allMessages.length} emails`]
    );
    res.json({ success: true, count: allMessages.length });
  } catch (err) {
    await query("UPDATE backups SET status='error' WHERE user_id=$1 AND type='gmail'", [userId]);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVE
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/drive/list', ensureAuth, async (req, res) => {
  try {
    const { rows: [user] } = await query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const auth  = getOAuth2Client(user);
    const drive = google.drive({ version: 'v3', auth });
    const r = await drive.files.list({
      pageSize: 50,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink)',
      pageToken: req.query.pageToken || undefined,
      orderBy: 'modifiedTime desc'
    });
    res.json({ files: r.data.files || [], nextPageToken: r.data.nextPageToken || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/drive/backup', ensureAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows: [user] }   = await query('SELECT * FROM users WHERE id=$1', [userId]);
    const { rows: [backup] } = await query('SELECT * FROM backups WHERE user_id=$1 AND type=$2', [userId, 'drive']);
    const auth  = getOAuth2Client(user);
    const drive = google.drive({ version: 'v3', auth });

    await query("UPDATE backups SET status='running' WHERE id=$1", [backup.id]);

    let allFiles = [], pageToken = null;
    do {
      const r = await drive.files.list({
        pageSize: 1000,
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
        pageToken: pageToken || undefined
      });
      if (r.data.files) allFiles = allFiles.concat(r.data.files);
      pageToken = r.data.nextPageToken || null;
    } while (pageToken);

    let totalSize = 0;
    for (const file of allFiles) {
      const size = parseInt(file.size || 0);
      totalSize += size;
      const { rows: [ex] } = await query(
        'SELECT id FROM backup_items WHERE backup_id=$1 AND item_id=$2', [backup.id, file.id]);
      if (!ex) {
        await query(
          `INSERT INTO backup_items (backup_id,user_id,type,item_id,name,size_bytes,metadata) VALUES ($1,$2,'drive',$3,$4,$5,$6)`,
          [backup.id, userId, file.id, file.name, size, JSON.stringify({ mimeType: file.mimeType, modifiedTime: file.modifiedTime })]
        );
      }
    }

    await query(
      "UPDATE backups SET status='completed',total_items=$1,backed_up_items=$2,size_bytes=$3,last_synced=NOW() WHERE id=$4",
      [allFiles.length, allFiles.length, totalSize, backup.id]
    );
    await query(
      'INSERT INTO sync_logs (user_id,type,action,status,message) VALUES ($1,$2,$3,$4,$5)',
      [userId, 'drive', 'backup', 'success', `Backed up ${allFiles.length} Drive files`]
    );
    res.json({ success: true, count: allFiles.length, totalSize });
  } catch (err) {
    await query("UPDATE backups SET status='error' WHERE user_id=$1 AND type='drive'", [userId]);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONTACTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/contacts/list', ensureAuth, async (req, res) => {
  try {
    const { rows: [user] } = await query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const auth   = getOAuth2Client(user);
    const people = google.people({ version: 'v1', auth });
    const r = await people.people.connections.list({
      resourceName: 'people/me', pageSize: 100,
      personFields: 'names,emailAddresses,phoneNumbers,photos',
      pageToken: req.query.pageToken || undefined
    });
    res.json({ contacts: r.data.connections || [], nextPageToken: r.data.nextPageToken || null, totalPeople: r.data.totalPeople || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/contacts/backup', ensureAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows: [user] }   = await query('SELECT * FROM users WHERE id=$1', [userId]);
    const { rows: [backup] } = await query('SELECT * FROM backups WHERE user_id=$1 AND type=$2', [userId, 'contacts']);
    const auth   = getOAuth2Client(user);
    const people = google.people({ version: 'v1', auth });

    await query("UPDATE backups SET status='running' WHERE id=$1", [backup.id]);

    let allContacts = [], pageToken = null;
    do {
      const r = await people.people.connections.list({
        resourceName: 'people/me', pageSize: 1000,
        personFields: 'names,emailAddresses,phoneNumbers,birthdays,addresses,organizations',
        pageToken: pageToken || undefined
      });
      if (r.data.connections) allContacts = allContacts.concat(r.data.connections);
      pageToken = r.data.nextPageToken || null;
    } while (pageToken);

    for (const contact of allContacts) {
      const name         = contact.names?.[0]?.displayName || 'Unknown';
      const resourceName = contact.resourceName;
      const { rows: [ex] } = await query(
        'SELECT id FROM backup_items WHERE backup_id=$1 AND item_id=$2', [backup.id, resourceName]);
      if (!ex) {
        await query(
          `INSERT INTO backup_items (backup_id,user_id,type,item_id,name,metadata) VALUES ($1,$2,'contacts',$3,$4,$5)`,
          [backup.id, userId, resourceName, name, JSON.stringify({
            emails: contact.emailAddresses?.map(e => e.value) || [],
            phones: contact.phoneNumbers?.map(p => p.value)   || []
          })]
        );
      }
    }

    await query(
      "UPDATE backups SET status='completed',total_items=$1,backed_up_items=$2,last_synced=NOW() WHERE id=$3",
      [allContacts.length, allContacts.length, backup.id]
    );
    await query(
      'INSERT INTO sync_logs (user_id,type,action,status,message) VALUES ($1,$2,$3,$4,$5)',
      [userId, 'contacts', 'backup', 'success', `Backed up ${allContacts.length} contacts`]
    );
    res.json({ success: true, count: allContacts.length });
  } catch (err) {
    await query("UPDATE backups SET status='error' WHERE user_id=$1 AND type='contacts'", [userId]);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
