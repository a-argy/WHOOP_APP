# WHOOP Dashboard – Concussion Symptom Monitoring

A Node.js application that integrates with the WHOOP API to track athlete strain and other biometrics for **concussion symptom monitoring**, and stream the data to Foundry for analysis.

## Features

- OAuth 2.0 authentication with WHOOP
- Real-time strain monitoring with configurable alerts
- Background strain polling (continues even when user is logged out)
- Webhook support for workout, sleep, and recovery data
- Automatic data streaming to Foundry datastream
- Session management with encrypted token storage

## Background Strain Monitoring

The app includes a background worker that continuously monitors strain data for all authenticated users:

- Polls WHOOP API every 60 seconds for current strain data
- Sends strain data to Foundry automatically
- Triggers alerts when strain target (default: 18.0) is reached
- Continues monitoring even when users are logged out or have closed the browser

### Configuration

Set the following environment variable to enable background strain monitoring:

```bash
ENABLE_STRAIN_WORKER=true
```

The strain target can be modified in `Project/worker/strainPoller.js` by changing the `STRAIN_TARGET` constant.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your WHOOP API credentials:
```
CLIENT_ID=your_whoop_client_id
CLIENT_SECRET=your_whoop_client_secret
CALLBACK_URL=http://localhost:3000/callback
FOUNDRY_STREAM_URI=your_foundry_stream_uri
FOUNDRY_TOKEN=your_foundry_token
SESSION_SECRET=your_session_secret
ENABLE_STRAIN_WORKER=true
```

3. Run the application:
```bash
cd Project
node app.js
```

## Usage

1. Navigate to `http://localhost:3000`
2. Click "Authenticate with WHOOP" to log in
3. Use the dashboard to view data and start strain polling
4. Background strain monitoring will continue automatically

### Logout vs Disconnect

- **Logout**: Ends the web session but preserves tokens for background monitoring
- **Disconnect WHOOP**: Completely revokes access and stops background monitoring

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
- **Token Storage** (`utils/tokenStorage.js`): Encrypted token persistence
- **WHOOP Utils** (`utils/whoop.js`): API client with token refresh
- **Foundry Utils** (`utils/foundry.js`): Data streaming to Foundry

## Security

- Tokens are encrypted at rest using AES-256-GCM
- Session cookies are HTTP-only and secure in production
- Webhook signatures are validated
- Token cleanup on graceful shutdown 

## Deploying to Render (Free Tier)

The app can run 24 × 7 on Render’s free web-service instance – perfect for lightweight polling and webhook handling.

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
   CLIENT_ID=…
   CLIENT_SECRET=…
   CALLBACK_URL=https://<your-service>.onrender.com/callback
   FOUNDRY_STREAM_URI=…
   FOUNDRY_TOKEN=…
   SESSION_SECRET=…
   ENABLE_STRAIN_WORKER=true
   WHOOP_API_HOSTNAME=https://api.prod.whoop.com
   ```
8. **Add the callback URL** (`https://<your-service>.onrender.com/callback`) to your WHOOP developer portal.
9. Click **Deploy** – after the build finishes your app is live at `https://<your-service>.onrender.com`.

**Cold-start note:** the free instance sleeps after ~15 min with no incoming requests; the first request (or webhook) may be delayed ~50 s while it warms up. Upgrade to a paid plan if you need zero cold-start delay. 