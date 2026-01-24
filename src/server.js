const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');

const db = require('./db');
const whatsapp = require('./whatsapp-client');
const { requireAuth, requireAdmin } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Logging Helper
function logToDb(level, message) {
    console.log(`[${level}] ${message}`);
    try {
        db.addSystemLog(level, message);
    } catch (err) {
        console.error('Failed to write to system log:', err);
    }
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Session Config
app.use(session({
    secret: 'supersecret_saas_key_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Upload Config
const upload = multer({ storage: multer.memoryStorage() });

// Settings API
app.get('/api/settings', (req, res) => {
    // Public (or semi-public) - used to load branding
    const settings = db.getSettings();
    res.json(settings);
});

app.post('/api/settings', requireAuth, requireAdmin, (req, res) => {
    const { siteName } = req.body;
    if (siteName) db.updateSetting('site_name', siteName);
    res.json({ success: true });
});

app.post('/api/settings/logo', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Move to public/logo.png (or keep original name and store path)
    // Simpler: Access via /uploads/[filename] OR overwrite a standard 'logo.png' if desired.
    // Let's keep original extension but rename to 'site_logo' for easy replacement

    // But we need extension
    const ext = path.extname(req.file.originalname);
    const targetPath = path.join(__dirname, '../public/site_logo' + ext);

    fs.writeFileSync(targetPath, req.file.buffer); // Changed from fs.renameSync to fs.writeFileSync

    // Save partial path in DB
    const publicPath = 'site_logo' + ext;
    db.updateSetting('site_logo', publicPath);

    res.json({ success: true, path: publicPath });
});

// --- AUTH ROUTES ---

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.getUserByUsername(username);

    if (user && bcrypt.compareSync(password, user.password_hash)) {
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        logToDb('INFO', `User logged in: ${username}`);
        return res.json({ success: true, user: { username: user.username, role: user.role } });
    }
    logToDb('WARN', `Failed login attempt for: ${username}`);
    res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
    if (req.session.username) {
        logToDb('INFO', `User logged out: ${req.session.username}`);
    }
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({
        username: req.session.username,
        role: req.session.role
    });
});

// --- USER MANAGEMENT (ADMIN ONLY) ---
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    try {
        const users = db.getAllUsers();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    try {
        db.createUser(username, password, role || 'user');
        logToDb('INFO', `User created: ${username} (${role})`);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    // Prevent deleting self? Frontend handles usually.
    try {
        db.deleteUser(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API ROUTES (Protected) ---

// Get System Logs (Admin Only)
app.get('/api/logs', requireAuth, requireAdmin, (req, res) => {
    const logs = db.getSystemLogs();
    res.json(logs);
});

app.get('/api/logs/download', requireAuth, requireAdmin, (req, res) => {
    try {
        const logs = db.getSystemLogs(1000); // Get last 1000 logs
        const fileContent = logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');

        res.setHeader('Content-Disposition', 'attachment; filename="system_logs.txt"');
        res.setHeader('Content-Type', 'text/plain');
        res.send(fileContent);
    } catch (err) {
        res.status(500).send("Error generating log file");
    }
});

// Get System Status
app.get('/api/status', requireAuth, (req, res) => {
    res.json(whatsapp.getStatus());
});

// Get Students
app.get('/api/students', requireAuth, (req, res) => {
    try {
        const students = db.getAllStudents();
        res.json(students);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add Student
// Only admin can manage students? Or users too? Requirement said: "Admin... manage students"
// We'll allow Admin only for Add/Delete to be safe as per "White-label" request usually implies control.
// User just sends.
app.post('/api/students', requireAuth, requireAdmin, (req, res) => {
    const { name, phone } = req.body;
    try {
        db.addStudent(name, phone);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/students/:id', requireAuth, requireAdmin, (req, res) => {
    db.deleteStudent(req.params.id);
    res.json({ success: true });
});

// Excel Template Download
app.get('/api/template', (req, res) => {
    try {
        const wb = xlsx.utils.book_new();
        const data = [
            { "Name": "فيصل", "Phone": "966500000000" },
            { "Name": "محمد", "Phone": "966512345678" }
        ];
        const ws = xlsx.utils.json_to_sheet(data);
        xlsx.utils.book_append_sheet(wb, ws, "Students");

        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', 'attachment; filename="students_template.xlsx"');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(buffer);
    } catch (err) {
        res.status(500).send("Error generating template");
    }
});

// Excel Upload
app.post('/api/upload', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet);

        const studentsToAdd = [];

        data.forEach(row => {
            // Flexible header matching
            const name = row['Name'] || row['name'] || row['Student'] || row['اسم'] || 'Unknown';
            let phone = row['Phone'] || row['phone'] || row['Mobile'] || row['number'] || row['رقم'];

            if (phone) {
                // Sanitize phone
                phone = String(phone).replace(/\D/g, '');
                studentsToAdd.push({ name, phone });
            }
        });

        const result = db.addStudentsBulk(studentsToAdd);
        res.json({ success: true, ...result });

    } catch (err) {
        res.status(500).json({ error: 'Failed to process file: ' + err.message });
    }
});

// Start Campaign
app.post('/api/campaign', requireAuth, (req, res) => {
    const { name, message, studentIds } = req.body;

    if (!message) return res.status(400).json({ error: 'Message content is required' });

    let targets = [];
    const allStudents = db.getAllStudents();

    if (studentIds === 'all') {
        targets = allStudents;
    } else if (Array.isArray(studentIds)) {
        targets = allStudents.filter(s => studentIds.includes(s.id));
    }

    if (targets.length === 0) {
        return res.status(400).json({ error: 'No students selected' });
    }

    // Create Campaign Record
    const campaignName = name || `Campaign ${new Date().toLocaleDateString()}`;
    const result = db.createCampaign(campaignName, targets.length, req.session.userId);
    const campaignId = result.lastInsertRowid;

    console.log(`Starting campaign ${campaignId} for ${targets.length} students`);

    // Add to Queue (Async - Fire and Forget)
    targets.forEach(student => {
        // Just push to queue, DB update happens via events
        whatsapp.send(student.phone_number, message, campaignId);
    });

    res.json({ success: true, count: targets.length });
});

// Retry Campaign (Failed Only)
app.post('/api/campaign/:id/retry', requireAuth, (req, res) => {
    const campaignId = req.params.id;
    const { message } = req.body;

    if (!message) return res.status(400).json({ error: 'Message content is required' });

    const failedRecipients = db.getFailedRecipients(campaignId);

    if (failedRecipients.length === 0) {
        return res.status(400).json({ error: 'No failed recipients found to retry' });
    }

    console.log(`Retrying campaign ${campaignId} for ${failedRecipients.length} failed numbers`);

    // Add to Queue
    failedRecipients.forEach(row => {
        whatsapp.send(row.recipient, message, campaignId);
    });

    res.json({ success: true, count: failedRecipients.length });
});

// Get Campaigns
app.get('/api/campaigns', requireAuth, (req, res) => {
    res.json(db.getCampaigns());
});

app.get('/api/campaigns/:id', requireAuth, (req, res) => {
    try {
        const history = db.getCampaignHistory(req.params.id);
        res.json(history);
    } catch (err) {
        console.error(`Error fetching campaign history for ${req.params.id}:`, err);
        res.status(500).json({ error: 'Failed to fetch history: ' + err.message });
    }
});

// --- SOCKET.IO EVENTS ---
io.on('connection', (socket) => {
    // Send status
    socket.emit('status_update', whatsapp.getStatus());
});

// Forward WhatsApp Events to Frontend & DB
whatsapp.on('qr', (qrUrl) => {
    io.emit('qr', qrUrl);
    io.emit('status_update', { ready: false, qr: qrUrl });
});

whatsapp.on('ready', () => {
    io.emit('ready');
    io.emit('status_update', { ready: true, qr: null });
});

whatsapp.on('authenticated', () => io.emit('log', 'WhatsApp Authenticated'));
whatsapp.on('disconnected', () => io.emit('status_update', { ready: false, qr: null }));

// Reliable DB Updates via Events
whatsapp.on('message_sent', (data) => {
    const { phone, campaignId, message } = data;
    console.log(`Event: SENT ${phone} (Campaign ${campaignId})`);

    // Update DB
    if (campaignId) {
        try {
            db.updateCampaignStats(campaignId, 'sent');
            db.logMessage(campaignId, phone, message || "Message Sent", 'SENT');
            io.emit('campaign_progress', { id: campaignId, type: 'sent' });
        } catch (err) {
            console.error('DB Insert Error (SENT):', err);
        }
    }

    io.emit('log', `Sent to ${phone}`);
    logToDb('INFO', `Sent to ${phone} (Camp: ${campaignId})`);
});

whatsapp.on('message_failed', (data) => {
    const { phone, campaignId, error, message } = data;
    console.log(`Event: FAILED ${phone} (Campaign ${campaignId})`);

    if (campaignId) {
        try {
            db.updateCampaignStats(campaignId, 'failed');
            db.logMessage(campaignId, phone, message || "Message Failed", `FAILED: ${error}`);
            io.emit('campaign_progress', { id: campaignId, type: 'failed' });
        } catch (err) {
            console.error('DB Insert Error (FAILED):', err);
        }
    }

    io.emit('log', `Failed to ${phone}: ${error}`);
    logToDb('ERROR', `Failed to ${phone}: ${error}`);
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
