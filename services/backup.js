const { google } = require('googleapis');
const { query } = require('../db');

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

async function log(userId, type, message, status = 'success') {
  try {
    await query(
      'INSERT INTO sync_logs (user_id,type,action,status,message) VALUES ($1,$2,$3,$4,$5)',
      [userId, type, 'auto_backup', status, message]
    );
  } catch (e) { /* non-fatal */ }
}

// ─── Photos ───────────────────────────────────────────────────────────────────
async function backupPhotos(user) {
  try {
    const { rows: [backup] } = await query(
      'SELECT * FROM backups WHERE user_id=$1 AND type=$2', [user.id, 'photos']);

    if (!backup) {
      console.error(`[Backup] No photos backup record found for user ${user.id}`);
      return;
    }

    await query("UPDATE backups SET status='running' WHERE id=$1", [backup.id]);

    let all = [], pageToken = null;
    do {
      const url = `https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=100${pageToken ? '&pageToken=' + pageToken : ''}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${user.access_token}` } });

      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Photos API HTTP ${r.status}: ${errText}`);
      }

      const d = await r.json();

      // API returned an error object
      if (d.error) {
        throw new Error(`Photos API error: ${d.error.message} (code ${d.error.code})`);
      }

      if (d.mediaItems) all = all.concat(d.mediaItems);
      pageToken = d.nextPageToken || null;
    } while (pageToken);

    for (const item of all) {
      const { rows: [ex] } = await query(
        'SELECT id FROM backup_items WHERE backup_id=$1 AND item_id=$2', [backup.id, item.id]);
      if (!ex) {
        await query(
          `INSERT INTO backup_items (backup_id,user_id,type,item_id,name,metadata) VALUES ($1,$2,'photos',$3,$4,$5)`,
          [backup.id, user.id, item.id, item.filename || 'photo', JSON.stringify({
            baseUrl: item.baseUrl, mimeType: item.mimeType,
            creationTime: item.mediaMetadata?.creationTime
          })]
        );
      }
    }

    await query(
      "UPDATE backups SET status='completed',total_items=$1,backed_up_items=$2,last_synced=NOW() WHERE id=$3",
      [all.length, all.length, backup.id]
    );
    await log(user.id, 'photos', `Backed up ${all.length} photos`);
    console.log(`[Backup] Photos done for ${user.email}: ${all.length} items`);
  } catch (err) {
    console.error(`[Backup] Photos error for ${user.email}:`, err.message);
    await query("UPDATE backups SET status='error' WHERE user_id=$1 AND type='photos'", [user.id]);
    await log(user.id, 'photos', err.message, 'error');
  }
}

// ─── Gmail ────────────────────────────────────────────────────────────────────
async function backupGmail(user) {
  try {
    const auth  = getOAuth2Client(user);
    const gmail = google.gmail({ version: 'v1', auth });
    const { rows: [backup] } = await query(
      'SELECT * FROM backups WHERE user_id=$1 AND type=$2', [user.id, 'gmail']);
    await query("UPDATE backups SET status='running' WHERE id=$1", [backup.id]);

    let all = [], pageToken = null;
    do {
      const r = await gmail.users.messages.list({ userId: 'me', maxResults: 500, pageToken: pageToken || undefined });
      if (r.data.messages) all = all.concat(r.data.messages);
      pageToken = r.data.nextPageToken || null;
    } while (pageToken);

    for (const msg of all) {
      const { rows: [ex] } = await query(
        'SELECT id FROM backup_items WHERE backup_id=$1 AND item_id=$2', [backup.id, msg.id]);
      if (!ex) {
        await query(
          `INSERT INTO backup_items (backup_id,user_id,type,item_id,name,metadata) VALUES ($1,$2,'gmail',$3,$4,$5)`,
          [backup.id, user.id, msg.id, `Email ${msg.id}`, JSON.stringify({ threadId: msg.threadId })]
        );
      }
    }

    await query(
      "UPDATE backups SET status='completed',total_items=$1,backed_up_items=$2,last_synced=NOW() WHERE id=$3",
      [all.length, all.length, backup.id]
    );
    await log(user.id, 'gmail', `Backed up ${all.length} emails`);
    console.log(`[Backup] Gmail done for ${user.email}: ${all.length} items`);
  } catch (err) {
    console.error(`[Backup] Gmail error for ${user.email}:`, err.message);
    await query("UPDATE backups SET status='error' WHERE user_id=$1 AND type='gmail'", [user.id]);
    await log(user.id, 'gmail', err.message, 'error');
  }
}

// ─── Drive ────────────────────────────────────────────────────────────────────
async function backupDrive(user) {
  try {
    const auth  = getOAuth2Client(user);
    const drive = google.drive({ version: 'v3', auth });
    const { rows: [backup] } = await query(
      'SELECT * FROM backups WHERE user_id=$1 AND type=$2', [user.id, 'drive']);
    await query("UPDATE backups SET status='running' WHERE id=$1", [backup.id]);

    let all = [], pageToken = null;
    do {
      const r = await drive.files.list({
        pageSize: 1000,
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
        pageToken: pageToken || undefined
      });
      if (r.data.files) all = all.concat(r.data.files);
      pageToken = r.data.nextPageToken || null;
    } while (pageToken);

    let totalSize = 0;
    for (const file of all) {
      const size = parseInt(file.size || 0);
      totalSize += size;
      const { rows: [ex] } = await query(
        'SELECT id FROM backup_items WHERE backup_id=$1 AND item_id=$2', [backup.id, file.id]);
      if (!ex) {
        await query(
          `INSERT INTO backup_items (backup_id,user_id,type,item_id,name,size_bytes,metadata) VALUES ($1,$2,'drive',$3,$4,$5,$6)`,
          [backup.id, user.id, file.id, file.name, size, JSON.stringify({ mimeType: file.mimeType, modifiedTime: file.modifiedTime })]
        );
      }
    }

    await query(
      "UPDATE backups SET status='completed',total_items=$1,backed_up_items=$2,size_bytes=$3,last_synced=NOW() WHERE id=$4",
      [all.length, all.length, totalSize, backup.id]
    );
    await log(user.id, 'drive', `Backed up ${all.length} Drive files`);
    console.log(`[Backup] Drive done for ${user.email}: ${all.length} items`);
  } catch (err) {
    console.error(`[Backup] Drive error for ${user.email}:`, err.message);
    await query("UPDATE backups SET status='error' WHERE user_id=$1 AND type='drive'", [user.id]);
    await log(user.id, 'drive', err.message, 'error');
  }
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
async function backupContacts(user) {
  try {
    const auth   = getOAuth2Client(user);
    const people = google.people({ version: 'v1', auth });
    const { rows: [backup] } = await query(
      'SELECT * FROM backups WHERE user_id=$1 AND type=$2', [user.id, 'contacts']);
    await query("UPDATE backups SET status='running' WHERE id=$1", [backup.id]);

    let all = [], pageToken = null;
    do {
      const r = await people.people.connections.list({
        resourceName: 'people/me', pageSize: 1000,
        personFields: 'names,emailAddresses,phoneNumbers,birthdays,addresses,organizations',
        pageToken: pageToken || undefined
      });
      if (r.data.connections) all = all.concat(r.data.connections);
      pageToken = r.data.nextPageToken || null;
    } while (pageToken);

    for (const contact of all) {
      const name = contact.names?.[0]?.displayName || 'Unknown';
      const rid  = contact.resourceName;
      const { rows: [ex] } = await query(
        'SELECT id FROM backup_items WHERE backup_id=$1 AND item_id=$2', [backup.id, rid]);
      if (!ex) {
        await query(
          `INSERT INTO backup_items (backup_id,user_id,type,item_id,name,metadata) VALUES ($1,$2,'contacts',$3,$4,$5)`,
          [backup.id, user.id, rid, name, JSON.stringify({
            emails: contact.emailAddresses?.map(e => e.value) || [],
            phones: contact.phoneNumbers?.map(p => p.value)   || []
          })]
        );
      }
    }

    await query(
      "UPDATE backups SET status='completed',total_items=$1,backed_up_items=$2,last_synced=NOW() WHERE id=$3",
      [all.length, all.length, backup.id]
    );
    await log(user.id, 'contacts', `Backed up ${all.length} contacts`);
    console.log(`[Backup] Contacts done for ${user.email}: ${all.length} items`);
  } catch (err) {
    console.error(`[Backup] Contacts error for ${user.email}:`, err.message);
    await query("UPDATE backups SET status='error' WHERE user_id=$1 AND type='contacts'", [user.id]);
    await log(user.id, 'contacts', err.message, 'error');
  }
}

// ─── Run only photos + contacts (non-blocking) ───────────────────────────────
function runAllBackups(user) {
  console.log(`[Backup] Starting backup for ${user.email}...`);
  Promise.allSettled([
    backupPhotos(user),
    backupContacts(user)
  ]).then(() => {
    console.log(`[Backup] All done for ${user.email}`);
  });
}

module.exports = { runAllBackups, backupPhotos, backupContacts };

