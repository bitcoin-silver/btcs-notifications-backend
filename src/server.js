const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const {
  registerDevice,
  unregisterDevice,
  getNotificationHistory,
  getStats,
  updatePriceAlertStatus,
  updateChatNotificationStatus,
  pool,
  // Chat functions
  saveChatMessage,
  getChatHistory,
  setUserNickname,
  getUserNickname,
  getChatStats
} = require('./db');
const {
  testConnection,
  startMonitoring,
  getMonitoringStatus,
  getBlockchainInfo
} = require('./bitcoin-monitor');
const { sendTestNotification } = require('./notification-service');
const priceMonitor = require('./price-monitor');
const websocketServer = require('./websocket-server');
const logger = require('./logger');
const geoip = require('geoip-lite');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy - needed when behind nginx
app.set('trust proxy', 1);

// Rate limiting configuration
const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 registration requests per windowMs
  message: {
    error: 'Too many registration requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path
    });
    res.status(429).json({
      error: 'Too many requests, please try again later.'
    });
  }
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 requests per minute
  message: {
    error: 'Too many requests from this IP, please slow down.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Middleware
// Security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for landing page
      scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for landing page
      connectSrc: ["'self'", "wss:", "ws:"], // Allow WebSocket connections
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false, // Disable for WebSocket compatibility
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  }
}));

// Additional security headers
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});
app.use(cors());
app.use(express.json());
app.use(generalLimiter); // Apply general rate limiting to all routes

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Key authentication middleware
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== process.env.API_KEY) {
    logger.warn('Unauthorized API request', {
      ip: req.ip,
      path: req.path,
      hasKey: !!apiKey
    });
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or missing API key'
    });
  }

  next();
};

// Request logging middleware
app.use((req, res, next) => {
  logger.info('Incoming request', {
    method: req.method,
    path: req.path,
    ip: req.ip
  });
  next();
});

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
  try {
    // Check database
    await pool.query('SELECT 1');
    const dbStatus = 'ok';

    // Check Bitcoin node
    const blockchainInfo = await getBlockchainInfo();
    const nodeStatus = blockchainInfo.blocks > 0 ? 'ok' : 'error';

    // Check monitoring status
    const monitorStatus = getMonitoringStatus();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        bitcoin_node: nodeStatus,
        monitoring: monitorStatus.isActive ? 'active' : 'inactive',
      },
      blockchain: {
        chain: blockchainInfo.chain,
        blocks: blockchainInfo.blocks,
        headers: blockchainInfo.headers,
        synced: !blockchainInfo.initialblockdownload,
        verification_progress: (blockchainInfo.verificationprogress * 100).toFixed(2) + '%'
      }
    });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Register device token for notifications
 */
