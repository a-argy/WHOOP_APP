/**
 * Handles user data after successful OAuth authentication
 * @param {string} accessToken - OAuth access token from WHOOP
 * @param {string} refreshToken - OAuth refresh token from WHOOP
 * @param {Object} tokenInfo - Token information object
 * @param {number} tokenInfo.expires_in - Token expiration time in seconds
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

module.exports = {
  getUser
};