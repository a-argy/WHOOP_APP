require('dotenv').config({ path: '../.env' });
const express = require('express');
const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2').Strategy;
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const crypto = require('crypto');
const { validateWebhookSignature } = require('./utils/webhook');
const { sendToFoundry } = require('./utils/foundry');
const { fetchWorkoutData, fetchSleepData, fetchRecoveryData, makeWhoopApiCall, revokeAccessToken } = require('./utils/whoop');
const { getUser, fetchProfile } = require('./utils/oauth');
const tokenStorage = require('./utils/tokenStorage');
const strainManager = require('./worker/strainPoller');
const { strainEmitter } = strainManager;

const app = express();

// Add body-parser that also keeps a copy of the raw body so we can verify
// WHOOP webhook signatures (they require the exact byte-for-byte payload).
app.use(express.json({
  verify: (req, res, buf) => {
    // Store raw body on the request for later verification.  We do this for
    // every request but only the /webhook handler actually uses it.
    req.rawBody = buf;
  }
}));

// Environment variables
const WHOOP_API_HOSTNAME = process.env.WHOOP_API_HOSTNAME || 'https://api.prod.whoop.com';
const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:3000/callback';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = process.env.PORT || 3000;

// Validate required environment variables
if (!CLIENT_ID) {
  throw new Error('CLIENT_ID environment variable is required');
}
if (!CLIENT_SECRET) {
  throw new Error('CLIENT_SECRET environment variable is required');
}

