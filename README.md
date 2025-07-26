# WHOOP Dashboard – Concussion Symptom Monitoring

A Node.js application that integrates with the WHOOP API to track athlete strain and other biometrics for **concussion symptom monitoring**, and stream the data to Foundry for analysis.

## Features

- OAuth 2.0 authentication with WHOOP
- Real-time strain monitoring with configurable alerts
- Background strain polling (continues even when user is logged out)
- Webhook support for workout, sleep, and recovery data
- Automatic data streaming to Foundry datastream
- Session management with encrypted token storage in Supabase database
- Persistent token storage that survives server restarts and deployments

## Background Strain Monitoring

The app includes a background worker that continuously monitors strain data for all authenticated users:

- Polls WHOOP API every 10 minutes for current strain data
- Sends strain data to Foundry automatically
- Continues monitoring even when users are logged out or have closed the browser
- Tokens persist in Supabase database, enabling automatic resume after server restarts

### Configuration

Set the following environment variable to enable background strain monitoring:

```bash
ENABLE_STRAIN_WORKER=true
```

## Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Set up Supabase database:**
   - Create a free account at [supabase.com](https://supabase.com)
   - Create a new project
   - Go to SQL Editor and run this command to create the tokens table:
   ```sql
   CREATE TABLE user_tokens (
     user_id TEXT PRIMARY KEY,
     encrypted_data JSONB NOT NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
   ```

3. **Create a `.env` file with your credentials:**
```bash
# WHOOP API Configuration
CLIENT_ID=your_whoop_client_id
CLIENT_SECRET=your_whoop_client_secret
WHOOP_API_HOSTNAME=https://api.prod.whoop.com

# Server Configuration
PORT=3000
CALLBACK_URL=http://localhost:3000/callback
SESSION_SECRET=your_long_random_session_secret

# Foundry Integration
FOUNDRY_STREAM_URI=your_foundry_stream_uri
FOUNDRY_TOKEN=your_foundry_token

# Supabase Configuration
SUPABASE_KEY=your_supabase_anon_key

# Worker Configuration
ENABLE_STRAIN_WORKER=true
```

4. **Run the application:**
```bash
cd Project
node app.js
```

## Usage

1. Navigate to `http://localhost:3000`
2. Click "Authenticate with WHOOP" to log in
3. Use the dashboard to view data and start strain polling
4. Background strain monitoring will continue automatically and persist across server restarts

### Logout vs Disconnect

- **Logout**: Ends the web session but preserves tokens in database for background monitoring
- **Disconnect WHOOP**: Completely revokes access and removes tokens from database

## API Endpoints

- `GET /` - Dashboard homepage
- `GET /auth/whoop` - Initiate WHOOP OAuth flow
- `GET /callback` - OAuth callback handler
- `GET /whoop-data` - Fetch user profile data
- `GET /body-stats` - Fetch body measurement data
- `GET /current-strain` - Get current strain data
- `GET /logout` - Logout (preserves background monitoring)
- `GET /disconnect` - Fully disconnect WHOOP access
- `POST /webhook` - Handle WHOOP webhooks
- `GET /health` - Health check endpoint

## Architecture

- **Main App** (`app.js`): Express server with OAuth and API routes
- **Background Worker** (`worker/strainPoller.js`): Continuous strain monitoring
- **Token Storage** (`utils/tokenStorage.js`): Encrypted token persistence in Supabase
- **WHOOP Utils** (`utils/whoop.js`): API client with automatic token refresh
- **Foundry Utils** (`utils/foundry.js`): Data streaming to Foundry

## Security

- Tokens are encrypted at rest using AES-256-GCM before storing in Supabase
- Session cookies are HTTP-only and secure in production
- Webhook signatures are validated
- Database connections use SSL encryption

## Deploying to Render (Free Tier)

The app is optimized for Render's free web-service tier, which spins down after 15 minutes of inactivity but automatically wakes up when webhooks arrive. **Token persistence in Supabase enables seamless background monitoring** without any manual intervention.

### Pre-Deployment Setup (Required)

**Important:** You must authenticate locally first to create tokens in the database that enable automatic webhook bootstrap on Render.

1. **Set up Supabase database** (see Setup section above)

2. **Run locally and authenticate:**
   ```bash
   cd Project
   node app.js
   ```

3. **Visit** `http://localhost:3000` and complete WHOOP authentication

4. **Enable strain polling** if desired (this preference is saved to the database)

5. **Verify tokens are stored:** Check your Supabase dashboard to confirm tokens are in the `user_tokens` table

### Render Deployment

1. **Fork / push** this repo to GitHub.

2. **Create a new service** at <https://dashboard.render.com> → *New* → *Web Service*.

3. **Connect the repo** and choose the `main` branch.

4. **Instance type:** *Free* (512 MB RAM).

5. **Build command:**
   ```bash
   npm install
   ```

6. **Start command:**
   ```bash
   node Project/app.js
   ```

7. **Environment variables** (Render → *Environment* tab):
   ```
   CLIENT_ID=your_whoop_client_id
   CLIENT_SECRET=your_whoop_client_secret
   CALLBACK_URL=https://<your-service>.onrender.com/callback
   FOUNDRY_STREAM_URI=your_foundry_stream_uri
   FOUNDRY_TOKEN=your_foundry_token
   SESSION_SECRET=your_long_random_session_secret
   SUPABASE_KEY=your_supabase_anon_key
   ENABLE_STRAIN_WORKER=true
   WHOOP_API_HOSTNAME=https://api.prod.whoop.com
   ```

8. **Add the callback URL** (`https://<your-service>.onrender.com/callback`) to your WHOOP developer portal.

9. Click **Deploy** – after the build finishes your app is live at `https://<your-service>.onrender.com`.

### How Free Tier Bootstrap Works

- **Spin Down:** After 15 minutes of no web traffic, Render puts the service to sleep
- **Wake Up:** WHOOP webhooks automatically wake the service 
- **Bootstrap:** On startup, the app reads tokens from Supabase and restarts strain polling for users who had it enabled
- **Seamless Monitoring:** Background strain monitoring continues without any manual intervention
- **Token Refresh:** Expired tokens are automatically refreshed and updated in the database

### Key Advantages of Supabase Token Storage

- **Persistent across deployments:** Tokens survive server restarts and code deployments
- **Automatic token refresh:** Refresh tokens are preserved and work reliably
- **No file management:** No need to commit sensitive token files to git
- **Scalable:** Database storage works across multiple server instances
- **Reliable:** Database persistence prevents token loss during Render's sleep/wake cycles

**Note:** You'll need to re-authenticate through the web UI after each deployment (sessions don't persist), but webhook processing and background strain monitoring work automatically thanks to the persistent Supabase token storage. 