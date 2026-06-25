// ================================================================================
// BTCS MESSENGER - WEBSOCKET SERVER
// ================================================================================
// Created: 2025-11-11
// Purpose: Real-time group chat using WebSocket
// Port: 3001 (proxied through nginx at /ws)
// ================================================================================

const WebSocket = require("ws");
const logger = require("./logger");
const db = require("./db");
const notificationService = require("./notification-service");
const { getLatestPrices, formatPrice } = require("./price-api");

// Store active connections
const clients = new Map(); // wallet_address => WebSocket

// Store current system message template and processed message
let currentSystemMessageTemplate = null;
let currentProcessedSystemMessage = null;

/**
 * Replace placeholders like $btcs and $btc with actual prices
 */
async function processSystemMessage(template) {
  if (!template) return null;

  try {
    let processed = template;

    // Check if we need prices
    if (template.includes("$btcs") || template.includes("$btc")) {
      const prices = await getLatestPrices();

      if (template.includes("$btcs")) {
        processed = processed.replace(/\$btcs/g, formatPrice(prices.BTCS));
      }

      if (template.includes("$btc")) {
        processed = processed.replace(/\$btc/g, formatPrice(prices.BTC));
      }
    }

    return processed;
  } catch (error) {
    logger.error("Error processing system message placeholders", {
      error: error.message,
    });
    return template; // Fallback to raw template
  }
}

/**
 * Background task to refresh system message if it has placeholders
 */
async function refreshSystemMessage() {
  if (
    currentSystemMessageTemplate &&
    (currentSystemMessageTemplate.includes("$btcs") ||
      currentSystemMessageTemplate.includes("$btc"))
  ) {
    const newProcessed = await processSystemMessage(
      currentSystemMessageTemplate,
    );

    // Only broadcast if the processed message actually changed
    if (newProcessed !== currentProcessedSystemMessage) {
      currentProcessedSystemMessage = newProcessed;
      logger.debug("System message auto-refreshed with new prices");

      broadcast({
        type: "pong",
        timestamp: new Date().toISOString(),
        system_message: currentProcessedSystemMessage,
      });
    }
  }
}

// Refresh prices in banner every 2 minutes if needed
setInterval(refreshSystemMessage, 2 * 60 * 1000);

// Rate limiting: track message counts per user
const rateLimits = new Map(); // wallet_address => { count, resetTime }
const RATE_LIMIT_MESSAGES = 30; // messages per minute
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute in ms

// Per-IP connection limiting
const ipConnections = new Map(); // ip => count
const MAX_CONNECTIONS_PER_IP = 3;

// Max raw payload size before JSON parsing (8 KB)
const MAX_PAYLOAD_BYTES = 8192;

// Auth timeout: unauthenticated connections are closed after this many ms
const AUTH_TIMEOUT_MS = 10_000;

// BTCS address validation (shared between auth and RPC proxy logic)
const BTCS_LEGACY_RE = /^[bB83][1-9A-HJ-NP-Za-km-z]{24,33}$/;
const BTCS_BECH32_RE = /^bs1[a-z0-9]{39,59}$/;
function isValidBtcsAddress(addr) {
  return BTCS_LEGACY_RE.test(addr) || BTCS_BECH32_RE.test(addr);
}

/**
 * Initialize WebSocket server
 */
