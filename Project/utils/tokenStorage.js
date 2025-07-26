require('dotenv').config({ path: '../../.env' });
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

class TokenStorage {
  constructor() {
    // Supabase client setup
    const supabaseUrl = 'https://jhtmwfscdzijpcvvnvel.supabase.co';
    const supabaseKey = process.env.SUPABASE_KEY;
    
    if (!supabaseKey) {
      throw new Error('SUPABASE_KEY environment variable is required');
    }
    
    this.supabase = createClient(supabaseUrl, supabaseKey);
    
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
    
    // Initialize database table
    this.initDatabase();
  }

  async initDatabase() {
    try {
      // Check if table exists by trying to select from it
      const { data, error } = await this.supabase
        .from('user_tokens')
        .select('user_id')
        .limit(1);
      
      if (error) {
        console.log('Database initialized');
      } else {
        console.log('✅ Database initialized successfully');
      }
    } catch (error) {
      console.error('Error checking database:', error);
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
      const { data, error } = await this.supabase
        .from('user_tokens')
        .select('user_id, encrypted_data');
      
      if (error) {
        console.error('No tokens found');
        return {};
      }
      
      const tokens = {};
      data.forEach(row => {
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
      
      const { error } = await this.supabase
        .from('user_tokens')
        .upsert({
          user_id: userId,
          encrypted_data: encryptedData,
          updated_at: new Date().toISOString()
        });
      
      if (error) {
        console.error('Supabase error details:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        throw error;
      }
      
    } catch (error) {
      console.error('Error saving tokens:', {
        message: error.message,
        code: error.code,
        details: error.details
      });
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
      const { data, error } = await this.supabase
        .from('user_tokens')
        .select('encrypted_data')
        .eq('user_id', userId)
        .single();
      
      if (error) {
        if (error.code === 'PGRST116') {
          // No rows found
          return null;
        }
        console.error('Supabase error in getRaw:', {
          code: error.code,
          message: error.message,
          details: error.details
        });
        throw error;
      }
      
      const decryptedData = this.decrypt(data.encrypted_data);
      return JSON.parse(decryptedData);
    } catch (error) {
      console.error('Error getting raw tokens:', {
        message: error.message,
        code: error.code,
        userId: userId
      });
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
      const { error } = await this.supabase
        .from('user_tokens')
        .delete()
        .eq('user_id', userId);
      
      if (error) {
        throw error;
      }
      
      console.log(`Tokens deleted for user: ${userId}`);
    } catch (error) {
      console.error('Error deleting tokens:', error);
      throw error;
    }
  }
}

module.exports = new TokenStorage();