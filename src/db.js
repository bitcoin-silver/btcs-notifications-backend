const { Pool } = require('pg');
const logger = require('./logger');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Test connection on startup
pool.on('connect', () => {
  logger.info('Database connection established');
});

pool.on('error', (err) => {
  logger.error('Unexpected database error', { error: err.message });
});

/**
 * Register or update a device token for an address
 */
async function registerDevice(address, deviceToken, platform = 'android') {
  const query = `
    INSERT INTO device_tokens (address, device_token, platform, last_active)
    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    ON CONFLICT (address, device_token)
    DO UPDATE SET last_active = CURRENT_TIMESTAMP
    RETURNING id
  `;

  try {
    const result = await pool.query(query, [address, deviceToken, platform]);
    logger.info('Device registered', {
      address: address.substring(0, 10) + '...',
      id: result.rows[0].id
    });
    return result.rows[0];
  } catch (error) {
    logger.error('Failed to register device', {
      error: error.message,
      address: address.substring(0, 10) + '...'
    });
    throw error;
  }
}

/**
 * Get all device tokens for a specific address
 */
async function getDeviceTokensByAddress(address) {
  const query = 'SELECT device_token, platform FROM device_tokens WHERE address = $1';

  try {
    const result = await pool.query(query, [address]);
    return result.rows.map(row => ({
      token: row.device_token,
      platform: row.platform
    }));
  } catch (error) {
    logger.error('Failed to get device tokens', { error: error.message });
    throw error;
  }
}

/**
 * Remove a device token
 */
async function unregisterDevice(address, deviceToken) {
  const query = 'DELETE FROM device_tokens WHERE address = $1 AND device_token = $2';

  try {
    const result = await pool.query(query, [address, deviceToken]);
    logger.info('Device unregistered', {
      address: address.substring(0, 10) + '...',
      deleted: result.rowCount
    });
    return result.rowCount > 0;
  } catch (error) {
    logger.error('Failed to unregister device', { error: error.message });
    throw error;
  }
}

/**
 * Log a notification in the database
 */
async function logNotification(address, txid, amount, sent = true) {
  const query = `
    INSERT INTO notifications (address, txid, amount, sent, created_at)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    ON CONFLICT (address, txid)
    DO UPDATE SET sent = $4
    RETURNING id
  `;

  try {
    const result = await pool.query(query, [address, txid, amount, sent]);
    return result.rows[0];
  } catch (error) {
    logger.error('Failed to log notification', { error: error.message, txid });
    throw error;
  }
}

/**
 * Update notification confirmation status
 */
async function markAsConfirmed(txid) {
  const query = 'UPDATE notifications SET confirmed = true WHERE txid = $1';

  try {
    await pool.query(query, [txid]);
  } catch (error) {
    logger.error('Failed to mark as confirmed', { error: error.message, txid });
  }
}

/**
 * Get notification history for an address
 */
async function getNotificationHistory(address, limit = 50) {
  const query = `
    SELECT txid, amount, confirmed, sent, created_at
    FROM notifications
    WHERE address = $1
    ORDER BY created_at DESC
    LIMIT $2
  `;

  try {
    const result = await pool.query(query, [address, limit]);
    return result.rows;
  } catch (error) {
    logger.error('Failed to get notification history', { error: error.message });
    throw error;
  }
}

/**
 * Get statistics
 */
async function getStats() {
  try {
    const deviceCount = await pool.query('SELECT COUNT(*) FROM device_tokens');
    const uniqueAddresses = await pool.query('SELECT COUNT(DISTINCT address) FROM device_tokens');
    const notificationCount = await pool.query('SELECT COUNT(*) FROM notifications');
    const todayNotifications = await pool.query(
      "SELECT COUNT(*) FROM notifications WHERE created_at > CURRENT_DATE"
    );

    return {
      total_devices: parseInt(deviceCount.rows[0].count),
      unique_addresses: parseInt(uniqueAddresses.rows[0].count),
      total_notifications: parseInt(notificationCount.rows[0].count),
      today_notifications: parseInt(todayNotifications.rows[0].count)
    };
  } catch (error) {
    logger.error('Failed to get stats', { error: error.message });
    throw error;
  }
}

// ==================== PRICE ALERT FUNCTIONS ====================

/**
 * Save price to history
 */
async function savePriceHistory(price, change24h = null) {
  const query = `
    INSERT INTO price_history (price, change_24h, timestamp)
    VALUES ($1, $2, CURRENT_TIMESTAMP)
    RETURNING id
  `;

  try {
    const result = await pool.query(query, [price, change24h]);
    logger.debug('Price saved to history', { price, id: result.rows[0].id });
    return result.rows[0];
  } catch (error) {
    logger.error('Failed to save price history', { error: error.message });
    throw error;
  }
}

