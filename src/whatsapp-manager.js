const { Client, LocalAuth } = require('whatsapp-web.js');
const db = require('./db');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

class WhatsAppManager {
    constructor() {
        this.clients = new Map(); // tenantId -> Client
        this.status = new Map();  // tenantId -> Status
    }

    // Helper to remove locks
    // Helper to remove locks
    cleanLocks(folder) {
        if (!fs.existsSync(folder)) {
            console.log(`cleanLocks: Folder not found ${folder}`);
            return;
        }
        console.log(`cleanLocks: Scanning ${folder}`);
        const files = fs.readdirSync(folder);
        for (const file of files) {
            const curPath = path.join(folder, file);
            if (fs.lstatSync(curPath).isDirectory()) {
                this.cleanLocks(curPath);
            } else {
                if (file === 'SingletonLock' || file === 'SingletonCookie') {
                    console.log(`Removing lock file: ${curPath}`);
                    try { fs.unlinkSync(curPath); } catch (e) { console.error(e); }
                }
            }
        }
    }

    // Initialize or get client for a tenant
    getClient(tenantId) {
        if (this.clients.has(tenantId)) {
            return this.clients.get(tenantId);
        }

        console.log(`Initializing WhatsApp client for Tenant ${tenantId}`);

        // Custom session path for each tenant
        // LocalAuth creates 'session-{clientId}' directory
        const authPath = path.join(__dirname, '../.wwebjs_auth', `session-tenant_${tenantId}`);
        console.log(`Auth Path detected: ${authPath}`);

        if (!fs.existsSync(authPath)) {
            // LocalAuth creates it automatically 
            // LocalAuth creates it automatically, no need to pre-create incorrectly named one
        } else {
            // Clean locks before starting
            try {
                this.cleanLocks(authPath);
            } catch (err) {
                console.error('Failed to clean locks:', err);
            }
        }

        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: `tenant_${tenantId}`,
                dataPath: path.join(__dirname, '../.wwebjs_auth')
            }),
            puppeteer: {
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                headless: true
            }
        });

        // Initialize status
        this.status.set(tenantId, { ready: false, qr: null });

        // Event Listeners
        client.on('qr', (qr) => {
            console.log(`QR Code received for Tenant ${tenantId}`);
            QRCode.toDataURL(qr, (err, url) => {
                if (err) {
                    console.error('Error generating QR code image', err);
                    return;
                }
                this.status.set(tenantId, { ready: false, qr: url });
                // Emit to socket if possible (needs socket instance)
                if (this.io) {
                    this.io.to(`tenant_${tenantId}`).emit('qr', url);
                }
            });
        });

        client.on('ready', () => {
            console.log(`Client is ready for Tenant ${tenantId}`);
            this.status.set(tenantId, { ready: true, qr: null });
            if (this.io) {
                this.io.to(`tenant_${tenantId}`).emit('ready');
                this.io.to(`tenant_${tenantId}`).emit('status_update', { ready: true });
            }
        });

        client.on('authenticated', () => {
            console.log(`Authenticated for Tenant ${tenantId}`);
            if (this.io) this.io.to(`tenant_${tenantId}`).emit('log', 'WhatsApp Authenticated');
        });

        client.on('disconnected', (reason) => {
            console.log(`Client disconnected for Tenant ${tenantId}: ${reason}`);
            this.status.set(tenantId, { ready: false, qr: null });
            this.clients.delete(tenantId); // cleanup
            if (this.io) this.io.to(`tenant_${tenantId}`).emit('status_update', { ready: false });
        });

        // Start client
        client.initialize().catch(err => {
            console.error(`Failed to initialize client for Tenant ${tenantId}:`, err);
            this.clients.delete(tenantId);
            this.status.set(tenantId, { ready: false, qr: null });
        });

        this.clients.set(tenantId, client);
        return client;
    }

    getStatus(tenantId) {
        return this.status.get(tenantId) || { ready: false, qr: null };
    }

    async send(tenantId, number, message, campaignId = null) {
        const client = this.getClient(tenantId);

        // Wait for ready state? Or fail if not ready?
        const status = this.getStatus(tenantId);
        if (!status.ready) {
            throw new Error('WhatsApp client not ready');
        }

        const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;

        try {
            await client.sendMessage(formattedNumber, message);

            // Log success
            if (this.io) {
                this.io.to(`tenant_${tenantId}`).emit('log', `Sent to ${number}`);
                this.io.to(`tenant_${tenantId}`).emit('campaign_progress', { id: campaignId, type: 'sent' });
            }
            // Trigger DB updates via event or direct call?
            // Direct call is safer here since we are in manager
            if (campaignId) {
                db.updateCampaignStats(tenantId, campaignId, 'sent');
                db.logMessage(tenantId, campaignId, number, message, 'SENT');
            }

            return { success: true };

        } catch (err) {
            console.error(`Failed to send to ${number} (Tenant ${tenantId}):`, err);

            if (this.io) {
                this.io.to(`tenant_${tenantId}`).emit('log', `Failed to ${number}: ${err.message}`);
                this.io.to(`tenant_${tenantId}`).emit('campaign_progress', { id: campaignId, type: 'failed' });
            }

            if (campaignId) {
                db.updateCampaignStats(tenantId, campaignId, 'failed');
                db.logMessage(tenantId, campaignId, number, message, `FAILED: ${err.message}`);
            }

            throw err;
        }
    }

    setSocket(io) {
        this.io = io;
    }

    async logout(tenantId) {
        console.log(`Logging out WhatsApp for Tenant ${tenantId}`);
        const client = this.clients.get(tenantId);

        if (client) {
            try {
                await client.logout();
            } catch (err) {
                console.error('Error during client logout:', err);
            }

            try {
                await client.destroy();
            } catch (err) {
                console.error('Error during client destroy:', err);
            }

            this.clients.delete(tenantId);
            this.status.delete(tenantId);
        }

        // Delete auth folder
        const authPath = path.join(__dirname, '../.wwebjs_auth', `session-tenant_${tenantId}`);
        if (fs.existsSync(authPath)) {
            console.log(`Deleting session folder: ${authPath}`);
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
                console.log(`Session folder deleted successfully`);
            } catch (err) {
                console.error('Error deleting session folder:', err);
            }
        }

        // Force reinitialize client to get new QR
        console.log(`Reinitializing client for Tenant ${tenantId}`);
        setTimeout(() => {
            this.getClient(tenantId);
        }, 1000);
    }

    // Alias for consistency
    async logoutClient(tenantId) {
        return this.logout(tenantId);
    }
}

module.exports = new WhatsAppManager();
