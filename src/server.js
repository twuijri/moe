const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');

// Run database migrations first
require('./auto_migrate');

const db = require('./db');
const whatsappManager = require('./whatsapp-manager');
const { extractTenant } = require('./middleware/tenant');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Pass IO to WhatsApp Manager
whatsappManager.setSocket(io);

// Logging Helper
function logToDb(tenantId, level, message) {
    console.log(`[${level}] [Tenant: ${tenantId}] ${message}`);
    try {
        db.addSystemLog(tenantId, level, message);
    } catch (err) {
        console.error('Failed to write to system log:', err);
    }
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Session Config (SQLite)
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: path.join(__dirname, '../data')
    }),
    secret: 'supersecret_saas_key_change_me',
    resave: false,
    saveUninitialized: false, // Don't save empty sessions
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        sameSite: 'lax',
        httpOnly: true
    }
}));

// Upload Config
const upload = multer({ storage: multer.memoryStorage() });

// --- SUPER ADMIN ROUTES ---
const superRouter = express.Router();

superRouter.post('/login', (req, res) => {
    const { username, password } = req.body;
    const admin = db.getSuperAdminByUsername(username);
    if (admin && bcrypt.compareSync(password, admin.password_hash)) {
        req.session.isSuperAdmin = true;
        req.session.username = username;
        return res.json({ success: true });
    }
    res.status(401).json({ error: 'Invalid credentials' });
});

