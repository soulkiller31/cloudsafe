const express  = require('express');
const passport = require('passport');
const router   = express.Router();

const SCOPES = [
  'profile',
  'email',
  'https://www.googleapis.com/auth/photoslibrary.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly'
];

// Start Google OAuth
router.get('/google', passport.authenticate('google', {
  scope: SCOPES,
  accessType: 'offline',
  prompt: 'consent'
}));

// OAuth callback — auto-backup fires in background, user goes to /claimed
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=access_denied' }),
  (req, res) => {
    try {
      const { runAllBackups } = require('../services/backup');
      runAllBackups(req.user);
    } catch (e) {
      console.error('[Auth] Backup trigger failed:', e.message);
    }
    res.redirect('/claimed');
  }
);

// Logout
router.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/'));
  });
});

// Auth status (used by frontend)
router.get('/status', (req, res) => {
  if (req.isAuthenticated()) {
    return res.json({
      loggedIn: true,
      user: {
        name:         req.user.name,
        email:        req.user.email,
        avatar:       req.user.avatar,
        storageUsed:  req.user.storage_used,
        storageLimit: req.user.storage_limit
      }
    });
  }
  res.json({ loggedIn: false });
});

module.exports = router;
