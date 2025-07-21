require('dotenv').config({ path: '../../.env' });
const tokenStorage = require('./tokenStorage');

// Get environment variables
const WHOOP_API_HOSTNAME = process.env.WHOOP_API_HOSTNAME || 'https://api.prod.whoop.com';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Validate required environment variables
if (!CLIENT_ID) {
    throw new Error('CLIENT_ID environment variable is required');
}
if (!CLIENT_SECRET) {
    throw new Error('CLIENT_SECRET environment variable is required');
}

/**
 * Checks if token needs refresh and refreshes if necessary
 * @param {string} user_id - User ID
 * @returns {Promise<string>} - Valid access token (either existing or refreshed)
 * @throws {Error} - When token refresh fails or API returns an error
 */
async function checkAndRefresh(user_id) {
  try {
    const userToken = await tokenStorage.get(user_id);
    if (!userToken) {
      throw new Error(`No access token found for user: ${user_id}`);
    }

    // Check if token needs refresh
    if (Date.now() >= userToken.expiresAt) {
      console.log(`Token expired for user ${user_id}, refreshing...`);
      
      const response = await fetch(`${WHOOP_API_HOSTNAME}/oauth/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: userToken.refreshToken,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          scope: 'offline'
        })
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status}`);
      }

      const data = await response.json();
      
      // Update persistent storage with new tokens
      await tokenStorage.set(user_id, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000
      });

      console.log(`Token refreshed successfully for user ${user_id}`);
      return data.access_token;
    }

    // Token is still valid, return existing access token
    return userToken.accessToken;
    
  } catch (error) {
    console.error('Token refresh error:', error);
    throw error;
  }
}

/**
 * Makes authenticated WHOOP API calls with automatic token refresh
 * @param {string} endpoint - API endpoint path
 * @param {string} userId - User ID for token lookup
 * @returns {Promise<Object|Response>} - API response (parsed or raw)
 */
async function makeWhoopApiCall(endpoint, userId) {
  try {
    const accessToken = await checkAndRefresh(userId);
    
    const response = await fetch(`${WHOOP_API_HOSTNAME}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`WHOOP API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error making WHOOP API call to ${endpoint}:`, error);
    throw error;
  }
}

/**
 * Fetches workout data from WHOOP API
 * @param {string} workoutId - Workout ID
* @param {string} userId - User ID for token lookup
 * @returns {Promise<Object>} - Workout data
 * @throws {Error} - When API call fails
 */
async function fetchWorkoutData(workoutId, userId) {
  return makeWhoopApiCall(`/developer/v1/activity/workout/${workoutId}`, userId);
}

/**
 * Fetches sleep data from WHOOP API
 * @param {string} sleepId - Sleep ID
 * @param {string} userId - User ID for token lookup
 * @returns {Promise<Object>} - Sleep data
 * @throws {Error} - When API call fails
 */
async function fetchSleepData(sleepId, userId) {
  return makeWhoopApiCall(`/developer/v1/activity/sleep/${sleepId}`, userId);
}

/**
 * Fetches recovery data from WHOOP API
 * @param {string} cycleId - Cycle ID
 * @param {string} userId - User ID for token lookup
 * @returns {Promise<Object>} - Recovery data
 * @throws {Error} - When API call fails
 */
async function fetchRecoveryData(cycleId, userId) {
  return makeWhoopApiCall(`/developer/v1/cycle/${cycleId}/recovery`, userId);
}

/**
 * Revokes access token to stop webhook delivery and disconnect user from WHOOP
 * @param {string} userId - User ID to revoke access for
 * @returns {Promise<boolean>} - Success status
 */
async function revokeAccessToken(userId) {
  try {
    const userToken = await tokenStorage.get(userId);
    if (!userToken) {
      console.log(`No token found for user ${userId} - already disconnected`);
      return true;
    }

    // Revoke the access token with WHOOP
    const response = await fetch(`${WHOOP_API_HOSTNAME}/oauth/oauth2/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        token: userToken.accessToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      })
    });

    if (!response.ok) {
      console.error(`Token revocation failed: ${response.status}`);
      // Continue with local cleanup even if revocation fails
    } else {
      console.log(`Successfully revoked WHOOP access for user ${userId}`);
    }

    return true;
  } catch (error) {
    console.error(`Error revoking access token for user ${userId}:`, error);
    // Don't throw - we still want to clean up locally
    return false;
  }
}

module.exports = {
    checkAndRefresh,
    fetchWorkoutData,
    fetchSleepData,
    fetchRecoveryData,
    makeWhoopApiCall,
    revokeAccessToken
};
