require('dotenv').config({ path: '../../.env' });
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

class TokenStorage {
  constructor() {
    this.tokensFile = path.join(__dirname, '../data/tokens.json');
    this.secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
    this.algorithm = 'aes-256-gcm';
    
    // WHOOP API configuration
    this.WHOOP_API_HOSTNAME = process.env.WHOOP_API_HOSTNAME || 'https://api.prod.whoop.com';
    this.CLIENT_ID = process.env.CLIENT_ID;
    this.CLIENT_SECRET = process.env.CLIENT_SECRET;
    
    // Validate required environment variables
    if (!this.CLIENT_ID) {
      throw new Error('CLIENT_ID environment variable is required');
    }
    if (!this.CLIENT_SECRET) {
      throw new Error('CLIENT_SECRET environment variable is required');
    }
  }

  encrypt(text) {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(this.secret, 'salt', 32);
    const cipher = crypto.createCipheriv(this.algorithm, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      encryptedData: encrypted
    };
  }

  decrypt(encryptedObj) {
    const iv = Buffer.from(encryptedObj.iv, 'hex');
    const key = crypto.scryptSync(this.secret, 'salt', 32);
    const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
    decipher.setAuthTag(Buffer.from(encryptedObj.authTag, 'hex'));
    
    let decrypted = decipher.update(encryptedObj.encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  async getAll() {
    try {
      const exists = await fs.pathExists(this.tokensFile);
      if (!exists) {
        return {};
      }
      return await fs.readJson(this.tokensFile);
    } catch (error) {
      console.error('Error reading tokens file:', error);
      return {};
    }
  }
  
  async set(userId, tokenData) {
    try {
      // First get and merge with existing data if it exists
      const existing = await this.getRaw(userId) || {};
      const mergedData = { ...existing, ...tokenData };
      
      const dataToEncrypt = {
        ...mergedData,
        updatedAt: new Date().toISOString(),
        expiresAt: mergedData.expiresAt || (Date.now() + (1000 * 60 * 60 * 24)) 
      };
      
      const tokens = await this.getAll();
      const encryptedData = this.encrypt(JSON.stringify(dataToEncrypt));
      tokens[userId] = encryptedData;

      await fs.writeJson(this.tokensFile, tokens, { spaces: 2 });
    } catch (error) {
      console.error('Error saving tokens:', error);
      throw error;
    }
  }

  /**
   * Refreshes an expired access token using the refresh token
   * @param {string} userId - User ID
   * @param {Object} tokenData - Current token data
   * @returns {Promise<Object>} - Refreshed token data
   */
  async refreshToken(userId, tokenData) {
    try {
      console.log(`Token expired for user ${userId}, refreshing...`);
      
      const response = await fetch(`${this.WHOOP_API_HOSTNAME}/oauth/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokenData.refreshToken,
          client_id: this.CLIENT_ID,
          client_secret: this.CLIENT_SECRET,
          scope: 'offline'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      // Prepare refreshed token data
      const refreshedTokenData = {
        ...tokenData, // Preserve other data like strainPollingEnabled
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
        refreshedAt: new Date().toISOString()
      };

      // Save refreshed tokens
      await this.set(userId, refreshedTokenData);

      console.log(`Token refreshed successfully for user ${userId}`);
      return refreshedTokenData;
      
    } catch (error) {
      console.error(`Error refreshing token for user ${userId}:`, error);
      // If refresh fails, delete the token (it's likely the refresh token is also expired)
      await this.delete(userId);
      throw error;
    }
  }

  /**
   * Gets raw token data without refresh logic (internal use)
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} - Token data or null
   */
  async getRaw(userId) {
    try {
      const tokens = await this.getAll();
      const encryptedData = tokens[userId];
      if (!encryptedData) {
        return null;
      }
      const decryptedData = this.decrypt(encryptedData);
      return JSON.parse(decryptedData);
    } catch (error) {
      console.error('Error getting raw tokens:', error);
      return null;
    }
  }

  async get(userId) {
    try {
      const tokenData = await this.getRaw(userId);
      if (!tokenData) {
        return null;
      }
      
      // Check if token has expired
      if (tokenData.expiresAt && tokenData.expiresAt < Date.now()) {
        // Try to refresh the token instead of deleting it
        try {
          return await this.refreshToken(userId, tokenData);
        } catch (refreshError) {
          // If refresh fails, the token has already been deleted in refreshToken()
          return null;
        }
      }
      
      return tokenData;
    } catch (error) {
      console.error('Error getting tokens:', error);
      return null;
    }
  }

  async delete(userId) {
    try {
      const tokens = await this.getAll();
      delete tokens[userId];
      await fs.writeJson(this.tokensFile, tokens, { spaces: 2 });
      console.log(`Tokens deleted for user: ${userId}`);
    } catch (error) {
      console.error('Error deleting tokens:', error);
      throw error;
    }
  }

  async cleanup() {
    try {
      const tokens = await this.getAll();
      for (const [userId, encryptedData] of Object.entries(tokens)) {
        try {
          const decryptedData = this.decrypt(encryptedData);
          const tokenData = JSON.parse(decryptedData);
          delete tokens[userId];
        } catch (error) {
          console.error(`Error processing token for user ${userId}:`, error);
          delete tokens[userId];
        }
      }

      await fs.writeJson(this.tokensFile, tokens, { spaces: 2 });
      console.log('Token storage cleaned up');
    } catch (error) {
      console.error('Error cleaning up tokens:', error);
    }
  }
}

module.exports = new TokenStorage();