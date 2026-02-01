const axios = require('axios');
const zmq = require('zeromq');
const { getDeviceTokensByAddress, logNotification } = require('./db');
const { notifyIncomingTransaction } = require('./notification-service');
const logger = require('./logger');
require('dotenv').config();

// For zeromq v6+
const { Subscriber } = zmq;

// Bitcoin RPC client configuration
const rpcUrl = `http://${process.env.BITCOIN_RPC_HOST}:${process.env.BITCOIN_RPC_PORT}`;
const rpcAuth = {
  username: process.env.BITCOIN_RPC_USER,
  password: process.env.BITCOIN_RPC_PASSWORD
};

// Helper function to make RPC calls
async function rpcCall(method, params = []) {
  try {
    const response = await axios.post(rpcUrl, {
      jsonrpc: '1.0',
      id: method,
      method: method,
      params: params
    }, {
      auth: rpcAuth,
      timeout: 30000
    });
    return response.data.result;
  } catch (error) {
    if (error.response?.data?.error) {
      const rpcError = new Error(error.response.data.error.message);
      rpcError.code = error.response.data.error.code;
      throw rpcError;
    }
    throw error;
  }
}

let isMonitoring = false;
let zmqSocket = null;
let notifiedTransactions = new Map(); // Track txids and their notification state: 'unconfirmed' or 'confirmed'

/**
 * Test connection to Bitcoin node
 */
async function testConnection() {
  try {
    const info = await rpcCall('getblockchaininfo');
    logger.info('Bitcoin RPC connected', {
      chain: info.chain,
      blocks: info.blocks,
      synced: !info.initialblockdownload,
      verificationProgress: (info.verificationprogress * 100).toFixed(2) + '%'
    });
    return true;
  } catch (error) {
    logger.error('Bitcoin RPC connection failed', { error: error.message });
    return false;
  }
}

/**
 * Extract sender addresses from transaction inputs
 */
async function getSenderAddresses(tx) {
  const senderAddresses = new Set();

  // Skip coinbase transactions (no inputs)
  if (tx.vin && tx.vin.length > 0 && !tx.vin[0].coinbase) {
    // Get addresses from inputs
    for (const vin of tx.vin) {
      if (vin.txid && vin.vout !== undefined) {
        try {
          // Get the previous transaction to find the input address
          const prevTx = await rpcCall('getrawtransaction', [vin.txid, true]);
          const prevVout = prevTx.vout[vin.vout];

          if (prevVout && prevVout.scriptPubKey) {
            const address = prevVout.scriptPubKey.address ||
                           (prevVout.scriptPubKey.addresses && prevVout.scriptPubKey.addresses[0]);
            if (address) {
              senderAddresses.add(address);
            }
          }
        } catch (err) {
          // Previous transaction might not be available, skip
          logger.debug('Could not fetch previous transaction', {
            txid: vin.txid,
            error: err.message
          });
        }
      }
    }
  }

  return senderAddresses;
}

/**
 * Process a raw transaction and check for monitored addresses
 */
