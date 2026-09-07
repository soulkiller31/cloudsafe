# CloudSafe — Setup & Deployment Guide

## Local Development

### 1. Install dependencies
```bash
npm install
```

### 2. Set up PostgreSQL locally
You need a local Postgres database. Easiest options:
- Install PostgreSQL: https://www.postgresql.org/download/
- Or use a free cloud DB for dev: https://neon.tech (free) or https://supabase.com (free)

### 3. Create your `.env` file
```bash
copy .env.example .env
```
Fill in all values — see `.env.example` for details.

### 4. Set up Google Cloud Console
1. Go to https://console.cloud.google.com
2. Create a project → **APIs & Services** → **Enable APIs**:
   - Google Photos Library API
   - Gmail API
   - Google Drive API
   - People API
3. **OAuth consent screen** → External → add both Gmail addresses as Test Users
4. **Credentials** → Create → OAuth 2.0 Client ID → Web application
   - Redirect URI: `http://localhost:3000/auth/google/callback`
5. Copy Client ID and Client Secret into your `.env`

### 5. Run locally
```bash
npm start
```
Visit http://localhost:3000

---

## Deploy to Render (Recommended)

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/cloudsafe.git
git push -u origin main
```

### Step 2 — Create Render account
Go to https://render.com and sign up (free).

### Step 3 — Deploy using render.yaml (Blueprint)
1. In Render dashboard → **New** → **Blueprint**
2. Connect your GitHub repo
3. Render will read `render.yaml` and auto-create:
   - A **Web Service** (your Node.js app)
   - A **PostgreSQL database** (free, persists your data)

### Step 4 — Set environment variables in Render
In your Web Service → **Environment** tab, add:

| Key | Value |
|-----|-------|
| `GOOGLE_CLIENT_ID` | from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | from Google Cloud Console |
| `GOOGLE_CALLBACK_URL` | `https://your-app-name.onrender.com/auth/google/callback` |
| `ADMIN_USERNAME` | your chosen admin username |
| `ADMIN_PASSWORD` | your chosen admin password |
| `ALLOWED_EMAIL_1` | your Gmail address |
| `ALLOWED_EMAIL_2` | second Gmail address |

> `DATABASE_URL` and `SESSION_SECRET` are set automatically by Render.

### Step 5 — Update Google OAuth redirect URI
In Google Cloud Console → Credentials → your OAuth Client:
- Add to Authorized redirect URIs:
  `https://your-app-name.onrender.com/auth/google/callback`

### Step 6 — Done!
Your app is live at `https://your-app-name.onrender.com`

---

## URLs

| URL | Description |
|-----|-------------|
| `/` | Landing page |
| `/dashboard` | User backup dashboard |
| `/admin` | Admin panel login |
| `/health` | Health check (used by Render) |

## Admin Panel
- URL: `https://your-app.onrender.com/admin`
- Login with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from your env vars

## Notes
- Render free tier spins down after 15 min of inactivity (cold start ~30s)
- To avoid spin-down, upgrade to Render's $7/month Starter plan
- Database auto-persists — your backup data survives all redeploys
