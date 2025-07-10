require('dotenv').config();
const express = require('express');
const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2').Strategy;
const session = require('express-session');
const crypto = require('crypto');
const { validateWebhookSignature } = require('./utils/webhook');
const { sendToFoundry } = require('./utils/foundry');
const { checkAndRefresh, fetchWorkoutData, fetchSleepData, fetchRecoveryData } = require('./utils/whoop');

const app = express();
// Add body parser middleware for webhook JSON
app.use(express.json());

// Store user tokens (in production, use a proper database)
const userTokens = new Map();

// Set environment variables in .env file
const WHOOP_API_HOSTNAME = process.env.WHOOP_API_HOSTNAME || 'https://api.prod.whoop.com';
const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:8080/callback';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-whoop-signature'];
  const timestamp = req.headers['x-whoop-signature-timestamp'];

  // Validate webhook signature
  if (!validateWebhookSignature(timestamp, req.body, signature)) {
    console.error('Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { type, user_id, id, score_state } = req.body;

  // Check if token needs refresh
  const accessToken = await checkAndRefresh(user_id, userTokens);

  // Handle different webhook event types
  switch (type) {
    case 'workout.updated':
      try {
        // Fetch workout data from WHOOP API
        const workoutData = await fetchWorkoutData(id, accessToken);

        // Send workout data to Foundry
        await sendToFoundry("workout", {
          ...workoutData,
          user_id: user_id,
          webhook_received_at: new Date().toISOString()
        });
        
        // Log the workout details
        console.log('New workout update received and data fetched:');
        console.log('User ID:', user_id);
        console.log('Workout ID:', id);
        console.log('Workout Data:', JSON.stringify(workoutData, null, 2));
        console.log('-------------------');

        res.status(200).json({ message: 'Workout update processed successfully' });
      } catch (error) {
        console.error('Error processing workout update webhook:', error);
        res.status(500).json({ error: 'Failed to process workout update' });
      }
      break;

    case 'workout.deleted':
      try {
        // Send deletion event to Foundry
        await sendToFoundry("workout_deleted", { 
          workout_id: id,
          user_id: user_id,
          deleted_at: new Date().toISOString()
        });

        // Log the deletion event without trying to fetch the workout data
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
        // Fetch sleep data from WHOOP API
        const sleepData = await fetchSleepData(id, accessToken);

        // Send sleep data to Foundry
        await sendToFoundry("sleep", {
          ...sleepData,
          user_id: user_id,
          webhook_received_at: new Date().toISOString()
        });
        
        // Log the sleep details
        console.log('New sleep update received and data fetched:');
        console.log('User ID:', user_id);
        console.log('Sleep ID:', id);
        console.log('Sleep Data:', JSON.stringify(sleepData, null, 2));
        console.log('-------------------');

        res.status(200).json({ message: 'Sleep update processed successfully' });
      } catch (error) {
        console.error('Error processing sleep update webhook:', error);
        res.status(500).json({ error: 'Failed to process sleep update' });
      }
      break;

    case 'sleep.deleted':
      try {
        // Send deletion event to Foundry
        await sendToFoundry("sleep_deleted", { 
          sleep_id: id,
          user_id: user_id,
          deleted_at: new Date().toISOString()
        });

        // Log the deletion event without trying to fetch the sleep data
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
        // Fetch recovery data from WHOOP API
        const recoveryData = await fetchRecoveryData(id, accessToken);

        // Send recovery data to Foundry
        await sendToFoundry("recovery", {
          ...recoveryData,
          user_id: user_id,
          webhook_received_at: new Date().toISOString()
        });
        
        // Log the recovery details
        console.log('New recovery update received and data fetched:');
        console.log('User ID:', user_id);
        console.log('Cycle ID:', id);
        console.log('Recovery Data:', JSON.stringify(recoveryData, null, 2));
        console.log('-------------------');

        res.status(200).json({ message: 'Recovery update processed successfully' });
      } catch (error) {
        console.error('Error processing recovery update webhook:', error);
        res.status(500).json({ error: 'Failed to process recovery update' });
      }
      break;

    case 'recovery.deleted':
      try {
        // Send deletion event to Foundry
        await sendToFoundry("recovery_deleted", { 
          cycle_id: id,
          user_id: user_id,
          deleted_at: new Date().toISOString()
        });

        // Log the deletion event without trying to fetch the recovery data
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
      // Acknowledge other webhook types
      console.log(`Received webhook of type: ${type}`);
      console.log('User ID:', user_id);
      console.log('Object ID:', id);
      console.log('-------------------');
      res.status(200).json({ message: 'Webhook received' });
  }
});

// Configure session middleware
app.use(session({
  secret: 'your-session-secret',
  resave: false,
  saveUninitialized: false
}));

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

// Function to fetch user profile from WHOOP
const fetchProfile = async (accessToken, done) => {
  try {
    const profileResponse = await fetch(
      `${WHOOP_API_HOSTNAME}/developer/v1/user/profile/basic`,
      {
      headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!profileResponse.ok) {
      return done(new Error('Failed to fetch profile'));
    }

    const profile = await profileResponse.json();
    done(null, profile);
  } catch (error) {
    done(error);
  }
};

// Function to handle user after successful authentication
const getUser = async (
  accessToken,
  refreshToken,
  { expires_in },
  profile,
  done
) => {
  try {
    const { first_name, last_name, user_id } = profile;

    // Create user object with WHOOP data
    const user = {
      accessToken,
      expiresAt: Date.now() + expires_in * 1000,
      firstName: first_name,
      lastName: last_name,
      refreshToken,
      userId: user_id,
    };

    // Store tokens for webhook access
    userTokens.set(user_id, {
      accessToken,
      refreshToken,
      expiresAt: user.expiresAt
    });

    // In a real application, you would save this to your database
    // For this example, we'll just log it and return the user object
    console.log('User authenticated successfully:', {
      userId: user_id,
      firstName: first_name,
      lastName: last_name,
      accessToken: accessToken ? '***' : null,
      refreshToken: refreshToken ? '***' : null,
      expiresAt: new Date(user.expiresAt).toISOString()
    });

    done(null, user);
  } catch (error) {
    done(error);
  }
};

// Configure Passport serialization
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// Create and configure the WHOOP OAuth 2.0 strategy
const whoopAuthorizationStrategy = new OAuth2Strategy(whoopOAuthConfig, getUser);
whoopAuthorizationStrategy.userProfile = fetchProfile;

// Use the strategy with Passport
passport.use('whoop', whoopAuthorizationStrategy);
    
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

        async function sendStrainToFoundry() {
          // This function is no longer needed since /current-strain automatically sends to Foundry
          // Just call updateStrainDisplay which will trigger the Foundry send
          await updateStrainDisplay();
        }

        function toggleStrainPolling() {
          const button = document.getElementById('pollStrainButton');
          if (pollingInterval) {
            // Stop polling
            clearInterval(pollingInterval);
            pollingInterval = null;
            button.textContent = 'Start Strain Polling';
            button.classList.remove('active');
          } else {
            // Start polling
            updateStrainDisplay(); // Initial update (automatically sends to Foundry)
            pollingInterval = setInterval(updateStrainDisplay, 60000); // Update display every minute (automatically sends to Foundry)
            button.textContent = 'Stop Strain Polling';
            button.classList.add('active');
          }
        }
      </script>
    </head>
    <body>
      <div class="container">
        <h1>WHOOP Dashboard</h1>
        ${req.user 
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

// Authentication routes
app.get('/auth/whoop', passport.authenticate('whoop'));

app.get('/callback',
  passport.authenticate('whoop', { failureRedirect: '/login' }),
  function (req, res) {
    // Successful authentication, redirect to home
    res.redirect('/');
  }
);

// Protected route example
app.get('/profile', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  res.json({
    message: 'Protected profile data',
    user: req.user
  });
});

// Body stats route
app.get('/body-stats', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const response = await makeWhoopApiCall('/developer/v1/user/measurement/body', req.user);
    
    if (!response.ok) {
      throw new Error(`WHOOP API error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching body stats:', error);
    res.status(500).json({ error: 'Failed to fetch body stats' });
  }
});

// Current strain route
app.get('/current-strain', async (req, res) => {
  if (!req.user || !req.user.accessToken) {
    return res.status(401).json({ error: 'Not authenticated or no access token' });
  }

  try {
    // Get the current time
    const now = new Date();
    // Get cycles from the last hour to ensure we get the most recent one
    const start = new Date(now - 60 * 60 * 1000).toISOString();
    const end = now.toISOString();
    
    const response = await fetch(
      `${WHOOP_API_HOSTNAME}/developer/v1/cycle?start=${start}&end=${end}&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${req.user.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`WHOOP API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('Current strain data:', data); // Add logging to help debug

    // Return the most recent cycle's strain data
    if (data.records && data.records.length > 0) {
      const currentCycle = data.records[0];
      const strainData = {
        strain: currentCycle.score?.strain || 0,
        averageHeartRate: currentCycle.score?.average_heart_rate || 0,
        maxHeartRate: currentCycle.score?.max_heart_rate || 0,
        start: currentCycle.start,
        end: currentCycle.end,
        scoreState: currentCycle.score_state,
        timestamp: new Date().toISOString() // Add current time for debugging
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
        // Don't fail the main request if Foundry fails
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
app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.redirect('/');
  });
});

// Start server
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
  console.log('Visit http://localhost:3000 to start the OAuth flow');
  console.log('Make sure to set your environment variables:');
  console.log('- CLIENT_ID');
  console.log('- CLIENT_SECRET');
  console.log('- CALLBACK_URL (optional, defaults to http://localhost:3000/callback)');
});