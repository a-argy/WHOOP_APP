require('dotenv').config({ path: '../../.env' });
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

class TokenStorage {
  constructor() {
    this.tokensFile = path.join(__dirname, '../data/tokens.json');
    this.secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
    this.algorithm = 'aes-256-gcm';
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
      const existing = await this.get(userId) || {};
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

  async get(userId) {
    try {
      const tokens = await this.getAll();
      const encryptedData = tokens[userId];
      if (!encryptedData) {
        return null;
      }
      const decryptedData = this.decrypt(encryptedData);
      const tokenData = JSON.parse(decryptedData);
      
      // Check if token has expired
      if (tokenData.expiresAt && tokenData.expiresAt < Date.now()) {
        await this.delete(userId);
        return null;
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
          
          // Remove expired tokens
          if (tokenData.expiresAt && tokenData.expiresAt < Date.now()) {
            delete tokens[userId];
            console.log(`Cleaned up expired token for user: ${userId}`);
          }
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