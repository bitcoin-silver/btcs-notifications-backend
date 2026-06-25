const axios = require('axios');
const logger = require('./logger');
require('dotenv').config();

// LiveCoinWatch API Configuration
const LIVECOINWATCH_API_URL = 'https://api.livecoinwatch.com/coins/single';
const LIVECOINWATCH_API_KEY = process.env.LIVECOINWATCH_API_KEY;
const BTCS_CODE = '____BTCS';
const BTC_CODE = 'BTC';

// Cache for prices to avoid over-calling API
let priceCache = {
  BTCS: { price: null, lastUpdate: 0 },
  BTC: { price: null, lastUpdate: 0 }
};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Warn if API key is not configured
if (!LIVECOINWATCH_API_KEY) {
  logger.warn('LIVECOINWATCH_API_KEY not configured - price fetching will fail');
}

/**
 * Fetch a specific coin price from LiveCoinWatch
 * @param {string} code 
 * @returns {Promise<number|null>}
 */
async function fetchCoinPrice(code) {
  try {
    // Check cache first
    const now = Date.now();
    if (priceCache[code] && priceCache[code].price && (now - priceCache[code].lastUpdate < CACHE_TTL)) {
      return priceCache[code].price;
    }

    logger.debug(`Fetching ${code} price from LiveCoinWatch...`);

    const response = await axios.post(
      LIVECOINWATCH_API_URL,
      {
        currency: 'USD',
        code: code,
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
      const price = data.rate ? parseFloat(data.rate) : null;

      if (price !== null) {
        priceCache[code] = {
          price: price,
          lastUpdate: now
        };
        logger.info(`${code} price fetched successfully`, {
          price: formatPrice(price),
          source: 'livecoinwatch'
        });
        return price;
      }
    }
    return null;
  } catch (error) {
    logger.error(`Failed to fetch ${code} price`, { error: error.message });
    return priceCache[code] ? priceCache[code].price : null; // Return stale cache if error
  }
}

/**
 * Fetch current BTCS price
 * @returns {Promise<{price: number, change24h: number|null}>}
 */
async function fetchBTCSPrice() {
  const price = await fetchCoinPrice(BTCS_CODE);
  return price ? { price, change24h: null } : null;
}

/**
 * Fetch current BTC price
 * @returns {Promise<number|null>}
 */
async function fetchBTCPrice() {
  return await fetchCoinPrice(BTC_CODE);
}

/**
 * Get latest prices for both BTCS and BTC
 * @returns {Promise<{BTCS: number|null, BTC: number|null}>}
 */
async function getLatestPrices() {
  const [btcs, btc] = await Promise.all([
    fetchCoinPrice(BTCS_CODE),
    fetchCoinPrice(BTC_CODE)
  ]);
  return { BTCS: btcs, BTC: btc };
}

/**
 * Format price for display
 * @param {number} price
 * @returns {string}
 */
function formatPrice(price) {
  if (price === null || price === undefined) return 'N/A';
  if (price < 0.01) {
    return `$${price.toFixed(8)}`;
  } else if (price < 1) {
    return `$${price.toFixed(4)}`;
  } else if (price > 1000) {
    return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else {
    return `$${price.toFixed(2)}`;
  }
}

module.exports = {
  fetchBTCSPrice,
  fetchBTCPrice,
  getLatestPrices,
  formatPrice
};