function createWebSocketServer(server) {
  const wss = new WebSocket.Server({
    server,
    path: "/ws",
  });

  wss.on("connection", (ws, req) => {
    const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    let walletAddress = null;
    ws.isVerified = false;

    // --- Per-IP connection limit ---
    const ipCount = (ipConnections.get(clientIp) || 0) + 1;
    if (ipCount > MAX_CONNECTIONS_PER_IP) {
      logger.warn("Too many connections from IP, rejecting", {
        ip: clientIp,
        count: ipCount,
      });
      ws.terminate();
      return;
    }
    ipConnections.set(clientIp, ipCount);

    logger.info("WebSocket connection attempt", {
      ip: clientIp,
      connectionsFromIp: ipCount,
    });

    // --- Auth timeout: close unverified connections after AUTH_TIMEOUT_MS ---
    const authTimeout = setTimeout(() => {
      if (!ws.isVerified) {
        logger.warn("WebSocket auth timeout, closing connection", {
          ip: clientIp,
        });
        ws.terminate();
      }
    }, AUTH_TIMEOUT_MS);

    // Handle incoming messages
    ws.on("message", async (data) => {
      try {
        // --- Payload size guard (before JSON parsing) ---
        if (data.length > MAX_PAYLOAD_BYTES) {
          logger.warn("Oversized WebSocket payload rejected", {
            ip: clientIp,
            bytes: data.length,
          });
          ws.terminate();
          return;
        }

        const message = JSON.parse(data.toString());
        const messageType = (message.type || "").toLowerCase();
        const CHAT_SECRET = process.env.CHAT_SECRET;

        // Security check: If a secret is provided in ANY message, it MUST be correct.
        // This blocks malicious actors even if legacy support is active.
        if (message.chat_secret && message.chat_secret !== CHAT_SECRET) {
          logger.warn("Security Alert: Incorrect secret provided", {
            ip: clientIp,
            type: messageType,
            walletAddress: message.wallet_address || walletAddress,
          });
          ws.terminate();
          return;
        }

        switch (messageType) {
          case "auth":
            if (!CHAT_SECRET || message.chat_secret !== CHAT_SECRET) {
              logger.warn("Strict Mode: Unauthorized auth attempt blocked", {
                ip: clientIp,
              });
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Unauthorized: Invalid or missing secret",
                }),
              );
              ws.terminate();
              return;
            }
            ws.isVerified = true;
            clearTimeout(authTimeout); // Auth received in time, cancel timeout
            await handleAuth(ws, message);
            walletAddress = message.wallet_address;
            break;

          case "message":
            if (!ws.isVerified || message.chat_secret !== CHAT_SECRET) {
              logger.warn("Strict Mode: Blocked unverified message", {
                ip: clientIp,
                walletAddress,
              });
              ws.terminate();
              return;
            }
            await handleMessage(ws, message, walletAddress);
            break;

          case "typing":
            if (!ws.isVerified || message.chat_secret !== CHAT_SECRET) {
              logger.warn("Strict Mode: Blocked unverified typing indicator", {
                ip: clientIp,
                walletAddress,
              });
              ws.terminate();
              return;
            }
            handleTyping(message, walletAddress);
            break;

          case "history":
            if (!ws.isVerified || message.chat_secret !== CHAT_SECRET) {
              logger.warn("Strict Mode: Blocked unverified history request", {
                ip: clientIp,
                walletAddress,
              });
              ws.terminate();
              return;
            }
            await handleHistoryRequest(ws, message);
            break;

          case "ping":
            if (message.chat_secret !== CHAT_SECRET) {
              logger.warn("Strict Mode: Blocked unverified ping", {
                ip: clientIp,
              });
              ws.terminate();
              return;
            }
            ws.send(
              JSON.stringify({
                type: "pong",
                timestamp: new Date().toISOString(),
                system_message: currentProcessedSystemMessage,
              }),
            );
            break;

          default:
            logger.warn("Unknown WebSocket message type received", {
              type: message.type,
              walletAddress,
            });
            ws.send(
              JSON.stringify({
                type: "error",
                message: `Unknown message type: ${message.type}`,
              }),
            );
        }
      } catch (error) {
        logger.error("WebSocket message error", { error: error.message });
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Invalid message format",
          }),
        );
      }
    });

    // Handle disconnection
    ws.on("close", () => {
      clearTimeout(authTimeout);

      // Decrement per-IP counter
      const remaining = (ipConnections.get(clientIp) || 1) - 1;
      remaining <= 0
        ? ipConnections.delete(clientIp)
        : ipConnections.set(clientIp, remaining);

      if (walletAddress) {
        clients.delete(walletAddress);
        logger.info("Client disconnected", {
          address: walletAddress.substring(0, 10) + "...",
          activeClients: clients.size,
        });

        // Broadcast system message with updated user count
        broadcast({
          type: "system",
          message: `User left the chat`,
          user_count: clients.size,
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Handle errors
    ws.on("error", (error) => {
      logger.error("WebSocket error", { error: error.message });
    });
  });

  logger.info("WebSocket server initialized on /ws");
  return wss;
}

/**
 * Handle client authentication
 */
async function handleAuth(ws, message) {
  const { wallet_address } = message;
  const nickname = (message.nickname || "").substring(0, 32).trim();

  if (!wallet_address) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Wallet address required",
      }),
    );
    ws.terminate();
    return;
  }

  // Validate it's a real BTCS address (legacy Base58 or Bech32)
  if (!isValidBtcsAddress(wallet_address)) {
    logger.warn("Auth rejected: invalid wallet address format", {
      address: wallet_address.substring(0, 10) + "...",
    });
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Invalid wallet address",
      }),
    );
    ws.terminate();
    return;
  }

  // Store connection
  clients.set(wallet_address, ws);

  logger.info("Client authenticated", {
    address: wallet_address.substring(0, 10) + "...",
    nickname: nickname || "Anonymous",
    activeClients: clients.size,
  });

  // Send confirmation
  ws.send(
    JSON.stringify({
      type: "auth_success",
      message: "Connected to BTCS Messenger",
      activeUsers: clients.size, // Kept for backward compatibility
      user_count: clients.size, // Added for consistency
    }),
  );

  // Send the current system message immediately so the banner appears right away
  ws.send(
    JSON.stringify({
      type: "pong",
      timestamp: new Date().toISOString(),
      system_message: currentProcessedSystemMessage,
    }),
  );

  // Broadcast system message
  broadcast(
    {
      type: "system",
      message: `${nickname || "User"} joined the chat`,
      user_count: clients.size,
      timestamp: new Date().toISOString(),
    },
    wallet_address,
  ); // Exclude sender
}

