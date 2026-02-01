# Bitcoin Silver Notification Backend

Push notification backend server for Bitcoin Silver wallet.

## Prerequisites

- Bitcoin Silver node running with ZMQ enabled
- PostgreSQL database
- Redis (optional, for future enhancements)
- Node.js v18 or higher
- Firebase project with Admin SDK service account

## Installation

### 1. Upload to VPS

```bash
# On your local machine, from the wallet directory:
scp -r backend btcwallet@YOUR_VPS_IP:~/btcs-notification-backend

# Or use rsync:
rsync -avz backend/ btcwallet@YOUR_VPS_IP:~/btcs-notification-backend/
```

### 2. Install Dependencies on VPS

```bash
ssh btcwallet@YOUR_VPS_IP
cd ~/btcs-notification-backend
npm install
```

### 3. Create Database

```bash
# Create database and user
sudo -u postgres psql << EOF
CREATE DATABASE btcs_notifications;
CREATE USER btcs_backend WITH PASSWORD 'YOUR_SECURE_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE btcs_notifications TO btcs_backend;
\q
EOF

# Create tables
PGPASSWORD='YOUR_SECURE_PASSWORD' psql -U btcs_backend -d btcs_notifications -h localhost << 'EOF'
CREATE TABLE device_tokens (
    id SERIAL PRIMARY KEY,
    address VARCHAR(100) NOT NULL,
    device_token TEXT NOT NULL,
    platform VARCHAR(10) DEFAULT 'android',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(address, device_token)
);

CREATE INDEX idx_address ON device_tokens(address);

CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    address VARCHAR(100) NOT NULL,
    txid VARCHAR(64) NOT NULL,
    amount DECIMAL(16,8) NOT NULL,
    sent BOOLEAN DEFAULT FALSE,
    confirmed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(address, txid)
);
\q
EOF
```

### 4. Configure Firebase Admin SDK

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project (or create one)
3. Go to **Project Settings** → **Service Accounts**
4. Click **Generate new private key**
5. Save the downloaded JSON file as `firebase-admin-key.json` in the project root

```bash
# Upload the key file to VPS
scp firebase-admin-key.json btcwallet@YOUR_VPS_IP:~/btcs-notification-backend/
```

### 5. Configure Environment

```bash
cd ~/btcs-notification-backend
cp .env.example .env
nano .env
```

Update these values in `.env`:
- `DB_PASSWORD` - Your PostgreSQL password
- `API_KEY` - A secure random string for API authentication
- `LIVECOINWATCH_API_KEY` - Your LiveCoinWatch API key (for price monitoring)

### 6. Test the Backend

```bash
# Test run
npm start

# In another terminal, test the health endpoint
curl http://localhost:3000/health
```

## Running in Production

### Option 1: Using PM2 (Recommended)

```bash
npm install -g pm2

# Start the backend
pm2 start src/server.js --name btcs-backend

# Save PM2 configuration
pm2 save

# Setup auto-start on boot
pm2 startup

# Monitor
pm2 status
pm2 logs btcs-backend
pm2 monit
```

### Option 2: Using systemd

Create `/etc/systemd/system/btcs-backend.service`:

```ini
[Unit]
Description=Bitcoin Silver Notification Backend
After=network.target postgresql.service

[Service]
Type=simple
User=btcwallet
WorkingDirectory=/home/btcwallet/btcs-notification-backend
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable btcs-backend
sudo systemctl start btcs-backend
sudo systemctl status btcs-backend

# View logs
journalctl -u btcs-backend -f
```

## API Endpoints

### Health Check
```bash
GET /health
```

### Register Device
```bash
POST /api/register
Content-Type: application/json

{
  "address": "btcs1q...",
  "device_token": "fcm_token...",
  "platform": "android"
}
```

### Unregister Device
```bash
POST /api/unregister
Content-Type: application/json

{
  "address": "btcs1q...",
  "device_token": "fcm_token..."
}
```

### Get Notification History
```bash
GET /api/notifications/:address?limit=50
```

### Get Statistics
```bash
GET /api/stats
```

### Test Notification
```bash
POST /api/test-notification
Content-Type: application/json

{
  "device_token": "fcm_token..."
}
```

## Firewall Configuration

```bash
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 3000/tcp    # API (or use nginx reverse proxy)
sudo ufw enable
```

## Monitoring

### Check Logs
```bash
# PM2
pm2 logs btcs-backend

# systemd
journalctl -u btcs-backend -f

# Log files
tail -f combined.log
tail -f error.log
```

### Check Database
```bash
psql -U btcs_backend -d btcs_notifications -h localhost

# Inside psql:
SELECT * FROM device_tokens;
SELECT * FROM notifications ORDER BY created_at DESC LIMIT 10;
```

### Check Bitcoin Node
```bash
bitcoinsilver-cli getblockchaininfo
```

## Troubleshooting

### Backend won't start
1. Check Bitcoin node is running: `bitcoinsilver-cli getblockchaininfo`
2. Check database credentials in `.env`
3. Check logs: `pm2 logs btcs-backend` or `journalctl -u btcs-backend`

### Notifications not arriving
1. Check `firebase-admin-key.json` exists in project root
2. Verify Firebase project has Cloud Messaging enabled
3. Check device is registered: Query database
4. Check ZMQ is working: Look for "Processing transaction" in logs

### Database connection failed
1. Check PostgreSQL is running: `sudo systemctl status postgresql`
2. Check database exists: `sudo -u postgres psql -l | grep btcs`
3. Check credentials in `.env`

## Security Notes

- Never commit `.env` or `firebase-admin-key.json` files
- Use strong database passwords
- Keep Firebase service account key secret
- Run behind nginx with SSL in production
- Use firewall to restrict access
- Regular security updates: `sudo apt update && sudo apt upgrade`

## Updating

```bash
# On local machine, update code then:
rsync -avz backend/ btcwallet@YOUR_VPS_IP:~/btcs-notification-backend/

# On VPS:
cd ~/btcs-notification-backend
npm install
pm2 restart btcs-backend
```
