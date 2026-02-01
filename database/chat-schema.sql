-- ================================================================================
-- BTCS MESSENGER - DATABASE SCHEMA
-- ================================================================================
-- Created: 2025-11-11
-- Purpose: Group chat messaging system for BTCS wallet users
-- ================================================================================

-- Chat messages table
-- Stores all chat messages with sender info and timestamps
CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    wallet_address VARCHAR(64) NOT NULL,
    nickname VARCHAR(50),
    message TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT NOW(),
    message_type VARCHAR(20) DEFAULT 'user'
);

-- Index for fast timestamp-based queries (newest first)
CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp DESC);

-- Index for filtering by message type
CREATE INDEX IF NOT EXISTS idx_chat_message_type ON chat_messages(message_type);

-- User nicknames table
-- Optional: Store user-chosen display names
CREATE TABLE IF NOT EXISTS user_nicknames (
    wallet_address VARCHAR(64) PRIMARY KEY,
    nickname VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Rate limiting table
-- Track message sends per user to prevent spam
CREATE TABLE IF NOT EXISTS chat_rate_limits (
    wallet_address VARCHAR(64) PRIMARY KEY,
    message_count INTEGER DEFAULT 0,
    window_start TIMESTAMP DEFAULT NOW()
);

-- ================================================================================
-- SAMPLE DATA (for testing)
-- ================================================================================

-- Insert a welcome system message
INSERT INTO chat_messages (wallet_address, nickname, message, message_type)
VALUES ('SYSTEM', 'BTCS Messenger', 'Welcome to BTCS Group Chat! 🚀', 'system')
ON CONFLICT DO NOTHING;

-- ================================================================================
-- CLEANUP FUNCTION (run periodically to archive old messages)
-- ================================================================================

-- Function to archive messages older than 6 months
CREATE OR REPLACE FUNCTION archive_old_messages()
RETURNS void AS $$
BEGIN
    -- Move old messages to archive table (if you create one later)
    -- For now, we just keep all messages
    -- DELETE FROM chat_messages WHERE timestamp < NOW() - INTERVAL '6 months';
    NULL;
END;
$$ LANGUAGE plpgsql;

-- ================================================================================
-- USEFUL QUERIES
-- ================================================================================

-- Get last 100 messages (for initial load)
-- SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT 100;

-- Get message history with pagination
-- SELECT * FROM chat_messages ORDER BY timestamp DESC OFFSET 0 LIMIT 50;

-- Get message count by user
-- SELECT wallet_address, nickname, COUNT(*) as msg_count
-- FROM chat_messages
-- WHERE message_type = 'user'
-- GROUP BY wallet_address, nickname
-- ORDER BY msg_count DESC;

-- Get messages from last 24 hours
-- SELECT * FROM chat_messages WHERE timestamp > NOW() - INTERVAL '24 hours';

-- ================================================================================
