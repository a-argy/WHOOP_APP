require('dotenv').config({ path: '../../.env' });
const { Pool } = require('pg');
const crypto = require('crypto');

class TokenStorage {
  constructor() {
    // Database connection - construct connection string with Aurora endpoint
    const dbConfig = {
      host: 'database-1.cwr0u4gow4li.us-east-1.rds.amazonaws.com',
      port: 5432,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      ssl: true
    };

    this.pool = new Pool(dbConfig);
    
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
    if (!process.env.DB_PASSWORD) {
      throw new Error('DB_PASSWORD environment variable is required');
    }
    if (!process.env.DB_NAME) {
      throw new Error('DB_NAME environment variable is required');
    }
    
    // Initialize database table
    this.initDatabase();
  }

  async initDatabase() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS user_tokens (
          user_id VARCHAR(255) PRIMARY KEY,
          encrypted_data JSONB NOT NULL,
        )
      `);
      console.log('Database initialized successfully');
    } catch (error) {
      console.error('Error initializing database:', error);
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
      const result = await this.pool.query('SELECT user_id, encrypted_data FROM user_tokens');
      const tokens = {};
      result.rows.forEach(row => {
        tokens[row.user_id] = row.encrypted_data;
      });
      return tokens;
    } catch (error) {
      console.error('Error reading tokens from database:', error);
      return {};
    }
  }
  
  async set(userId, tokenData) {
    try {
      const dataToEncrypt = {
        ...tokenData,
        updatedAt: new Date().toISOString(),
        expiresAt: tokenData.expiresAt || (Date.now() + (1000 * 60 * 60 * 24)) 
      };
      
      const encryptedData = this.encrypt(JSON.stringify(dataToEncrypt));
      
      await this.pool.query(`
        INSERT INTO user_tokens (user_id, encrypted_data)
        VALUES ($1, $2)
        ON CONFLICT (user_id) 
        DO UPDATE SET encrypted_data = $2
      `, [userId, encryptedData]);
      
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
      
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.CLIENT_ID,
        client_secret: this.CLIENT_SECRET,
        scope: 'offline',
        refresh_token: tokenData.refreshToken,
      });

      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };

      const response = await fetch(`${this.WHOOP_API_HOSTNAME}/oauth/oauth2/token`, {
        body,
        headers,
        method: 'POST',
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Token refresh failed for user ${userId}:`, {
          status: response.status,
          error: errorText,
          refreshToken: tokenData.refreshToken ? '[PRESENT]' : '[MISSING]'
        });
        throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      // Prepare refreshed token data (removed refreshedAt as requested)
      const refreshedTokenData = {
        ...tokenData, // Preserve other data like strainPollingEnabled
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000
      };

      // Save refreshed tokens
      await this.set(userId, refreshedTokenData);

      console.log(`Token refreshed successfully for user ${userId}, new expiry: ${new Date(refreshedTokenData.expiresAt).toISOString()}`);
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
      const result = await this.pool.query('SELECT encrypted_data FROM user_tokens WHERE user_id = $1', [userId]);
      if (result.rows.length === 0) {
        return null;
      }
      const decryptedData = this.decrypt(result.rows[0].encrypted_data);
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
      await this.pool.query('DELETE FROM user_tokens WHERE user_id = $1', [userId]);
      console.log(`Tokens deleted for user: ${userId}`);
    } catch (error) {
      console.error('Error deleting tokens:', error);
      throw error;
    }
  }

  async cleanup() {
    try {
      // Remove expired tokens that can't be refreshed (older than 7 days)
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      await this.pool.query(`
        DELETE FROM user_tokens 
        WHERE (encrypted_data->>'expiresAt')::bigint < $1
      `, [sevenDaysAgo]);
      console.log('Token storage cleaned up');
    } catch (error) {
      console.error('Error cleaning up tokens:', error);
    }
  }
}

module.exports = new TokenStorage();