/**
 * Handle chat message
 */
async function handleMessage(ws, message, senderAddress) {
  // wallet_address is always taken from the authenticated session (senderAddress),
  // never trusted from the payload — prevents address spoofing.
  const wallet_address = senderAddress;
  const nickname = (message.nickname || "").substring(0, 32).trim();
  const text = message.message;
  const reply_to_id = message.reply_to_id || null;
  const reply_to_text = message.reply_to_text
    ? String(message.reply_to_text).substring(0, 500)
    : null;
  const reply_to_user = message.reply_to_user
    ? String(message.reply_to_user).substring(0, 32).trim()
    : null;

  // Validate
  if (!wallet_address || !text) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Wallet address and message required",
      }),
    );
    return;
  }

  // Validate message length
  if (text.length > 500) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Message too long (max 500 characters)",
      }),
    );
    return;
  }

  // Check rate limit
  if (!checkRateLimit(wallet_address)) {
    ws.send(
      JSON.stringify({
        type: "error",
        message:
          "Rate limit exceeded. Please wait before sending more messages.",
      }),
    );
    return;
  }

  try {
    // Save to database
    const savedMessage = await db.saveChatMessage({
      wallet_address,
      nickname: nickname || null,
      message: text,
      message_type: "user",
      reply_to_id: reply_to_id || null,
      reply_to_text: reply_to_text || null,
      reply_to_user: reply_to_user || null,
    });

    // Prepare broadcast message
    const broadcastMsg = {
      type: "message",
      id: savedMessage.id,
      wallet_address,
      nickname: nickname || wallet_address.substring(0, 8) + "...",
      message: text,
      timestamp: savedMessage.timestamp,
      reply_to_id: savedMessage.reply_to_id,
      reply_to_text: savedMessage.reply_to_text,
      reply_to_user: savedMessage.reply_to_user,
    };

    // Broadcast to all connected clients
    broadcast(broadcastMsg);

    // Send push notifications to offline users with chat notifications enabled
    await sendPushToOfflineUsers(broadcastMsg);

    logger.info("Message sent", {
      id: savedMessage.id,
      sender: wallet_address.substring(0, 10) + "...",
    });
  } catch (error) {
    logger.error("Failed to save message", { error: error.message });
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Failed to send message",
      }),
    );
  }
}

/**
 * Handle typing indicator
 */
function handleTyping(message, senderAddress) {
  const nickname = (message.nickname || "").substring(0, 32).trim();

  // Broadcast typing status to others
  broadcast(
    {
      type: "typing",
      wallet_address: senderAddress,
      nickname: nickname || senderAddress.substring(0, 8) + "...",
      typing: !!message.typing,
    },
    senderAddress,
  ); // Exclude sender
}

/**
 * Handle message history request
 */
async function handleHistoryRequest(ws, message) {
  try {
    const limit = Math.min(Math.max(parseInt(message.limit) || 50, 1), 100);
    const offset = Math.max(parseInt(message.offset) || 0, 0);
    const messages = await db.getChatHistory(limit, offset);

    ws.send(
      JSON.stringify({
        type: "history",
        messages: messages.reverse(), // Oldest first
      }),
    );
  } catch (error) {
    logger.error("Failed to fetch history", { error: error.message });
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Failed to load message history",
      }),
    );
  }
}

/**
 * Broadcast message to all connected clients
 */
