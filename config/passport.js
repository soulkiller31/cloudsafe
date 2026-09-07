const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { query } = require('../db');

const ALLOWED_EMAILS = [
  (process.env.ALLOWED_EMAIL_1 || '').toLowerCase().trim(),
  (process.env.ALLOWED_EMAIL_2 || '').toLowerCase().trim()
].filter(Boolean);

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL,
  accessType:   'offline',
  prompt:       'consent'
},
async (accessToken, refreshToken, profile, done) => {
  try {
    const email  = profile.emails[0].value.toLowerCase();
    const name   = profile.displayName;
    const avatar = profile.photos[0]?.value || '';
    const googleId = profile.id;

    // Restrict to 2 allowed accounts
    if (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(email)) {
      return done(null, false, { message: 'Access denied. This tool is private.' });
    }

    // Check if user exists
    const { rows } = await query('SELECT * FROM users WHERE google_id = $1', [googleId]);

    if (rows.length > 0) {
      // Update tokens and last login
      const { rows: updated } = await query(`
        UPDATE users SET
          access_token = $1,
          refresh_token = COALESCE($2, refresh_token),
          name = $3, avatar = $4,
          last_login = NOW()
        WHERE google_id = $5
        RETURNING *
      `, [accessToken, refreshToken || null, name, avatar, googleId]);
      return done(null, updated[0]);
    }

    // Create new user
    const { rows: newUser } = await query(`
      INSERT INTO users (google_id, email, name, avatar, access_token, refresh_token)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [googleId, email, name, avatar, accessToken, refreshToken || '']);

    const user = newUser[0];

    // Create default backup entries
    for (const type of ['photos', 'gmail', 'drive', 'contacts']) {
      await query(
        `INSERT INTO backups (user_id, type, status, auto_sync) VALUES ($1, $2, 'idle', 0)`,
        [user.id, type]
      );
    }

    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, rows[0] || false);
  } catch (err) {
    done(err, null);
  }
});