// -----------------------------------------------------------------------------
// SESSION MIDDLEWARE  (express-session + session-file-store)
//
// 1.  First visit (no `connect.sid` cookie):
//     • express-session generates a random session-ID (sid).
//     • An *empty* session object `{}` is persisted to disk by
//       session-file-store at `./sessions/<sid>.json`.
//     • A *signed* cookie containing **only** that sid is sent back to the
//       browser: `Set-Cookie: connect.sid=s%3A<sid>.<signature>; …`.
//
// 2.  Subsequent requests:
//     • Browser sends the cookie.
//     • express-session verifies the signature using `secret` and loads the
//       JSON file into `req.session`.  The raw sid is available as
//       `req.sessionID` (not inside the session object).
//
// 3.  After a successful Passport login:
//     • `serializeUser()` chooses a *tiny* identifier (often `user.id`) to
//       persist and writes it to `req.session.passport.user`.
//     • *Before the current response is sent* `express-session`'s `finish`
//       listener detects that the session object is "dirty" and persists it to
//       `./sessions/<sid>.json`.  The cookie does **not** change because the
//       sid stays the same. Subsequent requests will read that file to
//       rebuild `req.session`.
//
// 4.  Important knobs in the config below:
//     • `secret` – used to sign the cookie; keep it long & random in
//       production.  It is *not* an encryption key.
//     • `ttl`    – time-to-live for files; here 24 h.
//     • `resave` & `saveUninitialized` – disable noisy writes.
//     • `cookie.secure` – ensures the cookie is only sent over HTTPS in prod.
//
// 5.  Scaling tip: swap FileStore for Redis (connect-redis) when you run
//     multiple server instances.
// -----------------------------------------------------------------------------
app.use(session({
  store: new FileStore({
    path: './sessions',
    ttl: 60 * 60 * 24,
    secret: SESSION_SECRET
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// ---------------------------------------------------------------------------
// PASSPORT INITIALISATION & SESSION SUPPORT
//
// 1. `passport.initialize()` attaches Passport to the Express request cycle.
//    It is *stateless* – it neither reads nor writes sessions.
//
// 2. `passport.session()` must come *after* `express-session` middleware.
//    It performs two complementary tasks:
//       a.  **Deserialise** – On *every* request that carries a valid session
//           cookie, Passport inspects `req.session.passport?.user`. If that
//           key exists it invokes `deserializeUser(serialized, cb)` to hydrate
//           the full user record.  The object yielded by the callback becomes
//           `req.user`, which is what the rest of the app should rely on.
//       b.  **Serialise** – During the *initial* login (or an explicit
//           `req.login(user)` call) Passport invokes `serializeUser(user, cb)`.
//           Whatever the callback returns is persisted at
//           `req.session.passport.user` and lives there until disconnect or session
//           expiry.  A tiny value (e.g. `user.id`) keeps the session file / DB
//           lean.
//
//    ➡  Always read identity from `req.user` – it exists whether the request
//       was authenticated via a session, a JWT, or a Bearer token.  Peeking at
//       `req.session.passport.user` ties your code to the storage mechanism
//       and will break if you later switch strategies.
//
// 3. `req.logout([options], cb)` – supplied by Passport – removes both
//    `req.user` *and* `req.session.passport`.  By default it regenerates the
//    session (new sid) to protect against session-fixation attacks.  Pass
//    `{ keepSessionInfo: true }` to preserve other, non-auth keys in the
//    session.
// ---------------------------------------------------------------------------
app.use(passport.initialize());
app.use(passport.session());

// WHOOP OAuth 2.0 Configuration
const whoopOAuthConfig = {
  authorizationURL: `${WHOOP_API_HOSTNAME}/oauth/oauth2/auth`,
  tokenURL: `${WHOOP_API_HOSTNAME}/oauth/oauth2/token`,
  clientID: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  callbackURL: CALLBACK_URL,
  state: true,
  scope: [
    'offline',
    'read:profile',
    'read:recovery',
    'read:cycles',
    'read:workout',
    'read:sleep',
    'read:body_measurement'
  ],
};

// ------------------------------------------------------------
// SERIALISATION STRATEGY
//
// Runs **once per login**.
//   • Receives the full `user` object returned by the OAuth verify callback.
//   • Must decide what *minimal* value to persist in the session – keep it
//     small to reduce I/O (commonly `user.id`).
//   • That value is stored at `req.session.passport.user` (again: *not* in the
//     cookie) and reused on every subsequent request.
//
// NOTE: In this demo we store the whole user object for convenience.  In a
// real-world app swap `user` for a lightweight identifier and fetch fresh data
// inside `deserializeUser` to keep sessions lean and up-to-date.
// ------------------------------------------------------------
passport.serializeUser((user, done) => {
  done(null, user); 
});

// ------------------------------------------------------------
// DESERIALISATION STRATEGY
//
// Runs on **every request** that contains a session.
//   • Accepts whatever was returned by `serializeUser`.
//   • Typically performs a DB/API lookup to rebuild the full `user` record.
//   • The result becomes `req.user` for the duration of the request.
//
// If you changed what you store in `serializeUser`, update this function to
// match – the two are a tightly-coupled pair.
// ------------------------------------------------------------
passport.deserializeUser((user, done) => {
  done(null, user);
});

// Create and configure the WHOOP OAuth 2.0 strategy with getUser as the 'verify' function (happens after fetchProfile) 
// which establishes a login session for the user on this app and passes it off to serializeUser
const whoopAuthorizationStrategy = new OAuth2Strategy(whoopOAuthConfig, getUser);
// Passport makes a call to the WHOOP API once the user is authenticated to get profile data
whoopAuthorizationStrategy.userProfile = fetchProfile;

// Registers the configured strategy with Passport under the name 'whoop' (this is the name of the strategy)
passport.use('whoop', whoopAuthorizationStrategy);

// Passport uses whoopAuthorizationStrategy to build a URL that redirects the user to WHOOP login page
app.get('/auth/whoop', passport.authenticate('whoop'));

// After user authorizes, WHOOP rediracts to callback. Now, Passport makes a request to WHOOP
// exchanging the provided authorization code for access tokens, gets the user (fetchProfile),
// then calls the 'verify' function
app.get('/callback',
  passport.authenticate('whoop', { failureRedirect: '/login' }),
  function (req, res) {
    res.redirect('/');
  }
);

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  console.log('Webhook landed');
  // Validate webhook signature
  const signature = req.headers['x-whoop-signature'];
  const timestamp = req.headers['x-whoop-signature-timestamp'];

  if (!validateWebhookSignature(timestamp, req.rawBody, signature)) {
    console.error('Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { type, user_id, id } = req.body;

  try {
    // Handle different webhook event types
    switch (type) {
      case 'workout.updated':
        try {
          const workoutData = await fetchWorkoutData(id, user_id);
          await sendToFoundry("workout", {
            ...workoutData,
            user_id: user_id,
            webhook_received_at: new Date().toISOString()
          });
          
          console.log('New workout update received and data sent to Foundry:');
          console.log('User ID:', user_id);
          console.log('Workout ID:', id);
          console.log('-------------------');

          res.status(200).json({ message: 'Workout update processed successfully' });
        } catch (error) {
          console.error('Error processing workout update webhook:', error);
          res.status(500).json({ error: 'Failed to process workout update' });
        }
        break;

      case 'workout.deleted':
        try {
          await sendToFoundry("workout_deleted", { 
            workout_id: id,
            user_id: user_id,
            deleted_at: new Date().toISOString()
          });

          console.log('Workout deletion notification received:');
          console.log('User ID:', user_id);
          console.log('Deleted Workout ID:', id);
          console.log('-------------------');
          
          res.status(200).json({ message: 'Workout deletion processed successfully' });
        } catch (error) {
          console.error('Error processing workout deletion:', error);
          res.status(500).json({ error: 'Failed to process workout deletion' });
        }
        break;

      case 'sleep.updated':
        try {
          const sleepData = await fetchSleepData(id, user_id);
          await sendToFoundry("sleep", {
            ...sleepData,
            user_id: user_id,
            webhook_received_at: new Date().toISOString()
          });
          
          console.log('New sleep update received and data sent to Foundry:');
          console.log('User ID:', user_id);
          console.log('Sleep ID:', id);
          console.log('-------------------');

          res.status(200).json({ message: 'Sleep update processed successfully' });
        } catch (error) {
          console.error('Error processing sleep update webhook:', error);
          res.status(500).json({ error: 'Failed to process sleep update' });
        }
        break;

      case 'sleep.deleted':
        try {
          await sendToFoundry("sleep_deleted", { 
            sleep_id: id,
            user_id: user_id,
            deleted_at: new Date().toISOString()
          });

          console.log('Sleep deletion notification received:');
          console.log('User ID:', user_id);
          console.log('Deleted Sleep ID:', id);
          console.log('-------------------');
          
          res.status(200).json({ message: 'Sleep deletion processed successfully' });
        } catch (error) {
          console.error('Error processing sleep deletion:', error);
          res.status(500).json({ error: 'Failed to process sleep deletion' });
        }
        break;

      case 'recovery.updated':
        try {
          const recoveryData = await fetchRecoveryData(id, user_id);
          await sendToFoundry("recovery", {
            ...recoveryData,
            user_id: user_id,
            webhook_received_at: new Date().toISOString()
          });
          
          console.log('New recovery update received and data sent to Foundry:');
          console.log('User ID:', user_id);
          console.log('Cycle ID:', id);
          console.log('-------------------');

          res.status(200).json({ message: 'Recovery update processed successfully' });
        } catch (error) {
          console.error('Error processing recovery update webhook:', error);
          res.status(500).json({ error: 'Failed to process recovery update' });
        }
        break;

      case 'recovery.deleted':
        try {
          await sendToFoundry("recovery_deleted", { 
            cycle_id: id,
            user_id: user_id,
            deleted_at: new Date().toISOString()
          });

          console.log('Recovery deletion notification received:');
          console.log('User ID:', user_id);
          console.log('Deleted Cycle ID:', id);
          console.log('-------------------');
          
          res.status(200).json({ message: 'Recovery deletion processed successfully' });
        } catch (error) {
          console.error('Error processing recovery deletion:', error);
          res.status(500).json({ error: 'Failed to process recovery deletion' });
        }
        break;

      default:
        console.log(`Received webhook of type: ${type}`);
        console.log('User ID:', user_id);
        console.log('Object ID:', id);
        console.log('-------------------');
        res.status(200).json({ message: 'Webhook received' });
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Routes
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WHOOP Dashboard</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          background-color: #f5f5f5;
        }
        .container {
          background-color: white;
          padding: 30px;
          border-radius: 10px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 {
          color: #333;
          margin-bottom: 20px;
        }
        .button {
          display: inline-block;
          padding: 10px 20px;
          margin: 10px 5px;
          background-color: #007bff;
          color: white;
          text-decoration: none;
          border-radius: 5px;
          border: none;
          cursor: pointer;
          transition: background-color 0.3s;
        }
        .button:hover {
          background-color: #0056b3;
        }
        .button.logout {
          background-color: #dc3545;
        }
        .button.logout:hover {
          background-color: #c82333;
        }
        .button.active {
          background-color: #28a745;
        }
        .button.active:hover {
          background-color: #218838;
        }
        #data-display {
          margin-top: 20px;
          padding: 20px;
          border: 1px solid #ddd;
          border-radius: 5px;
          background-color: #f8f9fa;
          white-space: pre-wrap;
          display: none;
        }
        .loading {
          display: none;
          color: #666;
          margin: 10px 0;
        }
        #strain-display {
          margin-top: 20px;
          padding: 20px;
          border: 1px solid #ddd;
          border-radius: 5px;
          background-color: #f8f9fa;
        }
        .strain-value {
          font-size: 24px;
          font-weight: bold;
          color: #007bff;
          margin: 10px 0;
        }
        .heart-rate {
          font-size: 16px;
          color: #666;
          margin: 5px 0;
        }
      </style>
      <script>
        // Toggle the strain-polling button appearance/label
        function updateButtonUI(enabled) {
          const button = document.getElementById('pollStrainButton');
          button.classList.toggle('active', enabled);
          button.textContent = enabled ? 'Stop Strain Polling' : 'Start Strain Polling';
        }

        // One-off pull of /current-strain so the widget shows data
        function handlePollingTimer(enabled) {
          if (enabled) {
            updateStrainDisplay();
          }
        }

        async function fetchWhoopData(endpoint) {
          const loadingEl = document.querySelector('.loading');
          const dataDisplay = document.getElementById('data-display');
          
          try {
            loadingEl.style.display = 'block';
            dataDisplay.style.display = 'none';
            
            const response = await fetch(endpoint);
            const data = await response.json();
            
            dataDisplay.style.display = 'block';
            dataDisplay.innerHTML = JSON.stringify(data, null, 2);
          } catch (error) {
            dataDisplay.style.display = 'block';
            dataDisplay.innerHTML = 'Error fetching data: ' + error.message;
          } finally {
            loadingEl.style.display = 'none';
          }
        }

        async function updateStrainDisplay() {
          try {
            const response = await fetch('/current-strain');
            const data = await response.json();
             
            if (data.error) {
              throw new Error(data.error);
            }
            
            renderStrain(data);

            return data;
          } catch (error) {
            console.error('Error fetching strain:', error);
            const strainDisplay = document.getElementById('strain-display');
            strainDisplay.innerHTML = '<div>Error fetching strain data: ' + error.message + '</div>';
            throw error;
          }
        }

        // Reuse a single renderer for both pull & push updates
        function renderStrain(data) {
          const strainDisplay = document.getElementById('strain-display');
          strainDisplay.innerHTML =
            '<div class="strain-value">Current Strain: ' + data.strain.toFixed(2) + '</div>' +
            '<div class="heart-rate">Average Heart Rate: ' + data.averageHeartRate + ' bpm</div>' +
            '<div class="heart-rate">Max Heart Rate: ' + data.maxHeartRate + ' bpm</div>' +
            '<div>Last Updated: ' + new Date().toLocaleTimeString() + '</div>';
        }

        async function toggleStrainPolling() {
          const button = document.getElementById('pollStrainButton');
          const currentlyActive = button.classList.contains('active');
          try {
            const response = await fetch('/settings/strain-polling', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: !currentlyActive })
            });
            const { enabled } = await response.json();
            updateButtonUI(enabled);
            handlePollingTimer(enabled);
          } catch (err) {
            console.error('Failed to toggle polling', err);
          }
        }

        // On initial page load, query current state once
        document.addEventListener('DOMContentLoaded', async () => {
          try {
            const response = await fetch('/settings/strain-polling');
            const { enabled } = await response.json();
            updateButtonUI(enabled);
            handlePollingTimer(enabled);
          } catch (err) {
            console.error('Error fetching initial polling state', err);
          }
        });

        // BROWSER SIDE: Open persistent connection to server for real-time updates
        // This is like calling a radio station and staying on the line to hear live broadcasts
        var strainEvents = new EventSource('/events/strain');
        
        // RECEIVE BROADCASTS: When server sends new strain data, this function runs
        // The server's "send" function writes data, this "onmessage" function receives it
        strainEvents.onmessage = function (evt) {
           try {
             // PARSE & DISPLAY: Convert JSON string back to object and update the UI
             var data = JSON.parse(evt.data);
             renderStrain(data);  // Update the strain widget immediately
           } catch (e) {
             console.error('Failed to parse strain event', e);
           }
        };
      </script>
    </head>
    <body>
      <div class="container">
        <h1>WHOOP Dashboard</h1>
        ${
          req.user && req.user.isAuthenticated
            ? `
              <p>Welcome, ${req.user.firstName}!</p>
              <button class="button" onclick="fetchWhoopData('/whoop-data')">Fetch Profile Data</button>
              <button class="button" onclick="fetchWhoopData('/body-stats')">Fetch Body Stats</button>
              <button id="pollStrainButton" class="button" onclick="toggleStrainPolling()">Start Strain Polling</button>
              <a href="/disconnect" class="button logout" onclick="return confirm('This will stop background strain monitoring. Are you sure?')">Disconnect WHOOP</a>
              <div class="loading">Loading data...</div>
              <div id="strain-display"></div>
              <pre id="data-display"></pre>
              `
            : `
              <p>Please authenticate with WHOOP to access your data:</p>
              <a href="/auth/whoop" class="button">Authenticate with WHOOP</a>
              `
        }
      </div>
    </body>
    </html>
  `);
});

// WHOOP data route
app.get('/whoop-data', async (req, res) => {
  if (!req.user || !req.user.isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const data = await makeWhoopApiCall('/developer/v1/user/profile/basic', req.user.userId);
    res.json(data);
  } catch (error) {
    console.error('Error fetching WHOOP data:', error);
    res.status(500).json({ error: 'Failed to fetch WHOOP data' });
  }
});

// Body stats route
app.get('/body-stats', async (req, res) => {
  if (!req.user || !req.user.isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const data = await makeWhoopApiCall('/developer/v1/user/measurement/body', req.user.userId);
    res.json(data);
  } catch (error) {
    console.error('Error fetching body stats:', error);
    res.status(500).json({ error: 'Failed to fetch body stats' });
  }
});

// Current strain route
app.get('/current-strain', async (req, res) => {
  if (!req.user || !req.user.isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const data = await makeWhoopApiCall(
      `/developer/v1/cycle?limit=1`,
      req.user.userId
    );

    if (data.records && data.records.length > 0) {
      const currentCycle = data.records[0];
      const strainData = {
        strain: currentCycle.score?.strain || 0,
        averageHeartRate: currentCycle.score?.average_heart_rate || 0,
        maxHeartRate: currentCycle.score?.max_heart_rate || 0,
        start: currentCycle.start,
        end: currentCycle.end,
        scoreState: currentCycle.score_state,
        timestamp: new Date().toISOString()
      };

      res.json(strainData);
    } else {
      res.json({ error: 'No cycle data available' });
    }
  } catch (error) {
    console.error('Error fetching current strain:', error);
    res.status(500).json({ error: 'Failed to fetch strain data' });
  }
});

// SSE endpoint for live strain updates
app.get('/events/strain', (req, res) => {
  if (!req.user || !req.user.isAuthenticated) {
    return res.sendStatus(401);
  }

  // SETUP PHASE: Convert this HTTP response into a persistent streaming connection
  // Think of this like "tuning into a radio station" - we're setting up to receive broadcasts
  res.set({
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',  // Tell browser: "This is a live data stream, not a regular webpage"
    Connection: 'keep-alive'              // Keep this HTTP connection open indefinitely
  });
  res.flushHeaders();  // Send headers immediately so browser can start listening

  // CREATE UNIQUE LISTENER: Each browser connection gets its own personal "radio receiver"
  // This function will be called every time the background worker has new strain data
  const send = ({ userId, data }) => {
    // FILTER: Only forward data meant for THIS specific browser's user
    // (Like having your name called over the intercom - ignore if it's not for you)
    if (userId === req.user.userId) {
      // DELIVER: Send the data through this browser's open connection in SSE format
      res.write('data:' + JSON.stringify(data) + '\n\n');
    }
  };

  // REGISTER LISTENER: Add this browser's personal "send" function to the global broadcaster
  // Now when strainEmitter.emit() happens, this function will be called along with all others
  strainEmitter.on('strain', send);
  
  // CLEANUP: When browser disconnects (tab closed, navigate away, etc.), remove the dead listener
  // Prevents memory leaks - like unsubscribing from a mailing list when you move
  req.on('close', () => strainEmitter.off('strain', send));
});

// Query current polling state 
app.get('/settings/strain-polling', async (req, res) => {
  if (!req.user || !req.user.isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const tokenData = await tokenStorage.get(req.user.userId);
  const enabled = !!tokenData?.strainPollingEnabled;
  res.json({ enabled });
});

// Enable / disable polling
app.post('/settings/strain-polling', async (req, res) => {
  if (!req.user || !req.user.isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled boolean required' });
  }
  const newState = enabled;
  await tokenStorage.set(req.user.userId, { strainPollingEnabled: newState });

  // Update per-user background worker
  if (newState) {
    strainManager.startUserPolling(req.user.userId);
  } else {
    strainManager.stopUserPolling(req.user.userId);
  }

  res.json({ enabled: newState });
});

// Remove session and delete tokens
app.get('/disconnect', async (req, res) => {
  if (!req.user || !req.user.isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Stop background polling job first to avoid race conditions
    strainManager.stopUserPolling(req.user.userId);

    // Revoke access token with WHOOP to stop webhook delivery
    // This tells WHOOP "this user is no longer using the app" so webhooks stop
    await revokeAccessToken(req.user.userId);

    // Delete stored tokens locally
    await tokenStorage.delete(req.user.userId);
    console.log(`Disconnected WHOOP access for user: ${req.user.userId}`);

    // Log out the user session
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ error: 'Logout failed' });
      }
      res.redirect('/?disconnected=true');
    });
  } catch (error) {
    console.error('Error disconnecting WHOOP:', error);
    res.status(500).json({ error: 'Failed to disconnect WHOOP access' });
  }
});

// Start server
let strainPollerInterval;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Visit the URL to start the OAuth flow');
  
  // Initialize strain poller after server is ready
  if (process.env.ENABLE_STRAIN_WORKER === 'true') {
    // Bootstrap per-user polling for users who had it enabled
    (async () => {
      console.log('🔍 Starting bootstrap process...');
      console.log('ENABLE_STRAIN_WORKER:', process.env.ENABLE_STRAIN_WORKER);
      
      const allTokens = await tokenStorage.getAll();
      console.log(`📁 Found ${Object.keys(allTokens).length} total tokens in storage`);
      
      const enabledUsers = [];
      for (const [uid, enc] of Object.entries(allTokens)) {
        try {
          console.log(`🔓 Attempting to decrypt token for user ${uid}`);
          const decrypted = JSON.parse(tokenStorage.decrypt(enc));
          console.log(`✅ Successfully decrypted token for user ${uid}`);
          console.log(`⚙️  strainPollingEnabled: ${decrypted.strainPollingEnabled}`);
          console.log(`🕒 Token expires at: ${new Date(decrypted.expiresAt).toISOString()}`);
          
          if (decrypted.strainPollingEnabled) {
            enabledUsers.push(uid);
            console.log(`✨ Added user ${uid} to enabled users list`);
          }
        } catch (error) {
          console.error(`❌ Failed to decrypt token for user ${uid}:`, error.message);
        }
      }
      strainManager.bootstrap(enabledUsers);
      console.log(`🚀 Strain polling commenced for ${enabledUsers.length} users`);
    })();
  } else {
    console.log('⚠️  ENABLE_STRAIN_WORKER is not "true", skipping bootstrap');
    console.log('Current value:', process.env.ENABLE_STRAIN_WORKER);
  }
});

// // --- graceful-shutdown helper (extract existing logic into a function) ---
// async function gracefulShutdown(signal) {
//   console.log(`Received ${signal}, shutting down gracefully…`);

//   const shutdownReason = process.env.RENDER_SHUTDOWN_REASON || 'UNKNOWN';
//   console.log(`Render shutdown reason: ${shutdownReason}`);

//   // Always stop background workers so we don't leave timers running in the container.
//   strainManager.shutdown();
//   console.log('All strain pollers stopped');

//   /*
//    * If Render is merely idling the service (free tier sleep) we want to keep
//    * session and token files around so that the service can resume work quickly
//    * when it starts back up.
//    *
//    * For any other reason – deploys, manual restarts, failures, etc. – we
//    * proceed with the full cleanup.
//    */
//   const shouldCleanupPersistentData = shutdownReason !== 'IDLE';

//   if (shouldCleanupPersistentData) {
//     try {
//       const fs = require('fs-extra');
//       const path = require('path');
//       const sessionsDir = path.join(__dirname, 'sessions');

//       if (await fs.pathExists(sessionsDir)) {
//         const files = await fs.readdir(sessionsDir);
//         const sessionFiles = files.filter((file) => file !== '.gitkeep');

//         for (const file of sessionFiles) {
//           await fs.remove(path.join(sessionsDir, file));
//         }

//         console.log(`All sessions cleared (${sessionFiles.length} files removed)`);
//       }
//     } catch (error) {
//       console.error('Error clearing sessions:', error);
//     }

//     // Clean up expired tokens
//     try {
//       await tokenStorage.cleanup();
//     } catch (error) {
//       console.error('Error during token cleanup:', error);
//     }
//   } else {
//     console.log('Skipping session and token cleanup due to idle shutdown.');
//   }

//   process.exit(0);
// }

// // Handle both local Ctrl-C and Render’s termination signal
// process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));