/**
 * Get price from 24 hours ago
 */
async function getPrice24hAgo() {
  const query = `
    SELECT price
    FROM price_history
    WHERE timestamp <= NOW() - INTERVAL '24 hours'
    ORDER BY timestamp DESC
    LIMIT 1
  `;

  try {
    const result = await pool.query(query);
    if (result.rows.length > 0) {
      return parseFloat(result.rows[0].price);
    }
    return null;
  } catch (error) {
    logger.error('Failed to get 24h price', { error: error.message });
    throw error;
  }
}

/**
 * Get all devices with price alerts enabled
 */
async function getDevicesWithPriceAlerts() {
  const query = `
    SELECT DISTINCT device_token, platform
    FROM device_tokens
    WHERE price_alerts_enabled = true
  `;

  try {
    const result = await pool.query(query);
    return result.rows.map(row => ({
      token: row.device_token,
      platform: row.platform
    }));
  } catch (error) {
    logger.error('Failed to get devices with price alerts', { error: error.message });
    throw error;
  }
}

/**
 * Enable/disable price alerts for a device
 */
async function updatePriceAlertStatus(address, deviceToken, enabled) {
  const query = `
    UPDATE device_tokens
    SET price_alerts_enabled = $3
    WHERE address = $1 AND device_token = $2
    RETURNING id
  `;

  try {
    const result = await pool.query(query, [address, deviceToken, enabled]);
    logger.info('Price alert status updated', {
      address: address.substring(0, 10) + '...',
      enabled
    });
    return result.rowCount > 0;
  } catch (error) {
    logger.error('Failed to update price alert status', { error: error.message });
    throw error;
  }
}

/**
 * Enable/disable chat notifications for a device
 */
async function updateChatNotificationStatus(address, deviceToken, enabled) {
  const query = `
    UPDATE device_tokens
    SET chat_notifications_enabled = $3
    WHERE address = $1 AND device_token = $2
    RETURNING id
  `;

  try {
    const result = await pool.query(query, [address, deviceToken, enabled]);
    logger.info('Chat notification status updated', {
      address: address.substring(0, 10) + '...',
      enabled
    });
    return result.rowCount > 0;
  } catch (error) {
    logger.error('Failed to update chat notification status', { error: error.message });
    throw error;
  }
}

/**
 * Get all devices with chat notifications enabled
 */
async function getDevicesWithChatNotifications() {
  const query = `
    SELECT DISTINCT device_token, platform, address
    FROM device_tokens
    WHERE chat_notifications_enabled = true
  `;

  try {
    const result = await pool.query(query);
    return result.rows.map(row => ({
      token: row.device_token,
      platform: row.platform,
      address: row.address
    }));
  } catch (error) {
    logger.error('Failed to get devices with chat notifications', { error: error.message });
    throw error;
  }
}

/**
 * Log a price notification
 */
async function logPriceNotification(price, changePercent, direction, devicesNotified) {
  const query = `
    INSERT INTO price_notifications (price, change_percent, direction, devices_notified)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `;

  try {
    const result = await pool.query(query, [price, changePercent, direction, devicesNotified]);
    logger.info('Price notification logged', {
      id: result.rows[0].id,
      changePercent: `${changePercent}%`,
      direction
    });
    return result.rows[0];
  } catch (error) {
    logger.error('Failed to log price notification', { error: error.message });
    throw error;
  }
}

/**
 * Check if price alert was recently sent (to avoid spam)
 */
async function wasRecentPriceAlertSent(direction, hoursAgo = 24) {
  // Use parameterized interval to avoid SQL interpolation
  const query = `
    SELECT id
    FROM price_notifications
    WHERE direction = $1
    AND created_at > NOW() - ($2 || ' hours')::INTERVAL
    ORDER BY created_at DESC
    LIMIT 1
  `;

  try {
    const result = await pool.query(query, [direction, hoursAgo.toString()]);
    return result.rows.length > 0;
  } catch (error) {
    logger.error('Failed to check recent price alerts', { error: error.message });
    return false;
  }
}

/**
 * Clean up old price history (keep last 30 days)
 */
async function cleanupOldPriceHistory() {
  const query = `
    DELETE FROM price_history
    WHERE timestamp < NOW() - INTERVAL '30 days'
  `;

  try {
    const result = await pool.query(query);
    if (result.rowCount > 0) {
      logger.info('Cleaned up old price history', { deleted: result.rowCount });
    }
  } catch (error) {
    logger.error('Failed to cleanup price history', { error: error.message });
  }
}

// ==================== CHAT FUNCTIONS ====================

/**
 * Save a chat message
 */
