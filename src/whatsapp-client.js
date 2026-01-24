const { Client, LocalAuth } = require('whatsapp-web.js');
const EventEmitter = require('events');
const qrcode = require('qrcode');

class WhatsAppClient extends EventEmitter {
    constructor() {
        super();
        this.ready = false;
        this.qrCodeUrl = null;

        // Custom Queue
        this.queue = [];
        this.isProcessing = false;

        this.client = new Client({
            authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
            puppeteer: {
                headless: true,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            }
        });

        this.initializeClient();
    }

    initializeClient() {
        this.client.on('qr', async (qr) => {
            console.log('QR Received');
            this.qrCodeUrl = await qrcode.toDataURL(qr);
            this.emit('qr', this.qrCodeUrl);
            this.ready = false;
        });

        this.client.on('ready', () => {
            console.log('WhatsApp Client is Ready!');
            this.ready = true;
            this.qrCodeUrl = null;
            this.emit('ready');
            // Resume queue if any items left (though usually empty on restart)
            this.processQueue();
        });

        this.client.on('authenticated', () => {
            console.log('Authenticated');
            this.emit('authenticated');
        });

        this.client.on('auth_failure', (msg) => {
            console.error('Authentication failure', msg);
            this.emit('auth_failure', msg);
        });

        this.client.on('disconnected', (reason) => {
            console.log('Client was disconnected', reason);
            this.ready = false;
            this.emit('disconnected', reason);
            this.client.initialize();
        });

        this.client.initialize();
    }

    // --- Custom Queue Logic ---

    async send(phone, message, campaignId = null) {
        console.log(`[Queue] Adding task for ${phone}`);
        this.queue.push({ phone, message, campaignId });
        this.processQueue();
    }

    async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        console.log('[Queue] Starting processing loop...');

        while (this.queue.length > 0) {
            const task = this.queue.shift(); // Get next task

            if (!this.ready) {
                console.warn('[Queue] Client not ready, waiting 2s...');
                this.queue.unshift(task); // Put back
                await new Promise(r => setTimeout(r, 2000));
                continue; // Retry loop
            }

            try {
                let chatId = task.phone;
                if (!chatId.includes('@c.us')) {
                    chatId = `${chatId.replace(/\D/g, '')}@c.us`;
                }

                console.log(`[Queue] Processing: ${chatId}`);

                // Send with Timeout Race
                const sendPromise = this.client.sendMessage(chatId, task.message);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Send Timeout (30s)')), 30000)
                );

                await Promise.race([sendPromise, timeoutPromise]);

                console.log(`[Queue] Success: ${chatId}`);
                this.emit('message_sent', { phone: task.phone, campaignId: task.campaignId, message: task.message });

            } catch (err) {
                console.error(`[Queue] Failed: ${task.phone}`, err.message);
                this.emit('message_failed', { phone: task.phone, campaignId: task.campaignId, error: err.message, message: task.message });
            } finally {
                // Anti-Ban Delay (Randomized 2s to 12s as requested)
                const minDelay = 2000;
                const maxDelay = 12000;
                const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);

                console.log(`[Queue] Waiting ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }

        this.isProcessing = false;
        console.log('[Queue] Queue empty, stopped.');
    }

    getStatus() {
        return {
            ready: this.ready,
            qr: this.qrCodeUrl
        };
    }
}

module.exports = new WhatsAppClient();
