-- Migration: Add price alerts functionality
-- Created: 2025-11-08

-- Add price_alerts_enabled column to device_tokens table
ALTER TABLE device_tokens
ADD COLUMN IF NOT EXISTS price_alerts_enabled BOOLEAN DEFAULT false;

-- Create price_history table to track BTCS price over time
CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  price DECIMAL(16, 8) NOT NULL,
  change_24h DECIMAL(8, 4),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  source VARCHAR(50) DEFAULT 'livecoinwatch'
);

-- Create index on timestamp for fast 24h lookups
CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON price_history(timestamp DESC);

-- Create price_notifications table to track sent price alerts
CREATE TABLE IF NOT EXISTS price_notifications (
  id SERIAL PRIMARY KEY,
  price DECIMAL(16, 8) NOT NULL,
  change_percent DECIMAL(8, 4) NOT NULL,
  direction VARCHAR(10) NOT NULL, -- 'increase' or 'decrease'
  devices_notified INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add comments for documentation
COMMENT ON TABLE price_history IS 'Stores historical BTCS price data for calculating 24h changes';
COMMENT ON TABLE price_notifications IS 'Tracks sent price alert notifications to avoid spam';
COMMENT ON COLUMN device_tokens.price_alerts_enabled IS 'Whether user wants to receive price change notifications';
