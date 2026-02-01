const axios = require('axios');
const logger = require('./logger');
require('dotenv').config();

// LiveCoinWatch API Configuration
const LIVECOINWATCH_API_URL = 'https://api.livecoinwatch.com/coins/single';
const LIVECOINWATCH_API_KEY = process.env.LIVECOINWATCH_API_KEY;
const BTCS_CODE = '____BTCS';

// Warn if API key is not configured
if (!LIVECOINWATCH_API_KEY) {
  logger.warn('LIVECOINWATCH_API_KEY not configured - price fetching will fail');
}

/**
 * Fetch current BTCS price from LiveCoinWatch
 * @returns {Promise<{price: number, change24h: number|null}>}
 */
async function fetchBTCSPrice() {
  try {
    logger.debug('Fetching BTCS price from LiveCoinWatch...');

    const response = await axios.post(
      LIVECOINWATCH_API_URL,
      {
        currency: 'USD',
        code: BTCS_CODE,
        meta: true
      },
      {
        headers: {
          'content-type': 'application/json',
          'x-api-key': LIVECOINWATCH_API_KEY
        },
        timeout: 30000 // 30 second timeout
      }
    );

    if (response.status === 200 && response.data) {
      const data = response.data;

      // LiveCoinWatch returns the price in 'rate' field
      const price = data.rate ? parseFloat(data.rate) : null;

      if (price === null) {
        logger.warn('LiveCoinWatch response missing price data');
        return null;
      }

      logger.info('BTCS price fetched successfully', {
        price: `$${price.toFixed(8)}`,
        source: 'livecoinwatch'
      });

      return {
        price: price,
        change24h: null // LiveCoinWatch might provide this, check response
      };
    } else {
      logger.error('LiveCoinWatch API returned unexpected status', {
        status: response.status
      });
      return null;
    }

  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      logger.error('LiveCoinWatch API request timed out');
    } else if (error.response) {
      logger.error('LiveCoinWatch API error', {
        status: error.response.status,
        data: error.response.data
      });
    } else {
      logger.error('Failed to fetch BTCS price', {
        error: error.message
      });
    }
    return null;
  }
}

/**
 * Format price for display
 * @param {number} price
 * @returns {string}
 */
function formatPrice(price) {
  if (price < 0.01) {
    return `$${price.toFixed(8)}`;
  } else if (price < 1) {
    return `$${price.toFixed(4)}`;
  } else {
    return `$${price.toFixed(2)}`;
  }
}

module.exports = {
  fetchBTCSPrice,
  formatPrice
};
