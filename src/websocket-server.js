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

// Store active connections
const clients = new Map(); // wallet_address => WebSocket

// Rate limiting: track message counts per user
const rateLimits = new Map(); // wallet_address => { count, resetTime }
const RATE_LIMIT_MESSAGES = 10; // messages per minute
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute in ms

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

    logger.info("WebSocket connection attempt", { ip: clientIp });

    // Handle incoming messages
    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case "auth":
            await handleAuth(ws, message);
            walletAddress = message.wallet_address;
            break;

          case "message":
            await handleMessage(ws, message, walletAddress);
            break;

          case "typing":
            handleTyping(message, walletAddress);
            break;

          case "history":
            await handleHistoryRequest(ws, message);
            break;

          default:
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Unknown message type",
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
      if (walletAddress) {
        clients.delete(walletAddress);
        logger.info("Client disconnected", {
          address: walletAddress.substring(0, 10) + "...",
          activeClients: clients.size,
        });

        // Broadcast system message
        broadcast({
          type: "system",
          message: `User left the chat`,
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
  const { wallet_address, nickname } = message;

  if (!wallet_address) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Wallet address required",
      }),
    );
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
      activeUsers: clients.size,
    }),
  );

  // Broadcast system message
  broadcast(
    {
      type: "system",
      message: `${nickname || "User"} joined the chat`,
      timestamp: new Date().toISOString(),
    },
    wallet_address,
  ); // Exclude sender
}

/**
 * Handle chat message
 */
async function handleMessage(ws, message, senderAddress) {
  const { wallet_address, nickname, message: text } = message;

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
    });

    // Prepare broadcast message
    const broadcastMsg = {
      type: "message",
      id: savedMessage.id,
      wallet_address,
      nickname: nickname || wallet_address.substring(0, 8) + "...",
      message: text,
      timestamp: savedMessage.timestamp,
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
  const { wallet_address, nickname, typing } = message;

  // Broadcast typing status to others
  broadcast(
    {
      type: "typing",
      wallet_address,
      nickname: nickname || wallet_address.substring(0, 8) + "...",
      typing,
    },
    wallet_address,
  ); // Exclude sender
}

/**
 * Handle message history request
 */
async function handleHistoryRequest(ws, message) {
  try {
    const { limit = 100, offset = 0 } = message;
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
    const preview = message.message.substring(0, 25) + " ...";

    const notification = {
      title: "💬 New BTCS chat message !",
      body: `👤 @${message.nickname} says:\n\u200B🗨️ ${preview}`,
      data: {
        type: "chat_message",
        sender: message.wallet_address || "",
        nickname: message.nickname || "",
        message: message.message || "",
        timestamp: String(message.timestamp || new Date().toISOString()),
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

module.exports = {
  createWebSocketServer,
  getActiveUsersCount,
  broadcast,
};
