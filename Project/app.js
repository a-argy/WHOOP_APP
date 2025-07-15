require('dotenv').config();
const express = require('express');
const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2').Strategy;
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const crypto = require('crypto');
const { validateWebhookSignature } = require('./utils/webhook');
const { sendToFoundry } = require('./utils/foundry');
const { checkAndRefresh, fetchWorkoutData, fetchSleepData, fetchRecoveryData, makeWhoopApiCall } = require('./utils/whoop');
const { getUser, fetchProfile } = require('./utils/oauth');
const tokenStorage = require('./utils/tokenStorage');

const app = express();

// Add body parser middleware for webhook JSON
app.use(express.json());

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

// Configure session middleware with file store
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

// EXPLAIN THIS SECTION

// Initialize Passport
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

// Configure Passport serialization
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// Create and configure the WHOOP OAuth 2.0 strategy with getUser as the callback
const whoopAuthorizationStrategy = new OAuth2Strategy(whoopOAuthConfig, getUser);
whoopAuthorizationStrategy.userProfile = fetchProfile;

// Registers the configured strategy with Passport under the name 'whoop'
passport.use('whoop', whoopAuthorizationStrategy);

// Passport uses whoopAuthorizationStrategy to build a URL that redirects the user to WHOOP login page
app.get('/auth/whoop', passport.authenticate('whoop'));

// After user authorizes, WHOOP rediracts to callback. Now, Passport makes a request to WHOOP
// exchanging the provided authorization code for access tokens. Passport makes a call to getUser
// with the access token
app.get('/callback',
  passport.authenticate('whoop', { failureRedirect: '/login' }),
  function (req, res) {
    res.redirect('/');
  }
);

// SECTION ENDS HERE

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  // Validate webhook signature
  const signature = req.headers['x-whoop-signature'];
  const timestamp = req.headers['x-whoop-signature-timestamp'];
  if (!validateWebhookSignature(timestamp, req.body, signature)) {
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
          
          console.log('New workout update received and data fetched:');
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
          
          console.log('New sleep update received and data fetched:');
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
          
          console.log('New recovery update received and data fetched:');
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
        let pollingInterval;
        
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
            
            const strainDisplay = document.getElementById('strain-display');
            strainDisplay.innerHTML = \`
              <div class="strain-value">Current Strain: \${data.strain.toFixed(2)}</div>
              <div class="heart-rate">Average Heart Rate: \${data.averageHeartRate} bpm</div>
              <div class="heart-rate">Max Heart Rate: \${data.maxHeartRate} bpm</div>
              <div>Last Updated: \${new Date().toLocaleTimeString()}</div>
            \`;

            return data;
          } catch (error) {
            console.error('Error fetching strain:', error);
            const strainDisplay = document.getElementById('strain-display');
            strainDisplay.innerHTML = \`<div>Error fetching strain data: \${error.message}</div>\`;
            throw error;
          }
        }

        function toggleStrainPolling() {
          const button = document.getElementById('pollStrainButton');
          if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
            button.textContent = 'Start Strain Polling';
            button.classList.remove('active');
          } else {
            updateStrainDisplay();
            pollingInterval = setInterval(updateStrainDisplay, 60000);
            button.textContent = 'Stop Strain Polling';
            button.classList.add('active');
          }
        }
      </script>
    </head>
    <body>
      <div class="container">
        <h1>WHOOP Dashboard</h1>
        ${req.user && req.user.isAuthenticated
          ? `
            <p>Welcome, ${req.user.firstName}!</p>
            <button class="button" onclick="fetchWhoopData('/whoop-data')">Fetch Profile Data</button>
            <button class="button" onclick="fetchWhoopData('/body-stats')">Fetch Body Stats</button>
            <button id="pollStrainButton" class="button" onclick="toggleStrainPolling()">Start Strain Polling</button>
            <a href="/logout" class="button logout">Logout</a>
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

// Protected route example
app.get('/profile', (req, res) => {
  if (!req.user || !req.user.isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  res.json({
    message: 'Protected profile data',
    user: req.user
  });
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
    const now = new Date();
    const start = new Date(now - 60 * 60 * 1000).toISOString();
    const end = now.toISOString();
    
    const data = await makeWhoopApiCall(
      `/developer/v1/cycle?start=${start}&end=${end}&limit=1`,
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

      // Send strain data to Foundry automatically
      try {
        await sendToFoundry("strain", {
          ...strainData,
          user_id: req.user.userId
        });
        console.log('Strain data sent to Foundry automatically');
      } catch (foundryError) {
        console.error('Error sending strain to Foundry:', foundryError);
      }

      res.json(strainData);
    } else {
      res.json({ error: 'No cycle data available' });
    }
  } catch (error) {
    console.error('Error fetching current strain:', error);
    res.status(500).json({ error: 'Failed to fetch strain data' });
  }
});

// Logout route
app.get('/logout', async (req, res) => {
  if (req.user && req.user.userId) {
    // Optionally clean up user tokens on logout
    try {
      await tokenStorage.delete(req.user.userId);
      console.log(`Cleaned up tokens for user: ${req.user.userId}`);
    } catch (error) {
      console.error('Error cleaning up tokens:', error);
    }
  }
  
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.redirect('/');
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  
  // Clean up expired tokens
  try {
    await tokenStorage.cleanup();
    console.log('Token cleanup completed');
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
  
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Visit the URL to start the OAuth flow');
});