async function processTransaction(rawTx) {
  try {
    // Decode the transaction
    const tx = await rpcCall('decoderawtransaction', [rawTx]);

    logger.info('Processing transaction', { txid: tx.txid });

    // Check if transaction is confirmed or in mempool
    let confirmations = 0;
    try {
      const txInfo = await rpcCall('getrawtransaction', [tx.txid, true]);
      confirmations = txInfo.confirmations || 0;
    } catch (err) {
      // Transaction might be very new, assume 0 confirmations
      confirmations = 0;
    }

    const notificationState = notifiedTransactions.get(tx.txid);

    // If unconfirmed and not yet notified
    if (confirmations === 0 && !notificationState) {
      logger.info('New unconfirmed transaction', { txid: tx.txid });
      notifiedTransactions.set(tx.txid, 'unconfirmed');
      // Continue to send unconfirmed notification
    }
    // If confirmed and only unconfirmed notification sent
    else if (confirmations >= 1 && notificationState === 'unconfirmed') {
      logger.info('Transaction confirmed', { txid: tx.txid, confirmations });
      notifiedTransactions.set(tx.txid, 'confirmed');
      // Continue to send confirmed notification
    }
    // Already fully notified
    else {
      logger.debug('Transaction already fully notified, skipping', { txid: tx.txid, state: notificationState });
      return;
    }

    // Cleanup old entries after 2 hours
    setTimeout(() => {
      notifiedTransactions.delete(tx.txid);
    }, 7200000); // 2 hours

    // Get sender addresses to exclude them from notifications (they're receiving change, not new funds)
    const senderAddresses = await getSenderAddresses(tx);

    if (senderAddresses.size > 0) {
      logger.info('Identified sender addresses (will skip notifications for change outputs)', {
        txid: tx.txid,
        senders: Array.from(senderAddresses).map(addr => addr.substring(0, 10) + '...')
      });
    }

    // Check all outputs for monitored addresses
    for (const vout of tx.vout) {
      if (vout.scriptPubKey) {
        // Bitcoin Silver uses 'address' (string), Bitcoin Core uses 'addresses' (array)
        const addressList = vout.scriptPubKey.address
          ? [vout.scriptPubKey.address]
          : (vout.scriptPubKey.addresses || []);

        for (const address of addressList) {
          // Skip if this is a sender address (change output)
          if (senderAddresses.has(address)) {
            logger.info('Skipping notification for sender/change address', {
              address: address.substring(0, 10) + '...',
              amount: vout.value,
              txid: tx.txid
            });
            continue;
          }

          // Check if we're monitoring this address
          const devices = await getDeviceTokensByAddress(address);

          if (devices.length > 0) {
            const amount = vout.value;

            logger.info('Transaction match found!', {
              address: address.substring(0, 10) + '...',
              amount: amount,
              txid: tx.txid,
              devices: devices.length
            });

            // Send notifications to all registered devices
            try {
              await notifyIncomingTransaction(
                devices,
                tx.txid,
                address,
                amount,
                confirmations
              );

              // Log notification in database
              await logNotification(address, tx.txid, amount, true);
            } catch (notifError) {
              logger.error('Failed to send notifications', {
                error: notifError.message,
                txid: tx.txid
              });

              // Log failed notification
              await logNotification(address, tx.txid, amount, false);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error('Error processing transaction', {
      error: error.message,
      stack: error.stack
    });
  }
}

/**
 * Start monitoring the blockchain for transactions
 */
async function startMonitoring() {
  if (isMonitoring) {
    logger.warn('Monitoring is already active');
    return;
  }

  logger.info('Starting Bitcoin Silver transaction monitor...');

  try {
    // Create ZMQ socket (zeromq v6+ API)
    zmqSocket = new Subscriber();
    zmqSocket.connect(process.env.ZMQ_RAWTX);
    zmqSocket.subscribe('rawtx');

    logger.info('Connected to ZMQ', { endpoint: process.env.ZMQ_RAWTX });

    isMonitoring = true;

    // Start listening for messages (async iterator in zeromq v6+)
    (async () => {
      try {
        for await (const [topic, message] of zmqSocket) {
          try {
            const rawTx = message.toString('hex');
            await processTransaction(rawTx);
          } catch (error) {
            logger.error('Error handling ZMQ message', { error: error.message });
          }
        }
      } catch (error) {
        if (isMonitoring) {
          logger.error('ZMQ listener error', { error: error.message });
          isMonitoring = false;

          // Attempt reconnection after 5 seconds
          setTimeout(() => {
            if (!isMonitoring) {
              logger.info('Attempting to reconnect to ZMQ...');
              startMonitoring();
            }
          }, 5000);
        }
      }
    })();

    logger.info('Monitoring active - waiting for transactions...');

  } catch (error) {
    logger.error('Failed to start monitoring', { error: error.message });
    isMonitoring = false;
    throw error;
  }
}

/**
 * Stop monitoring
 */
async function stopMonitoring() {
  if (zmqSocket) {
    try {
      await zmqSocket.close();
    } catch (error) {
      logger.error('Error closing ZMQ socket', { error: error.message });
    }
    zmqSocket = null;
  }
  isMonitoring = false;
  logger.info('Monitoring stopped');
}

/**
 * Get monitoring status
 */
function getMonitoringStatus() {
  return {
    isActive: isMonitoring,
    endpoint: process.env.ZMQ_RAWTX
  };
}

/**
 * Get blockchain info
 */
async function getBlockchainInfo() {
  try {
    return await rpcCall('getblockchaininfo');
  } catch (error) {
    logger.error('Failed to get blockchain info', { error: error.message });
    throw error;
  }
}

module.exports = {
  testConnection,
  startMonitoring,
  stopMonitoring,
  getMonitoringStatus,
  getBlockchainInfo,
};