superRouter.use((req, res, next) => {
    if (!req.session.isSuperAdmin) {
        console.log(`[AUTH FAIL] Super Admin access denied. Session ID: ${req.sessionID}, isSuperAdmin: ${req.session.isSuperAdmin}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

superRouter.get('/tenants', (req, res) => {
    res.json(db.getAllTenants());
});

superRouter.post('/tenants', (req, res) => {
    const { slug, name, adminUsername, adminPassword, phoneNumber } = req.body;
    try {
        db.createTenant(slug, name, adminUsername, adminPassword, phoneNumber);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

superRouter.put('/tenants/:id', (req, res) => {
    const { slug, name, adminUsername, password, phoneNumber, subscriptionEnd, isActive } = req.body;

    let adminPasswordHash = null;
    if (password && password.trim()) {
        adminPasswordHash = bcrypt.hashSync(password.trim(), 10);
    }

    try {
        db.updateTenant(req.params.id, {
            slug,
            name,
            adminUsername,
            adminPasswordHash,
            phoneNumber,
            subscriptionEnd,
            isActive
        });
        res.json({ success: true });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint')) {
            return res.status(400).json({ error: 'الرابط (Slug) مستخدم بالفعل' });
        }
        res.status(400).json({ error: err.message });
    }
});

superRouter.post('/tenants/:id/extend', (req, res) => {
    const { days } = req.body;
    try {
        db.extendTenantSubscription(req.params.id, parseInt(days));
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

superRouter.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

superRouter.delete('/tenants/:id', (req, res) => {
    try {
        db.deleteTenant(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.use('/super/api', superRouter);

// --- TENANT ROUTES (/:slug/api/...) ---
const tenantRouter = express.Router({ mergeParams: true });

// Check Auth Middleware (Tenant Specific)
const requireAuth = (req, res, next) => {
    if (!req.session.tenantId || req.session.tenantId !== req.tenantId || !req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

const requireAdmin = (req, res, next) => {
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// --- AUTH ROUTES ---

// Global Login (Fallback for Super Admin or Ambiguous)
app.post('/api/login', (req, res) => {
    let { username, password } = req.body;
    console.log(`[AUTH] Login attempt: ${username}`); // Debug Log
    username = username ? username.trim() : '';
    password = password ? password.trim() : '';

    // Check Super Admin first
    const admin = db.getSuperAdminByUsername(username);
    if (admin && bcrypt.compareSync(password, admin.password_hash)) {
        req.session.isSuperAdmin = true;
        req.session.username = username;
        return res.json({ success: true, role: 'superadmin', redirect: '/super' });
    }

    res.status(401).json({ error: 'Invalid credentials or missing tenant URL' });
});

// Login (Tenant Specific)
tenantRouter.post('/login', (req, res) => {
    const { username, password } = req.body;
    let user = null;

    // 1. Check Tenant Admin (School Admin)
    if (req.tenant.admin_username === username && bcrypt.compareSync(password, req.tenant.admin_password_hash)) {
        user = {
            id: 'admin', // Special ID for main admin
            username: req.tenant.admin_username,
            role: 'admin'
        };
        logToDb(req.tenantId, 'INFO', `Tenant Admin logged in`);
    } else {
        // 2. Check Sub-Users
        user = db.getUserByUsername(req.tenantId, username);
    }

    if (user) {
        // Verify password for sub-users (already verified for admin)
        if (user.role === 'admin' || bcrypt.compareSync(password, user.password_hash)) {
            // Set Session
            req.session.tenantId = req.tenantId;
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;

            logToDb(req.tenantId, 'INFO', `User logged in: ${username}`);
            return res.json({ success: true, user: { username: user.username, role: user.role } });
        }
    }

    logToDb(req.tenantId, 'WARN', `Failed login attempt: ${username}`);
    res.status(401).json({ error: 'Invalid credentials' });
});

tenantRouter.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Protected Routes
tenantRouter.use(requireAuth);

tenantRouter.get('/me', (req, res) => {
    res.json({
        id: req.tenantId,
        username: req.session.username,
        role: req.session.role,
        tenant: req.tenant.name,
        daysLeft: db.getTenantSubscriptionDaysLeft(req.tenantId)
    });
});

// Settings
tenantRouter.get('/settings', (req, res) => {
    // Also include subscription info?
    const settings = db.getSettings(req.tenantId);
    res.json(settings);
});

tenantRouter.post('/settings', requireAdmin, (req, res) => {
    const { siteName } = req.body;
    if (siteName) db.updateSetting(req.tenantId, 'site_name', siteName);
    res.json({ success: true });
});

tenantRouter.post('/settings/logo', requireAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname);
    // Store per tenant? "site_logo_tenantID"
    const filename = `site_logo_${req.tenantId}${ext}`;
    const targetPath = path.join(__dirname, '../public', filename);
    fs.writeFileSync(targetPath, req.file.buffer);
    db.updateSetting(req.tenantId, 'site_logo', filename);
    res.json({ success: true, path: filename });
});

// Users
tenantRouter.get('/users', requireAdmin, (req, res) => {
    res.json(db.getAllUsers(req.tenantId));
});

tenantRouter.post('/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    try {
        db.createUser(req.tenantId, username, password, role || 'user');
        logToDb(req.tenantId, 'INFO', `User created: ${username}`);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

tenantRouter.delete('/users/:id', requireAdmin, (req, res) => {
    try {
        db.deleteUser(req.tenantId, req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Students
tenantRouter.get('/students', (req, res) => {
    const students = db.getAllStudents(req.tenantId);
    res.json(students);
});

tenantRouter.post('/students', requireAdmin, (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone || phone.length < 9) {
        return res.status(400).json({ error: 'رقم الجوال يجب أن يكون 9 أرقام على الأقل' });
    }
    try {
        db.addStudent(req.tenantId, name, phone);
        res.json({ success: true });
    } catch (err) {
        if (err.message.includes('already exists')) {
            return res.status(400).json({ error: 'رقم الجوال مسجل مسبقاً لهذا الطالب' });
        }
        res.status(400).json({ error: err.message });
    }
});

tenantRouter.delete('/students/:id', requireAdmin, (req, res) => {
    try {
        db.deleteStudent(req.tenantId, req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bulk Delete Students
tenantRouter.post('/students/bulk-delete', requireAdmin, (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No student IDs provided' });
        }

        let deleted = 0;
        for (const id of ids) {
            try {
                db.deleteStudent(req.tenantId, id);
                deleted++;
            } catch (err) {
                console.error(`Failed to delete student ${id}:`, err);
            }
        }

        res.json({ success: true, deleted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bulk Edit Students
tenantRouter.post('/students/bulk-edit', requireAdmin, (req, res) => {
    try {
        const { ids, classNumber, gradeNumber } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No student IDs provided' });
        }

        let updated = 0;
        for (const id of ids) {
            try {
                db.updateStudentClassGrade(req.tenantId, id, classNumber, gradeNumber);
                updated++;
            } catch (err) {
                console.error(`Failed to update student ${id}:`, err);
            }
        }

        res.json({ success: true, updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



tenantRouter.post('/upload', requireAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1 }); // Read as array of arrays

        const studentsToAdd = [];

        // Skip first 4 rows (empty rows, title, and header)
        // Row 0-2: Empty/Title rows
        // Row 3: Headers (الجوال، الفصل، رقم الصف، اسم الطالب، رقم الطالب)
        // Row 4+: Actual student data
        for (let i = 4; i < data.length; i++) {
            const row = data[i];
            if (!row || row.length === 0) continue;

            // Column mapping based on the Excel file structure:
            // Column 0: الجوال (Phone)
            // Column 1: الفصل (Class)
            // Column 2: رقم الصف (Grade/Classroom Number)
            // Column 3: اسم الطالب (Student Name)
            // Column 4: رقم الطالب (Student ID / National ID)

            const phone = row[0] ? String(row[0]).replace(/\D/g, '') : null;
            const classNumber = row[1] ? parseInt(row[1]) : null;
            const gradeNumber = row[2] ? String(row[2]) : null;
            const name = row[3] || 'Unknown';
            const studentId = row[4] ? String(row[4]) : null;

            if (phone && phone.length >= 9) {
                studentsToAdd.push({
                    name,
                    phone,
                    classNumber,
                    studentId,
                    gradeNumber
                });
            }
        }

        const result = db.addStudentsBulk(req.tenantId, studentsToAdd);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download Excel Template
tenantRouter.get('/template', (req, res) => {
    const templatePath = path.join(__dirname, '../public/templates/student_template.xlsx');
    res.download(templatePath, 'نموذج_الطلاب.xlsx', (err) => {
        if (err) {
            console.error('Error downloading template:', err);
            res.status(500).json({ error: 'Failed to download template' });
        }
    });
});

// Campaigns
tenantRouter.get('/campaigns', (req, res) => {
    res.json(db.getCampaigns(req.tenantId));
});

tenantRouter.post('/campaign', (req, res) => {
    const { name, message, studentIds } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    let targets = [];
    const allStudents = db.getAllStudents(req.tenantId);

    if (studentIds === 'all') {
        targets = allStudents;
    } else if (Array.isArray(studentIds)) {
        targets = allStudents.filter(s => studentIds.includes(s.id));
    }

    if (targets.length === 0) return res.status(400).json({ error: 'No students selected' });

    const result = db.createCampaign(req.tenantId, name || 'Campaign', targets.length, req.session.userId);
    const campaignId = result.lastInsertRowid;

    console.log(`Starting campaign ${campaignId} for Tenant ${req.tenantId}`);

    // Send via WhatsApp Manager
    targets.forEach(student => {
        whatsappManager.send(req.tenantId, student.phone_number, message, campaignId);
    });

    res.json({ success: true, count: targets.length });
});

// WhatsApp Status (Tenant Specific)
tenantRouter.get('/status', (req, res) => {
    // If client not init, init it
    whatsappManager.getClient(req.tenantId);
    res.json(whatsappManager.getStatus(req.tenantId));
});

// Mount Tenant Router
app.use('/:slug/api', extractTenant, tenantRouter);

// Super Admin UI Routing (Must define BEFORE /:slug wildcard)
app.get('/super', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/super_admin.html'));
});

app.get('/super/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/login.html'));
});

// Frontend Routing Helper
// Serve dashboard.html for tenant routes
app.get('/:slug', extractTenant, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});
app.get('/:slug/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/login.html'));
});

// Socket.io Connection Logic
io.on('connection', (socket) => {
    console.log('New client connected to socket');

    socket.on('join', (tenantId) => {
        if (tenantId) {
            console.log(`Socket joining room: tenant_${tenantId}`);
            socket.join(`tenant_${tenantId}`);

            // Ensure client is initialized
            whatsappManager.getClient(tenantId);

            // Send immediate status if available
            const status = whatsappManager.getStatus(tenantId);
            socket.emit('status_update', status);
            if (status.qr) socket.emit('qr', status.qr);
            if (status.ready) socket.emit('ready');
        }
    });

    socket.on('disconnect', () => {
        // console.log('Client disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