function broadcast(message, excludeAddress = null) {
  const messageStr = JSON.stringify(message);

  clients.forEach((ws, address) => {
    if (address !== excludeAddress && ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
    }
  });
}

/**
 * Send push notifications to offline users with chat notifications enabled
 */
async function sendPushToOfflineUsers(message) {
  try {
    // Get devices with chat notifications enabled
    const allDevices = await db.getDevicesWithChatNotifications();

    // Filter out currently connected users and the sender
    const offlineDevices = allDevices.filter(
      (device) =>
        !clients.has(device.address) &&
        device.address !== message.wallet_address,
    );

    if (offlineDevices.length === 0) {
      return; // Everyone is online
    }

    // Prepare notification (all data values must be strings for FCM)
    const preview = message.message.substring(0, 105) + " ...";

    const notification = {
      title: "💬 New BTCS chat message !",
      body: `👤 @${message.nickname} says:\n\u200B🗨️ ${preview}`,
      data: {
        type: "chat_message",
        sender: message.wallet_address || "",
        nickname: message.nickname || "",
        message: message.message || "",
        timestamp: String(message.timestamp || new Date().toISOString()),
        reply_to_id: String(message.reply_to_id || ""),
        reply_to_text: String(message.reply_to_text || ""),
        reply_to_user: String(message.reply_to_user || ""),
      },
    };

    // Send to offline users
    for (const device of offlineDevices) {
      try {
        const result = await notificationService.sendPushNotification(
          device.token,
          notification.title,
          notification.body,
          notification.data,
          "chat_messages", // Use chat channel
        );

        // Auto-cleanup invalid tokens
        if (
          !result.success &&
          (result.code === "messaging/registration-token-not-registered" ||
            result.code === "messaging/invalid-registration-token")
        ) {
          try {
            await db.pool.query(
              "DELETE FROM device_tokens WHERE device_token = $1",
              [device.token],
            );
            logger.info("Removed invalid chat token from database", {
              token: device.token.substring(0, 20) + "...",
            });
          } catch (dbError) {
            logger.error("Failed to remove invalid token", {
              error: dbError.message,
            });
          }
        }
      } catch (error) {
        logger.error("Failed to send push notification", {
          address: device.address.substring(0, 10) + "...",
          error: error.message,
        });
      }
    }

    logger.info("Push notifications sent", {
      count: offlineDevices.length,
    });
  } catch (error) {
    logger.error("Failed to send push notifications", { error: error.message });
  }
}

/**
 * Rate limiting check
 */
function checkRateLimit(walletAddress) {
  const now = Date.now();
  const limit = rateLimits.get(walletAddress);

  if (!limit) {
    // First message - create entry
    rateLimits.set(walletAddress, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW,
    });
    return true;
  }

  // Check if window expired
  if (now > limit.resetTime) {
    // Reset window
    rateLimits.set(walletAddress, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW,
    });
    return true;
  }

  // Within window - check count
  if (limit.count >= RATE_LIMIT_MESSAGES) {
    return false; // Rate limit exceeded
  }

  // Increment count
  limit.count++;
  return true;
}

/**
 * Get active users count
 */
function getActiveUsersCount() {
  return clients.size;
}

/**
 * Cleanup function (call periodically)
 */
function cleanup() {
  // Remove stale rate limit entries
  const now = Date.now();
  for (const [address, limit] of rateLimits.entries()) {
    if (now > limit.resetTime + RATE_LIMIT_WINDOW) {
      rateLimits.delete(address);
    }
  }

  logger.info("WebSocket cleanup completed", {
    activeClients: clients.size,
    rateLimitEntries: rateLimits.size,
  });
}

// Run cleanup every 5 minutes
setInterval(cleanup, 5 * 60 * 1000);

/**
 * Update the global system message for the chat banner
 */
async function updateSystemMessage(message) {
  currentSystemMessageTemplate = message || null;
  currentProcessedSystemMessage = await processSystemMessage(
    currentSystemMessageTemplate,
  );

  logger.info("Global system message updated", {
    template: currentSystemMessageTemplate,
    processed: currentProcessedSystemMessage,
  });

  // Broadcast to everyone immediately so the banner updates without waiting for next ping
  broadcast({
    type: "pong",
    timestamp: new Date().toISOString(),
    system_message: currentProcessedSystemMessage,
  });
}

module.exports = {
  createWebSocketServer,
  getActiveUsersCount,
  broadcast,
  updateSystemMessage,
};