app.post('/api/register', apiKeyAuth, registrationLimiter, async (req, res) => {
  try {
    const { address, device_token, platform } = req.body;

    // Validation
    if (!address || !device_token) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: address, device_token'
      });
    }

    // Validate address format (basic check)
    if (typeof address !== 'string' || address.length < 26) {
      return res.status(400).json({
        success: false,
        error: 'Invalid address format'
      });
    }

    // Register device
    const result = await registerDevice(address, device_token, platform || 'android');

    res.json({
      success: true,
      message: 'Device registered successfully',
      id: result.id
    });
  } catch (error) {
    logger.error('Registration error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Unregister device token
 */
app.post('/api/unregister', apiKeyAuth, async (req, res) => {
  try {
    const { address, device_token } = req.body;

    if (!address || !device_token) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: address, device_token'
      });
    }

    const success = await unregisterDevice(address, device_token);

    res.json({
      success: success,
      message: success ? 'Device unregistered successfully' : 'Device not found'
    });
  } catch (error) {
    logger.error('Unregister error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Get notification history for an address
 */
app.get('/api/notifications/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    if (!address) {
      return res.status(400).json({
        success: false,
        error: 'Address is required'
      });
    }

    const notifications = await getNotificationHistory(address, limit);

    res.json({
      success: true,
      count: notifications.length,
      notifications: notifications
    });
  } catch (error) {
    logger.error('Fetch notifications error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Get server statistics
 */
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    const monitorStatus = getMonitoringStatus();
    const blockchainInfo = await getBlockchainInfo();

    res.json({
      success: true,
      stats: {
        ...stats,
        monitoring_active: monitorStatus.isActive,
        blockchain_height: blockchainInfo.blocks,
        blockchain_synced: !blockchainInfo.initialblockdownload
      }
    });
  } catch (error) {
    logger.error('Stats error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Send test notification
 */
/* 
app.post('/api/test-notification', async (req, res) => {
  try {
    const { device_token } = req.body;

    if (!device_token) {
      return res.status(400).json({
        success: false,
        error: 'device_token is required'
      });
    }

    const result = await sendTestNotification(device_token);

    res.json({
      success: result.success,
      message: result.success ? 'Test notification sent' : 'Failed to send notification',
      details: result
    });
  } catch (error) {
    logger.error('Test notification error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});
*/

/**
 * Broadcast notification to ALL devices
 */
app.post('/api/broadcast-all', apiKeyAuth, async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        error: 'title and body are required'
      });
    }

    // Get all device tokens from database
    const result = await pool.query('SELECT device_token FROM device_tokens');
    const devices = result.rows;

    if (devices.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No devices registered'
      });
    }

    logger.info('Broadcasting to all devices', {
      deviceCount: devices.length,
      title: title
    });

    // Send notification to all devices
    const { sendPushNotification } = require('./notification-service');

    let successful = 0;
    let failed = 0;

    for (const device of devices) {
      try {
        await sendPushNotification(
          device.device_token,
          title,
          body,
          { type: 'broadcast' }
        );
        successful++;
      } catch (error) {
        logger.error('Failed to send to device', {
          error: error.message,
          code: error.code,
          token: device.device_token.substring(0, 20) + '...'
        });

        // Auto-cleanup invalid tokens
        if (error.code === 'messaging/registration-token-not-registered' ||
            error.code === 'messaging/invalid-registration-token') {
          try {
            await pool.query(
              'DELETE FROM device_tokens WHERE device_token = $1',
              [device.device_token]
            );
            logger.info('Removed invalid token from database', {
              token: device.device_token.substring(0, 20) + '...'
            });
          } catch (dbError) {
            logger.error('Failed to remove invalid token', { error: dbError.message });
          }
        }

        failed++;
      }
    }

    res.json({
      success: true,
      message: 'Broadcast completed',
      total: devices.length,
      successful: successful,
      failed: failed
    });

  } catch (error) {
    logger.error('Broadcast error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== PRICE ALERT ENDPOINTS ====================

/**
 * Enable price alerts for a device
 */
app.post('/api/price-alerts/enable', apiKeyAuth, async (req, res) => {
  try {
    const { address, device_token } = req.body;

    if (!address || !device_token) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: address, device_token'
      });
    }

    const success = await updatePriceAlertStatus(address, device_token, true);

    if (success) {
      res.json({
        success: true,
        message: 'Price alerts enabled successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
  } catch (error) {
    logger.error('Enable price alerts error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Disable price alerts for a device
 */
app.post('/api/price-alerts/disable', apiKeyAuth, async (req, res) => {
  try {
    const { address, device_token } = req.body;

    if (!address || !device_token) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: address, device_token'
      });
    }

    const success = await updatePriceAlertStatus(address, device_token, false);

    if (success) {
      res.json({
        success: true,
        message: 'Price alerts disabled successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
  } catch (error) {
    logger.error('Disable price alerts error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Get price alert status for a device
 */
app.get('/api/price-alerts/status/:address', async (req, res) => {
  try {
    const { address } = req.params;

    if (!address) {
      return res.status(400).json({
        success: false,
        error: 'Address is required'
      });
    }

    const result = await pool.query(
      'SELECT price_alerts_enabled, device_token FROM device_tokens WHERE address = $1',
      [address]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No devices found for this address'
      });
    }

    res.json({
      success: true,
      devices: result.rows.map(row => ({
        device_token: row.device_token.substring(0, 20) + '...',
        price_alerts_enabled: row.price_alerts_enabled
      }))
    });
  } catch (error) {
    logger.error('Get price alert status error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Get price monitoring status (admin endpoint)
 */
app.get('/api/price-monitor/status', async (req, res) => {
  try {
    const status = priceMonitor.getStatus();
    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    logger.error('Price monitor status error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Get current BTCS price
 */
app.get('/api/price/current', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT price, timestamp FROM price_history ORDER BY timestamp DESC LIMIT 1'
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No price data available yet'
      });
    }

    const priceData = result.rows[0];
    res.json({
      success: true,
      price: parseFloat(priceData.price),
      timestamp: priceData.timestamp,
      source: 'livecoinwatch'
    });
  } catch (error) {
    logger.error('Get current price error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Manually trigger daily price broadcast (admin endpoint for testing)
 */
app.post('/api/price-broadcast/trigger', apiKeyAuth, async (req, res) => {
  try {
    logger.info('Manual daily price broadcast triggered via API');

    // Run the daily broadcast immediately
    await priceMonitor.sendDailyPriceBroadcast();

    res.json({
      success: true,
      message: 'Daily price broadcast sent successfully'
    });
  } catch (error) {
    logger.error('Manual price broadcast error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== NODE MAP ENDPOINTS ====================

/**
 * Get peer information with geolocation
 */
app.get('/api/peers', async (req, res) => {
  try {
    // Make direct RPC call using axios
    const rpcUrl = `http://${process.env.BITCOIN_RPC_HOST}:${process.env.BITCOIN_RPC_PORT}`;
    const auth = {
      username: process.env.BITCOIN_RPC_USER,
      password: process.env.BITCOIN_RPC_PASSWORD
    };

    const response = await axios.post(rpcUrl, {
      jsonrpc: '1.0',
      id: 'getpeerinfo',
      method: 'getpeerinfo',
      params: []
    }, {
      auth,
      timeout: 30000
    });

    const peerInfo = response.data.result;

    // Add geolocation to each peer
    const peersWithGeo = peerInfo.map(peer => {
      // Extract IP from "ip:port" format
      let ip = null;
      if (peer.addr) {
        if (peer.addr.startsWith('[')) {
          // IPv6
          const endBracket = peer.addr.indexOf(']');
          if (endBracket !== -1) {
            ip = peer.addr.substring(1, endBracket);
          }
        } else {
          // IPv4
          ip = peer.addr.split(':')[0];
        }
      }

      // Look up geolocation
      let country = null;
      let countryCode = null;
      let lat = null;
      let lon = null;

      if (ip) {
        const geo = geoip.lookup(ip);
        if (geo) {
          countryCode = geo.country;
          country = geo.country;
          if (geo.ll && geo.ll.length === 2) {
            lat = geo.ll[0];
            lon = geo.ll[1];
          }
        }
      }

      return {
        ...peer,
        country,
        countryCode,
        lat,
        lon,
        ip
      };
    });

    res.json({
      peers: peersWithGeo,
      count: peersWithGeo.length
    });
  } catch (error) {
    logger.error('Get peers error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== CHAT ENDPOINTS ====================

/**
 * Get chat message history (API key required for security)
 */
app.get('/api/chat/history', apiKeyAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const messages = await getChatHistory(limit, offset);

    res.json({
      success: true,
      messages: messages.reverse(), // Oldest first
      count: messages.length
    });
  } catch (error) {
    logger.error('Get chat history error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to load chat history'
    });
  }
});

/**
 * Set user nickname (API key required for security)
 */
app.post('/api/chat/set-nickname', apiKeyAuth, async (req, res) => {
  try {
    const { wallet_address, nickname } = req.body;

    if (!wallet_address || !nickname) {
      return res.status(400).json({
        success: false,
        error: 'wallet_address and nickname are required'
      });
    }

    // Validate nickname length
    if (nickname.length < 3 || nickname.length > 20) {
      return res.status(400).json({
        success: false,
        error: 'Nickname must be between 3 and 20 characters'
      });
    }

    // Validate nickname format (alphanumeric and underscores only)
    if (!/^[a-zA-Z0-9_]+$/.test(nickname)) {
      return res.status(400).json({
        success: false,
        error: 'Nickname can only contain letters, numbers, and underscores'
      });
    }

    const result = await setUserNickname(wallet_address, nickname);

    res.json({
      success: true,
      nickname: result.nickname,
      message: 'Nickname set successfully'
    });
  } catch (error) {
    if (error.message.includes('duplicate key')) {
      return res.status(409).json({
        success: false,
        error: 'Nickname already taken'
      });
    }

    logger.error('Set nickname error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to set nickname'
    });
  }
});

/**
 * Get user nickname (API key required for security)
 */
app.get('/api/chat/nickname/:address', apiKeyAuth, async (req, res) => {
  try {
    const { address } = req.params;

    if (!address) {
      return res.status(400).json({
        success: false,
        error: 'Address is required'
      });
    }

    const nickname = await getUserNickname(address);

    if (nickname) {
      res.json({
        success: true,
        nickname
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Nickname not set'
      });
    }
  } catch (error) {
    logger.error('Get nickname error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get nickname'
    });
  }
});

/**
 * Get chat statistics
 */
app.get('/api/chat/stats', async (req, res) => {
  try {
    const stats = await getChatStats();

    res.json({
      success: true,
      ...stats
    });
  } catch (error) {
    logger.error('Get chat stats error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get chat stats'
    });
  }
});

// ==================== CHAT NOTIFICATION ENDPOINTS ====================

/**
 * Enable chat notifications for a device
 */
app.post('/api/chat-notifications/enable', apiKeyAuth, async (req, res) => {
  try {
    const { address, device_token } = req.body;

    if (!address || !device_token) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: address, device_token'
      });
    }

    const success = await updateChatNotificationStatus(address, device_token, true);

    if (success) {
      res.json({
        success: true,
        message: 'Chat notifications enabled successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
  } catch (error) {
    logger.error('Enable chat notifications error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Disable chat notifications for a device
 */
app.post('/api/chat-notifications/disable', apiKeyAuth, async (req, res) => {
  try {
    const { address, device_token } = req.body;

    if (!address || !device_token) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: address, device_token'
      });
    }

    const success = await updateChatNotificationStatus(address, device_token, false);

    if (success) {
      res.json({
        success: true,
        message: 'Chat notifications disabled successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
  } catch (error) {
    logger.error('Disable chat notifications error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Start server
 */
async function start() {
  try {
    logger.info('Starting Bitcoin Silver notification backend...');

    // Test database connection
    await pool.query('SELECT 1');
    logger.info('Database connection verified');

    // Test Bitcoin node connection
    const connected = await testConnection();
    if (!connected) {
      logger.error('Cannot start: Bitcoin node not connected');
      logger.error('Please ensure Bitcoin Silver daemon is running');
      process.exit(1);
    }

    // Start blockchain monitoring
    await startMonitoring();

    // Start price monitoring service
    priceMonitor.startMonitoring();

    // Create HTTP server (needed for WebSocket)
    const http = require('http');
    const server = http.createServer(app);

    // Initialize WebSocket server
    websocketServer.createWebSocketServer(server);

    // Start HTTP server with WebSocket support
    server.listen(PORT, '0.0.0.0', () => {
      logger.info('='.repeat(60));
      logger.info('✓ Bitcoin Silver Notification Backend is running');
      logger.info(`✓ API Server listening on port ${PORT}`);
      logger.info(`✓ WebSocket Server initialized on /ws`);
      logger.info(`✓ Health check: http://localhost:${PORT}/health`);
      logger.info(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info('✓ Price monitoring: Active (checking every 5 minutes)');
      logger.info('='.repeat(60));
    });

  } catch (error) {
    logger.error('Failed to start server', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
});

// Start the server
start();
