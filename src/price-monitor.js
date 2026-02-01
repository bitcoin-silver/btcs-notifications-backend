const logger = require('./logger');
const { fetchBTCSPrice, formatPrice } = require('./price-api');
const {
  savePriceHistory,
  getPrice24hAgo,
  getDevicesWithPriceAlerts,
  logPriceNotification,
  wasRecentPriceAlertSent,
  cleanupOldPriceHistory,
  pool
} = require('./db');
const { sendPriceAlert, sendPushNotification } = require('./notification-service');

// Price monitoring configuration
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ALERT_THRESHOLD_PERCENT = 30; // Alert when price changes >30%
const COOLDOWN_HOURS = 3; // Don't send duplicate alerts within 3 hours

let monitoringInterval = null;
let isMonitoring = false;

/**
 * Calculate percentage change between two prices
 */
function calculatePercentChange(oldPrice, newPrice) {
  if (oldPrice === 0) return 0;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

/**
 * Check price and send alerts if threshold is exceeded
 */
async function checkPriceAndAlert() {
  try {
    logger.debug('Checking BTCS price...');

    // Fetch current price
    const priceData = await fetchBTCSPrice();
    if (!priceData || !priceData.price) {
      logger.warn('Failed to fetch current price, skipping check');
      return;
    }

    const currentPrice = priceData.price;

    // Save to history
    await savePriceHistory(currentPrice);

    // Get price from 24 hours ago
    const price24hAgo = await getPrice24hAgo();

    if (!price24hAgo) {
      logger.info('No 24h historical data yet, waiting for more data', {
        currentPrice: formatPrice(currentPrice)
      });
      return;
    }

    // Calculate percentage change
    const percentChange = calculatePercentChange(price24hAgo, currentPrice);
    const absPercentChange = Math.abs(percentChange);

    logger.info('Price check complete', {
      currentPrice: formatPrice(currentPrice),
      price24hAgo: formatPrice(price24hAgo),
      change: `${percentChange > 0 ? '+' : ''}${percentChange.toFixed(2)}%`
    });

    // Check if threshold exceeded
    if (absPercentChange >= ALERT_THRESHOLD_PERCENT) {
      const direction = percentChange > 0 ? 'increase' : 'decrease';

      logger.info(`🚨 Price alert triggered! ${direction.toUpperCase()} of ${absPercentChange.toFixed(2)}%`);

      // Check if we already sent a similar alert recently (avoid spam)
      const recentlySent = await wasRecentPriceAlertSent(direction, COOLDOWN_HOURS);

      if (recentlySent) {
        logger.info('Similar alert sent recently, skipping to avoid spam');
        return;
      }

      // Get all devices with price alerts enabled
      const devices = await getDevicesWithPriceAlerts();

      if (devices.length === 0) {
        logger.info('No devices with price alerts enabled');
        return;
      }

      logger.info(`Sending price alert to ${devices.length} device(s)`);

      // Send notifications to all eligible devices
      let successCount = 0;
      for (const device of devices) {
        const sent = await sendPriceAlert(
          device.token,
          currentPrice,
          price24hAgo,
          percentChange,
          direction
        );
        if (sent) successCount++;
      }

      // Log the price notification
      await logPriceNotification(currentPrice, percentChange, direction, successCount);

      logger.info(`Price alert sent successfully to ${successCount}/${devices.length} devices`);
    }

  } catch (error) {
    logger.error('Error in price monitoring', { error: error.message });
  }
}

/**
 * Calculate milliseconds until next 12pm GMT
 */
function getMillisecondsUntilNextNoon() {
  const now = new Date();
  const nextNoon = new Date();

  // Set to 12:00:00 GMT today
  nextNoon.setUTCHours(12, 0, 0, 0);

  // If it's already past 12pm GMT today, set to tomorrow
  if (now >= nextNoon) {
    nextNoon.setUTCDate(nextNoon.getUTCDate() + 1);
  }

  const msUntilNoon = nextNoon.getTime() - now.getTime();
  return msUntilNoon;
}

/**
 * Send daily price broadcast to all registered devices
 */
async function sendDailyPriceBroadcast() {
  try {
    logger.info('🔔 Running daily price broadcast at 12pm GMT...');

    // Fetch current price
    const priceData = await fetchBTCSPrice();
    if (!priceData || !priceData.price) {
      logger.warn('Failed to fetch current price for daily broadcast');
      return;
    }

    const currentPrice = priceData.price;

    // Get price from 24 hours ago for comparison
    const price24hAgo = await getPrice24hAgo();

    let title = '📊 Daily BTCS Price Update';
    let body;

    if (price24hAgo) {
      const percentChange = calculatePercentChange(price24hAgo, currentPrice);
      const changeSign = percentChange > 0 ? '+' : '';
      const changeEmoji = percentChange > 0 ? '📈' : percentChange < 0 ? '📉' : '➡️';

      body = `${changeEmoji} Current: ${formatPrice(currentPrice)}\n24h change: ${changeSign}${percentChange.toFixed(2)}%`;
    } else {
      body = `Current price: ${formatPrice(currentPrice)}`;
    }

    // Get all device tokens from database
    const result = await pool.query('SELECT device_token FROM device_tokens');
    const devices = result.rows;

    if (devices.length === 0) {
      logger.info('No devices registered for daily broadcast');
      return;
    }

    logger.info(`Sending daily price broadcast to ${devices.length} device(s)`);

    // Send to all devices
    let successCount = 0;
    let failedCount = 0;

    for (const device of devices) {
      const result = await sendPushNotification(
        device.device_token,
        title,
        body,
        {
          type: 'daily_price',
          price: currentPrice.toString(),
          timestamp: Date.now().toString()
        }
      );

      if (result.success) {
        successCount++;
      } else {
        failedCount++;

        // Auto-cleanup invalid tokens
        if (result.code === 'messaging/registration-token-not-registered' ||
            result.code === 'messaging/invalid-registration-token') {
          try {
            await pool.query(
              'DELETE FROM device_tokens WHERE device_token = $1',
              [device.device_token]
            );
            logger.info('Removed invalid token from database during daily broadcast');
          } catch (dbError) {
            logger.error('Failed to remove invalid token', { error: dbError.message });
          }
        }
      }

      // Small delay between notifications to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info(`✓ Daily price broadcast completed: ${successCount} sent, ${failedCount} failed`);

  } catch (error) {
    logger.error('Error in daily price broadcast', { error: error.message });
  }
}

/**
 * Schedule daily price broadcast at 12pm GMT
 */
function scheduleDailyBroadcast() {
  const scheduleNext = () => {
    const msUntilNoon = getMillisecondsUntilNextNoon();
    const hoursUntil = (msUntilNoon / (1000 * 60 * 60)).toFixed(1);

    logger.info(`📅 Next daily price broadcast scheduled in ${hoursUntil} hours (12pm GMT)`);

    setTimeout(async () => {
      await sendDailyPriceBroadcast();
      // Schedule the next one for tomorrow
      scheduleNext();
    }, msUntilNoon);
  };

  // Start the scheduling
  scheduleNext();
}

/**
 * Start price monitoring service
 */
function startMonitoring() {
  if (isMonitoring) {
    logger.warn('Price monitoring already running');
    return;
  }

  logger.info('Starting price monitoring service', {
    interval: `${CHECK_INTERVAL_MS / 1000 / 60} minutes`,
    threshold: `${ALERT_THRESHOLD_PERCENT}%`,
    cooldown: `${COOLDOWN_HOURS} hours`
  });

  // Run immediately on start
  checkPriceAndAlert();

  // Then run at intervals
  monitoringInterval = setInterval(checkPriceAndAlert, CHECK_INTERVAL_MS);
  isMonitoring = true;

  // Cleanup old price history daily
  const cleanupInterval = 24 * 60 * 60 * 1000; // 24 hours
  setInterval(async () => {
    logger.info('Running daily price history cleanup...');
    await cleanupOldPriceHistory();
  }, cleanupInterval);

  // Schedule daily price broadcasts at 12pm GMT
  scheduleDailyBroadcast();

  logger.info('✓ Price monitoring service started successfully');
}

/**
 * Stop price monitoring service
 */
function stopMonitoring() {
  if (!isMonitoring) {
    logger.warn('Price monitoring not running');
    return;
  }

  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }

  isMonitoring = false;
  logger.info('✓ Price monitoring service stopped');
}

/**
 * Get monitoring status
 */
function getStatus() {
  return {
    isMonitoring,
    checkIntervalMinutes: CHECK_INTERVAL_MS / 1000 / 60,
    alertThresholdPercent: ALERT_THRESHOLD_PERCENT,
    cooldownHours: COOLDOWN_HOURS
  };
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  checkPriceAndAlert,
  getStatus,
  sendDailyPriceBroadcast
};
