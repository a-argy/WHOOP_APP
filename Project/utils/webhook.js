const crypto = require('crypto');
const CLIENT_SECRET = process.env.CLIENT_SECRET;

if (!CLIENT_SECRET) {
    throw new Error('CLIENT_SECRET environment variable is required');
}

/**
 * Validates webhook signature using HMAC SHA256
 * @param {string} timestamp - Webhook timestamp
 * @param {Object} body - request body
 * @param {string} signature - Provided signature
 * @param {string} secret - Secret key for validation
 * @returns {boolean} - True if signature is valid
 */
function validateWebhookSignature(timestamp, body, signature) {
    const rawBody = body.toString();
    const calculatedSignature = crypto
        .createHmac('sha256', CLIENT_SECRET)
        .update(timestamp + rawBody)
        .digest('base64');
    return calculatedSignature === signature;
}

module.exports = {
  validateWebhookSignature
};