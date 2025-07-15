// Project/utils/tokenStorage.js
const fs = require('fs-extra');
const path = require('path');

class TokenStorage {
  constructor() {
    this.tokensFile = path.join(__dirname, '../data/tokens.json');
    this.ensureDataDir();
  }

  async ensureDataDir() {
    try {
      await fs.ensureDir(path.dirname(this.tokensFile));
    } catch (error) {
      console.error('Error creating data directory:', error);
    }
  }

  async set(userId, tokenData) {
    try {
      const tokens = await this.getAll();
      tokens[userId] = {
        ...tokenData,
        updatedAt: new Date().toISOString()
      };
      await fs.writeJson(this.tokensFile, tokens, { spaces: 2 });
      console.log(`Tokens saved for user: ${userId}`);
    } catch (error) {
      console.error('Error saving tokens:', error);
      throw error;
    }
  }

  async get(userId) {
    try {
      const tokens = await this.getAll();
      return tokens[userId] || null;
    } catch (error) {
      console.error('Error getting tokens:', error);
      return null;
    }
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
      const now = Date.now();
      const updated = {};
      
      for (const [userId, tokenData] of Object.entries(tokens)) {
        // Remove expired tokens (keeping a buffer of 1 hour)
        if (tokenData.expiresAt && tokenData.expiresAt > (now - 3600000)) {
          updated[userId] = tokenData;
        }
      }
      
      await fs.writeJson(this.tokensFile, updated, { spaces: 2 });
      console.log('Token storage cleaned up');
    } catch (error) {
      console.error('Error cleaning up tokens:', error);
    }
  }
}

module.exports = new TokenStorage();