async function saveChatMessage({ wallet_address, nickname, message, message_type = 'user' }) {
  const query = `
    INSERT INTO chat_messages (wallet_address, nickname, message, message_type, timestamp)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    RETURNING id, wallet_address, nickname, message, message_type, timestamp
  `;

  try {
    const result = await pool.query(query, [wallet_address, nickname, message, message_type]);
    logger.info('Chat message saved', {
      id: result.rows[0].id,
      sender: wallet_address.substring(0, 10) + '...'
    });
    return result.rows[0];
  } catch (error) {
    logger.error('Failed to save chat message', { error: error.message });
    throw error;
  }
}

/**
 * Get chat message history
 */
async function getChatHistory(limit = 100, offset = 0) {
  const query = `
    SELECT id, wallet_address, nickname, message, message_type, timestamp
    FROM chat_messages
    ORDER BY timestamp DESC
    LIMIT $1 OFFSET $2
  `;

  try {
    const result = await pool.query(query, [limit, offset]);
    return result.rows;
  } catch (error) {
    logger.error('Failed to get chat history', { error: error.message });
    throw error;
  }
}

/**
 * Set user nickname
 */
async function setUserNickname(wallet_address, nickname) {
  const query = `
    INSERT INTO user_nicknames (wallet_address, nickname, updated_at)
    VALUES ($1, $2, CURRENT_TIMESTAMP)
    ON CONFLICT (wallet_address)
    DO UPDATE SET nickname = $2, updated_at = CURRENT_TIMESTAMP
    RETURNING wallet_address, nickname
  `;

  try {
    const result = await pool.query(query, [wallet_address, nickname]);
    logger.info('User nickname set', {
      address: wallet_address.substring(0, 10) + '...',
      nickname
    });
    return result.rows[0];
  } catch (error) {
    logger.error('Failed to set nickname', { error: error.message });
    throw error;
  }
}

/**
 * Get user nickname by wallet address
 */
async function getUserNickname(wallet_address) {
  const query = 'SELECT nickname FROM user_nicknames WHERE wallet_address = $1';

  try {
    const result = await pool.query(query, [wallet_address]);
    return result.rows.length > 0 ? result.rows[0].nickname : null;
  } catch (error) {
    logger.error('Failed to get nickname', { error: error.message });
    return null;
  }
}

/**
 * Get all device tokens (for broadcasting push notifications)
 */
async function getAllDeviceTokens() {
  const query = `
    SELECT DISTINCT address, device_token, platform
    FROM device_tokens
    WHERE last_active > NOW() - INTERVAL '30 days'
  `;

  try {
    const result = await pool.query(query);
    return result.rows;
  } catch (error) {
    logger.error('Failed to get all device tokens', { error: error.message });
    throw error;
  }
}

/**
 * Delete a chat message (admin/moderation)
 */
async function deleteChatMessage(messageId) {
  const query = 'DELETE FROM chat_messages WHERE id = $1 RETURNING id';

  try {
    const result = await pool.query(query, [messageId]);
    if (result.rowCount > 0) {
      logger.info('Chat message deleted', { id: messageId });
      return true;
    }
    return false;
  } catch (error) {
    logger.error('Failed to delete chat message', { error: error.message });
    throw error;
  }
}

/**
 * Get chat statistics
 */
async function getChatStats() {
  try {
    const totalMessages = await pool.query('SELECT COUNT(*) FROM chat_messages');
    const uniqueUsers = await pool.query('SELECT COUNT(DISTINCT wallet_address) FROM chat_messages WHERE message_type = \'user\'');
    const todayMessages = await pool.query(
      "SELECT COUNT(*) FROM chat_messages WHERE timestamp > CURRENT_DATE"
    );
    const latestMessage = await pool.query(
      'SELECT timestamp FROM chat_messages ORDER BY timestamp DESC LIMIT 1'
    );

    return {
      total_messages: parseInt(totalMessages.rows[0].count),
      total_users: parseInt(uniqueUsers.rows[0].count),
      today_messages: parseInt(todayMessages.rows[0].count),
      latest_message: latestMessage.rows.length > 0 ? latestMessage.rows[0].timestamp : null
    };
  } catch (error) {
    logger.error('Failed to get chat stats', { error: error.message });
    throw error;
  }
}

module.exports = {
  pool,
  registerDevice,
  getDeviceTokensByAddress,
  unregisterDevice,
  logNotification,
  markAsConfirmed,
  getNotificationHistory,
  getStats,
  // Price alert functions
  savePriceHistory,
  getPrice24hAgo,
  getDevicesWithPriceAlerts,
  updatePriceAlertStatus,
  logPriceNotification,
  wasRecentPriceAlertSent,
  cleanupOldPriceHistory,
  // Chat functions
  saveChatMessage,
  getChatHistory,
  setUserNickname,
  getUserNickname,
  getAllDeviceTokens,
  deleteChatMessage,
  getChatStats,
  updateChatNotificationStatus,
  getDevicesWithChatNotifications,
};
