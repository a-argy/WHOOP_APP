require('dotenv').config({ path: '../../.env' });
const tokenStorage = require('../utils/tokenStorage');
const { makeWhoopApiCall } = require('../utils/whoop');
const { sendToFoundry } = require('../utils/foundry');
const { EventEmitter } = require('events');

const POLL_INTERVAL = 1000 * 60 * 10;  // 10 minutes
// In-memory map of userId -> interval handle
const activeTimers = new Map();

// GLOBAL BROADCASTER: This is like a radio station transmitter
// All browser connections "tune in" to this emitter to receive live strain updates
const strainEmitter = new EventEmitter();

/**
 * BACKGROUND WORKER: Polls strain data for a single user and broadcasts results
 * This runs on a timer every 10 minutes, independent of whether browsers are connected
 * @param {string} userId - User ID to poll
 * @returns {Promise<Object|null>} - Strain data or null if no data
 */
async function pollUserStrain(userId) {
  try {
    // FETCH: Get latest strain data from WHOOP API
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
      
      // STORE: Send strain data to Foundry for permanent storage
      await sendToFoundry("strain", strainData);
      console.log(`Strain for user ${userId}: ${strainData.strain}`);

      // BROADCAST: Send to ALL connected browsers immediately (real-time updates)
      // This triggers every browser's "send" function that was registered in /events/strain
      // Think of this as the DJ making an announcement - all radios tuned in will hear it
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
 * TIMER MANAGEMENT: Start polling for a single user if not already active
 * Creates a repeating timer that fetches strain data every 10 minutes
 * @param {string} userId
 */
function startUserPolling(userId) {
  if (activeTimers.has(userId)) return;  // Don't create duplicate timers

  // IMMEDIATE FETCH: Get data right away so UI shows something instantly
  pollUserStrain(userId);

  // SCHEDULE REPEATING: Set up timer to fetch new data every 10 minutes
  // This runs in the background whether browsers are connected or not
  const handle = setInterval(() => pollUserStrain(userId), POLL_INTERVAL);
  activeTimers.set(userId, handle);  // Remember this timer so we can stop it later
  console.log(`Started strain polling for user ${userId}`);
}

/**
 * TIMER CLEANUP: Stop polling for a given user
 * Cancels the repeating timer to prevent unnecessary API calls
 * @param {string} userId
 */
function stopUserPolling(userId) {
  const handle = activeTimers.get(userId);
  if (!handle) return;  // Timer doesn't exist, nothing to stop
  
  clearInterval(handle);  // Cancel the repeating timer
  activeTimers.delete(userId);  // Remove from our tracking map
  console.log(`Stopped strain polling for user ${userId}`);
}

/**
 * STARTUP RECOVERY: Bootstrap polling for users that were enabled prior to server restart
 * When server restarts, we lose all timers but tokens persist - this rebuilds the timers
 * @param {string[]} userIds
 */
function bootstrap(userIds = []) {
  userIds.forEach(startUserPolling);
}

/**
 * SHUTDOWN CLEANUP: Stop all active polling timers
 * Called during graceful shutdown to prevent timers from running in a dying process
 */
function shutdown() {
  for (const [userId, handle] of activeTimers) {
    clearInterval(handle);
    console.log(`Stopped strain polling for user ${userId}`);
  }
  activeTimers.clear();  // Clear the tracking map
}

module.exports = {
  startUserPolling,
  stopUserPolling,
  bootstrap,
  shutdown,
  strainEmitter,
};