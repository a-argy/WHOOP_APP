require('dotenv').config({ path: '../../.env' });

// Get environment variables
const FOUNDRY_STREAM_URI = process.env.FOUNDRY_STREAM_URI;
const FOUNDRY_TOKEN = process.env.FOUNDRY_TOKEN;

// Validate required environment variables
if (!FOUNDRY_STREAM_URI) {
    throw new Error('FOUNDRY_STREAM_URI environment variable is required');
}
if (!FOUNDRY_TOKEN) {
    throw new Error('FOUNDRY_TOKEN environment variable is required');
}

/**
 * Sends data to Foundry datastream
 * @param {string} valueType - Type of data being sent
 * @param {Object} payloadData - Data payload
 * @returns {Promise<boolean>} - Success status
 */
async function sendToFoundry(valueType, payloadData) {
    try {
        // Create record matching the new schema: timestamp, value, payload
        const record = {
            timestamp: new Date().toISOString(),
            value: valueType,
            payload: JSON.stringify(payloadData)
        };

        const sampleData = [record];

        // Create a post request with an array of streaming rows
        const response = await fetch(FOUNDRY_STREAM_URI, {
            method: 'POST',
            headers: {
                Authorization: "Bearer " + FOUNDRY_TOKEN,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ records: sampleData })
        });

        // Check if the request was successful
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'No error text');
            throw new Error(`Foundry API error: ${response.status} - ${errorText}`);
        }
    
        // Log success and return
        console.log('Successfully sent data to Foundry');
        return true;
    } catch (error) {
        console.error('Error sending data to Foundry:', error);
        throw error;
    }
}
  
module.exports = {
    sendToFoundry
};