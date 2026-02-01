const admin = require('firebase-admin');
const logger = require('./logger');
const path = require('path');
const { pool } = require('./db');
require('dotenv').config();

// Initialize Firebase Admin SDK
let firebaseInitialized = false;
try {
  const serviceAccountPath = path.join(__dirname, '..', 'firebase-admin-key.json');
  const serviceAccount = require(serviceAccountPath);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  firebaseInitialized = true;
  logger.info('Firebase Admin SDK initialized successfully');
} catch (error) {
  logger.warn('Firebase Admin SDK not initialized', { error: error.message });
  logger.warn('Push notifications will not work until firebase-admin-key.json is added');
}

/**
 * Send push notification via Firebase Cloud Messaging (Admin SDK)
 */
async function sendPushNotification(deviceToken, title, body, data = {}, channelId = 'btcs_transactions') {
  if (!firebaseInitialized) {
    logger.warn('Firebase not initialized, skipping notification');
    return { success: false, error: 'Firebase not configured' };
  }

  const message = {
    token: deviceToken,
    notification: {
      title: title,
      body: body,
    },
    data: data,
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: channelId,
        priority: 'high',
      }
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        }
      }
    }
  };

  try {
    const response = await admin.messaging().send(message);

    logger.info('Notification sent successfully', {
      title,
      messageId: response
    });
    return { success: true, messageId: response };
  } catch (error) {
    logger.error('Failed to send notification', {
      title,
      error: error.message,
      code: error.code
    });
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Notify about incoming transaction to multiple devices
 */
async function notifyIncomingTransaction(devices, txid, address, amount, confirmations = 0) {
  let title, body;

  if (confirmations === 0) {
    // Unconfirmed transaction
    title = 'Incoming Bitcoin Silver';
    body = `${amount} BTCS - Awaiting confirmation`;
  } else {
    // Confirmed transaction
    title = 'Transaction Confirmed!';
    body = `${amount} BTCS confirmed - Balance updated`;
  }

  const data = {
    type: 'incoming_tx',
    txid: txid,
    amount: amount.toString(),
    address: address,
    confirmations: confirmations.toString(),
    timestamp: Date.now().toString(),
  };

  logger.info('Sending incoming transaction notifications', {
    address: address.substring(0, 10) + '...',
    amount,
    deviceCount: devices.length
  });

  const results = [];
  for (const device of devices) {
    const result = await sendPushNotification(device.token, title, body, data);
    results.push({
      token: device.token.substring(0, 20) + '...',
      success: result.success,
      error: result.error
    });

    // Auto-cleanup invalid tokens
    if (!result.success && (
      result.code === 'messaging/registration-token-not-registered' ||
      result.code === 'messaging/invalid-registration-token'
    )) {
      try {
        await pool.query(
          'DELETE FROM device_tokens WHERE device_token = $1',
          [device.token]
        );
        logger.info('Removed invalid token from database', {
          token: device.token.substring(0, 20) + '...'
        });
      } catch (dbError) {
        logger.error('Failed to remove invalid token', { error: dbError.message });
      }
    }

    // Small delay between notifications to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const successCount = results.filter(r => r.success).length;
  logger.info('Notification batch completed', {
    total: results.length,
    successful: successCount,
    failed: results.length - successCount
  });

  return results;
}

/**
 * Notify about transaction confirmation
 */
async function notifyTransactionConfirmed(devices, txid, address, confirmations) {
  const title = 'Transaction Confirmed';
  const body = `Your transaction has ${confirmations} confirmation${confirmations > 1 ? 's' : ''}`;
  const data = {
    type: 'tx_confirmed',
    txid: txid,
    address: address,
    confirmations: confirmations.toString(),
    timestamp: Date.now().toString(),
  };

  logger.info('Sending confirmation notifications', {
    txid: txid.substring(0, 10) + '...',
    confirmations,
    deviceCount: devices.length
  });

  const results = [];
  for (const device of devices) {
    const result = await sendPushNotification(device.token, title, body, data);
    results.push(result);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return results;
}

/**
 * Send test notification
 */
async function sendTestNotification(deviceToken) {
  const title = 'BTCS Wallet Test';
  const body = 'Push notifications are working! 🎉';
  const data = {
    type: 'test',
    timestamp: Date.now().toString(),
  };

  return await sendPushNotification(deviceToken, title, body, data);
}

/**
 * Send price alert notification
 */
async function sendPriceAlert(deviceToken, currentPrice, oldPrice, percentChange, direction) {
  if (!firebaseInitialized) {
    logger.warn('Firebase not initialized, skipping price alert');
    return false;
  }

  const absChange = Math.abs(percentChange).toFixed(2);
  const emoji = direction === 'increase' ? '📈' : '📉';
  const verb = direction === 'increase' ? 'up' : 'down';

  // Format price intelligently (remove trailing zeros)
  const formatPrice = (price) => {
    if (price >= 1) {
      return price.toFixed(4).replace(/\.?0+$/, '');
    } else if (price >= 0.0001) {
      return price.toFixed(6).replace(/\.?0+$/, '');
    } else {
      return price.toFixed(8).replace(/\.?0+$/, '');
    }
  };

  const formattedCurrentPrice = formatPrice(currentPrice);
  const formattedOldPrice = formatPrice(oldPrice);
  const changeSign = percentChange > 0 ? '+' : '';

  const title = `${emoji} BTCS Price ${direction === 'increase' ? 'Surge' : 'Drop'}!`;
  const body = `${changeSign}${absChange}% in 24h\n$${formattedOldPrice} → $${formattedCurrentPrice}`;

  const data = {
    type: 'price_alert',
    currentPrice: currentPrice.toString(),
    oldPrice: oldPrice.toString(),
    percentChange: percentChange.toString(),
    direction: direction,
    timestamp: Date.now().toString(),
  };

  // Color for notification (green for increase, red for decrease)
  const color = direction === 'increase' ? '#00C853' : '#FF1744';

  const message = {
    token: deviceToken,
    notification: {
      title: title,
      body: body,
    },
    data: data,
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'btcs_price_alerts', // Separate channel for price alerts
        priority: 'high',
        color: color, // Green for increase, red for decrease
        icon: 'ic_notification', // Default app icon
        tag: 'price_alert', // Group price alerts together
      }
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        }
      }
    }
  };

  try {
    const response = await admin.messaging().send(message);

    logger.info('Price alert sent successfully', {
      direction,
      percentChange: `${percentChange.toFixed(2)}%`,
      messageId: response
    });
    return true;
  } catch (error) {
    logger.error('Failed to send price alert', {
      error: error.message,
      code: error.code
    });

    // Auto-cleanup invalid tokens
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
      try {
        await pool.query(
          'DELETE FROM device_tokens WHERE device_token = $1',
          [deviceToken]
        );
        logger.info('Removed invalid token from database');
      } catch (dbError) {
        logger.error('Failed to remove invalid token', { error: dbError.message });
      }
    }

    return false;
  }
}

module.exports = {
  sendPushNotification,
  notifyIncomingTransaction,
  notifyTransactionConfirmed,
  sendTestNotification,
  sendPriceAlert,
};
