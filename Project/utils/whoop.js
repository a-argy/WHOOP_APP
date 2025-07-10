require('dotenv').config();

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
 * @param {Map} userTokens - Map containing user_id as key and token object containing refresh token and expiration info as value
 * @returns {Promise<string>} - Valid access token (either existing or refreshed)
 * @throws {Error} - When token refresh fails or API returns an error
 */
async function checkAndRefresh(user_id, userTokens) {
  try {
    const userToken = userTokens.get(user_id);
    if (!userToken) {
      throw new Error(`No access token found for user: ${user_id}`);
    }

    // Check if token needs refresh
    if (Date.now() >= userToken.expiresAt) {
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
      
      // Update the Map with new tokens
      userTokens.set(user_id, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000
      });

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
 * Generic function to fetch data from WHOOP API
 * @param {string} endpoint - API endpoint path
 * @param {string} accessToken - Valid access token
 * @returns {Promise<Object>} - API response data
 * @throws {Error} - When API call fails
 */
async function fetchWhoopData(endpoint, accessToken) {
  try {
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
    console.error(`Error fetching WHOOP data from ${endpoint}:`, error);
    throw error;
  }
}

/**
 * Fetches workout data from WHOOP API
 * @param {string} workoutId - Workout ID
 * @param {string} accessToken - Valid access token
 * @returns {Promise<Object>} - Workout data
 * @throws {Error} - When API call fails
 */
async function fetchWorkoutData(workoutId, accessToken) {
  return fetchWhoopData(`/developer/v1/activity/workout/${workoutId}`, accessToken);
}

/**
 * Fetches sleep data from WHOOP API
 * @param {string} sleepId - Sleep ID
 * @param {string} accessToken - Valid access token
 * @returns {Promise<Object>} - Sleep data
 * @throws {Error} - When API call fails
 */
async function fetchSleepData(sleepId, accessToken) {
  return fetchWhoopData(`/developer/v1/activity/sleep/${sleepId}`, accessToken);
}

/**
 * Fetches recovery data from WHOOP API
 * @param {string} cycleId - Cycle ID
 * @param {string} accessToken - Valid access token
 * @returns {Promise<Object>} - Recovery data
 * @throws {Error} - When API call fails
 */
async function fetchRecoveryData(cycleId, accessToken) {
  return fetchWhoopData(`/developer/v1/cycle/${cycleId}/recovery`, accessToken);
}

module.exports = {
    checkAndRefresh,
    fetchWorkoutData,
    fetchSleepData,
    fetchRecoveryData
};
