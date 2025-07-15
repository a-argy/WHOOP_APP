require('dotenv').config({ path: '../../.env' });
const tokenStorage = require('./tokenStorage');

// Environment variables
const WHOOP_API_HOSTNAME = process.env.WHOOP_API_HOSTNAME || 'https://api.prod.whoop.com';

/**
 * Fetches user profile data from WHOOP API after successful OAuth token exchange
 * @param {string} accessToken - OAuth access token from WHOOP
 * @param {Function} done - Passport callback function
 * @returns {void} - Calls done() with profile object or error
 */
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

/**
 * Handles user data after successful OAuth authentication
 * @param {string} accessToken - OAuth access token from WHOOP
 * @param {string} refreshToken - OAuth refresh token from WHOOP
 * @param {number} expires_in - Token expiration time in seconds
 * @param {Object} profile - User profile data from WHOOP API
 * @param {string} profile.first_name - User's first name
 * @param {string} profile.last_name - User's last name
 * @param {string} profile.user_id - User's WHOOP ID
 * @param {Function} done - Passport callback function
 * @returns {void} - Calls done() with user object or error
 */
const getUser = async (
  accessToken,
  refreshToken,
  { expires_in },
  profile,
  done
) => {
  try {
    const { first_name, last_name, user_id } = profile;
    const expiresAt = Date.now() + expires_in * 1000;

    // Store tokens persistently for api access
    await tokenStorage.set(user_id, {
      accessToken,
      refreshToken,
      expiresAt
    });

    // Create lean user object for session (no sensitive tokens)
    const user = {
      userId: user_id,
      firstName: first_name,
      lastName: last_name,
      isAuthenticated: true,
      authenticatedAt: new Date().toISOString()
    };

    console.log('User authenticated successfully:', {
      userId: user_id,
      firstName: first_name,
      lastName: last_name,
      tokenExpiresAt: new Date(expiresAt).toISOString()
    });

    done(null, user);
  } catch (error) {
    console.error('Error in OAuth getUser:', error);
    done(error);
  }
};

module.exports = {
  fetchProfile,
  getUser
};