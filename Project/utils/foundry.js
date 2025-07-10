/**
 * Sends data to Foundry datastream
 * @param {string} valueType - Type of data being sent
 * @param {Object} payloadData - Data payload
 * @param {string} streamUrl - Foundry stream URL
 * @param {string} token - Foundry access token
 * @returns {Promise<boolean>} - Success status
 */
async function sendToFoundry(valueType, payloadData, streamUrl, token) {
    try {
        // Create record matching the new schema: timestamp, value, payload
        const record = {
            timestamp: new Date().toISOString(),
            value: valueType,
            payload: JSON.stringify(payloadData)
        };

        const sampleData = [record];

        // Create a post request with an array of streaming rows
        const response = await fetch(streamUrl, {
            method: 'POST',
            headers: {
                Authorization: "Bearer " + foundryToken,
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