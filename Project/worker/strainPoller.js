require('dotenv').config({ path: '../../.env' });
const tokenStorage = require('../utils/tokenStorage');
const { makeWhoopApiCall } = require('../utils/whoop');
const { sendToFoundry } = require('../utils/foundry');
const { EventEmitter } = require('events');

const POLL_INTERVAL = 1000 * 60 * 10;  // 15 minutes
// In-memory map of userId -> interval handle
const activeTimers = new Map();
// Local event emitter to broadcast strain updates
const strainEmitter = new EventEmitter();

/**
 * Polls strain data for a single user
 * @param {string} userId - User ID to poll
 * @returns {Promise<Object|null>} - Strain data or null if no data
 */
async function pollUserStrain(userId) {
  try {
    const data = await makeWhoopApiCall(
      `/developer/v1/cycle?limit=1`,
      userId
    );

    if (data.records && data.records.length > 0) {
      const currentCycle = data.records[0];
      const strainData = {
        strain: currentCycle.score?.strain || 0,
        averageHeartRate: currentCycle.score?.average_heart_rate || 0,
        maxHeartRate: currentCycle.score?.max_heart_rate || 0,
        start: currentCycle.start,
        end: currentCycle.end,
        scoreState: currentCycle.score_state,
        timestamp: new Date().toISOString(),
        user_id: userId
      };
      // Send strain data to Foundry
      await sendToFoundry("strain", strainData);
      console.log(`Strain for user ${userId}: ${strainData.strain}`);

      // Broadcast to SSE listeners
      strainEmitter.emit('strain', { userId, data: strainData });
      return strainData;
    } else {
      console.log(`No cycle data available for user ${userId}`);
      return null;
    }
  } catch (error) {
    return null;
  }
}

/**
 * Start polling for a single user if not already active.
 * @param {string} userId
 */
function startUserPolling(userId) {
  if (activeTimers.has(userId)) return;

  // Immediate poll so UI sees data quickly
  pollUserStrain(userId);

  const handle = setInterval(() => pollUserStrain(userId), POLL_INTERVAL);
  activeTimers.set(userId, handle);
  console.log(`Started strain polling for user ${userId}`);
}

/**
 * Stop polling for a given user.
 * @param {string} userId
 */
function stopUserPolling(userId) {
  const handle = activeTimers.get(userId);
  if (!handle) return;
  clearInterval(handle);
  activeTimers.delete(userId);
  console.log(`Stopped strain polling for user ${userId}`);
}

/**
 * Bootstrap polling for users that were enabled prior to server restart.
 * @param {string[]} userIds
 */
function bootstrap(userIds = []) {
  userIds.forEach(startUserPolling);
}

/**
 * Stop all active polling timers.
 */
function shutdown() {
  for (const [userId, handle] of activeTimers) {
    clearInterval(handle);
    console.log(`Stopped strain polling for user ${userId}`);
  }
  activeTimers.clear();
}

module.exports = {
  startUserPolling,
  stopUserPolling,
  bootstrap,
  shutdown,
  strainEmitter,
};