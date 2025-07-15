# WHOOP Dashboard App

A Node.js application that integrates with the WHOOP API to track fitness data, handle webhooks, and provide a web dashboard for monitoring workouts, sleep, and recovery metrics.

## Features

- **OAuth 2.0 Authentication** with WHOOP API
- **Persistent Sessions** using file-based storage
- **Real-time Webhooks** for workout, sleep, and recovery data
- **Token Management** with automatic refresh
- **Web Dashboard** for data visualization
- **Strain Monitoring** with real-time polling
- **Foundry Integration** for data forwarding

## Quick Start

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd WHOOP_APP
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your WHOOP API credentials:
   - `CLIENT_ID`: Your WHOOP Developer App Client ID
   - `CLIENT_SECRET`: Your WHOOP Developer App Client Secret
   - `CALLBACK_URL`: OAuth callback URL (default: `http://localhost:3000/callback`)

4. **Run the application**
   ```bash
   node Project/app.js
   ```

5. **Access the dashboard**
   Open `http://localhost:3000` in your browser

## Setup Instructions

### 1. WHOOP Developer Account

1. Create a developer account at [WHOOP Developer Portal](https://developer.whoop.com/)
2. Create a new application
3. Note your Client ID and Client Secret
4. Set the redirect URI to `http://localhost:3000/callback`

### 2. Environment Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Required
CLIENT_ID=your_whoop_client_id_here
CLIENT_SECRET=your_whoop_client_secret_here

# Optional
CALLBACK_URL=http://localhost:3000/callback
SESSION_SECRET=your_random_32_character_secret_here
PORT=3000
NODE_ENV=development

# Foundry Integration (optional)
FOUNDRY_API_URL=https://your-foundry-instance.com
FOUNDRY_API_TOKEN=your_foundry_token
```

### 3. Webhook Configuration

To receive real-time updates from WHOOP:

1. In your WHOOP developer app, set the webhook URL to your public endpoint
2. The app handles these webhook events:
   - `workout.updated` / `workout.deleted`
   - `sleep.updated` / `sleep.deleted`
   - `recovery.updated` / `recovery.deleted`

## Architecture

### Session Management
- **File-based sessions** persist across server restarts
- **Secure token storage** separate from session data
- **Automatic token refresh** handles expired credentials

### Data Storage
```
Project/
├── data/
│   ├── tokens.json     # OAuth tokens (gitignored)
│   └── .gitkeep
├── sessions/           # Session files (gitignored)
│   └── .gitkeep
└── utils/
    ├── tokenStorage.js # Token management
    ├── oauth.js        # OAuth handling
    ├── whoop.js        # WHOOP API calls
    └── ...
```

### API Endpoints

- `GET /` - Main dashboard
- `GET /auth/whoop` - Initiate OAuth flow
- `GET /callback` - OAuth callback
- `GET /profile` - User profile data
- `GET /whoop-data` - WHOOP profile data
- `GET /body-stats` - Body measurement data
- `GET /current-strain` - Real-time strain data
- `POST /webhook` - WHOOP webhook endpoint
- `GET /health` - Health check
- `GET /logout` - Logout and cleanup

## Development

### Running in Development
```bash
# With auto-restart
npm install -g nodemon
nodemon Project/app.js

# With debugging
DEBUG=* node Project/app.js
```

### Testing Webhooks
Use ngrok to expose your local server:
```bash
ngrok http 3000
# Use the HTTPS URL for webhook configuration
```

## Production Deployment

### Environment Variables
Set `NODE_ENV=production` for:
- Secure cookies (HTTPS only)
- Enhanced security headers
- Optimized logging

### Scaling Considerations
- Replace file-based sessions with Redis/database
- Use environment-specific token storage
- Implement proper logging and monitoring
- Set up process managers (PM2, etc.)

## Security Features

- **HttpOnly cookies** prevent XSS attacks
- **Secure session storage** with encryption
- **Token separation** from session data
- **Automatic cleanup** of expired tokens
- **Environment-based security** settings

## Monitoring

- Health check endpoint: `GET /health`
- Comprehensive logging for debugging
- Graceful shutdown handling
- Token expiration monitoring

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is for educational and portfolio purposes.

## Support

For questions or issues:
1. Check the WHOOP Developer Documentation
2. Review the application logs
3. Ensure all environment variables are set correctly
4. Verify webhook configuration if using real-time features 