const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const db = new Database(path.join(dataDir, 'saas.db'), { verbose: console.log });
db.pragma('journal_mode = WAL');

// Schema Migration / Fix
try {
    const tableInfo = db.prepare("PRAGMA table_info(history)").all();
    const hasCampaignId = tableInfo.some(col => col.name === 'campaign_id');

    if (tableInfo.length > 0 && !hasCampaignId) {
        console.warn('CRITICAL: Detected old database schema (history table missing campaign_id). Recreating table...');
        db.exec('DROP TABLE history');
    }
} catch (err) {
    console.error('Schema check failed:', err);
}

// Initialize Multi-Tenant Tables
db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        admin_username TEXT NOT NULL,
        admin_password_hash TEXT NOT NULL,
        phone_number TEXT,
        subscription_end DATE NOT NULL,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS super_admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(tenant_id) REFERENCES tenants(id),
        UNIQUE(tenant_id, username)
    );

    CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        name TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(tenant_id) REFERENCES tenants(id),
        UNIQUE(tenant_id, phone_number)
    );

    CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'processing',
        total_msg INTEGER DEFAULT 0,
        sent_msg INTEGER DEFAULT 0,
        failed_msg INTEGER DEFAULT 0,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(tenant_id) REFERENCES tenants(id)
    );

    CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        campaign_id INTEGER,
        recipient TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(tenant_id) REFERENCES tenants(id),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
    );

    CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(tenant_id) REFERENCES tenants(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
        tenant_id INTEGER,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY(tenant_id, key),
        FOREIGN KEY(tenant_id) REFERENCES tenants(id)
    );
`);

// Create Default Super Admin
const superAdmin = db.prepare('SELECT * FROM super_admins WHERE username = ?').get('superadmin');
if (!superAdmin) {
    const hash = bcrypt.hashSync('SuperAdmin@123', 10);
    db.prepare('INSERT INTO super_admins (username, password_hash) VALUES (?, ?)').run('superadmin', hash);
    console.log('✅ Default Super Admin created: superadmin / SuperAdmin@123');
}

module.exports = {
    // ===== SUPER ADMIN METHODS =====
    getSuperAdminByUsername: (username) => {
        return db.prepare('SELECT * FROM super_admins WHERE username = ?').get(username);
    },

    // ===== TENANT MANAGEMENT =====
    getAllTenants: () => {
        return db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
    },

    getTenantBySlug: (slug) => {
        return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
    },

    getTenantById: (id) => {
        return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    },

    createTenant: (slug, name, adminUsername, adminPassword, phoneNumber, subscriptionDays = 30) => {
        const hash = bcrypt.hashSync(adminPassword, 10);
        const subscriptionEnd = new Date();
        subscriptionEnd.setDate(subscriptionEnd.getDate() + subscriptionDays);

        return db.prepare(`
            INSERT INTO tenants (slug, name, admin_username, admin_password_hash, phone_number, subscription_end)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(slug, name, adminUsername, hash, phoneNumber, subscriptionEnd.toISOString().split('T')[0]);
    },

    updateTenant: (id, data) => {
        const { slug, name, adminUsername, adminPasswordHash, phoneNumber, subscriptionEnd, isActive } = data;
        return db.prepare(`
            UPDATE tenants 
            SET slug = COALESCE(?, slug),
                name = COALESCE(?, name),
                admin_username = COALESCE(?, admin_username),
                admin_password_hash = COALESCE(?, admin_password_hash),
                phone_number = COALESCE(?, phone_number),
                subscription_end = COALESCE(?, subscription_end),
                is_active = COALESCE(?, is_active)
            WHERE id = ?
        `).run(slug, name, adminUsername, adminPasswordHash, phoneNumber, subscriptionEnd, isActive, id);
    },

    extendTenantSubscription: (id, additionalDays) => {
        const tenant = db.prepare('SELECT subscription_end FROM tenants WHERE id = ?').get(id);
        if (!tenant) throw new Error('Tenant not found');

        const currentEnd = new Date(tenant.subscription_end);
        const now = new Date();
        const baseDate = currentEnd > now ? currentEnd : now;
        baseDate.setDate(baseDate.getDate() + additionalDays);

        return db.prepare('UPDATE tenants SET subscription_end = ?, is_active = 1 WHERE id = ?')
            .run(baseDate.toISOString().split('T')[0], id);
    },

    deactivateTenant: (id) => {
        return db.prepare('UPDATE tenants SET is_active = 0 WHERE id = ?').run(id);
    },

    deleteTenant: (id) => {
        // Cascade delete all tenant data
        db.prepare('DELETE FROM settings WHERE tenant_id = ?').run(id);
        db.prepare('DELETE FROM system_logs WHERE tenant_id = ?').run(id);
        db.prepare('DELETE FROM history WHERE tenant_id = ?').run(id);
        db.prepare('DELETE FROM campaigns WHERE tenant_id = ?').run(id);
        db.prepare('DELETE FROM students WHERE tenant_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE tenant_id = ?').run(id);
        return db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
    },

    getTenantSubscriptionDaysLeft: (tenantId) => {
        const tenant = db.prepare('SELECT subscription_end FROM tenants WHERE id = ?').get(tenantId);
        if (!tenant) return null;

        const end = new Date(tenant.subscription_end);
        const now = new Date();
        const diffTime = end - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    },

    // ===== SETTINGS (Tenant-Aware) =====
    getSettings: (tenantId) => {
        const rows = db.prepare('SELECT * FROM settings WHERE tenant_id = ?').all(tenantId);
        return rows.reduce((acc, row) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
    },

    updateSetting: (tenantId, key, value) => {
        return db.prepare(`
            INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) 
            ON CONFLICT(tenant_id, key) DO UPDATE SET value = ?
        `).run(tenantId, key, value, value);
    },

    // ===== SYSTEM LOGS (Tenant-Aware) =====
    addSystemLog: (tenantId, level, message) => {
        db.prepare('INSERT INTO system_logs (tenant_id, level, message) VALUES (?, ?, ?)')
            .run(tenantId, level, message);
    },

    getSystemLogs: (tenantId, limit = 100) => {
        return db.prepare('SELECT * FROM system_logs WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT ?')
            .all(tenantId, limit);
    },

    // ===== USERS (Tenant-Aware) =====
    getUserByUsername: (tenantId, username) => {
        return db.prepare('SELECT * FROM users WHERE tenant_id = ? AND username = ?').get(tenantId, username);
    },

    getAllUsers: (tenantId) => {
        return db.prepare('SELECT id, username, role, created_at FROM users WHERE tenant_id = ?').all(tenantId);
    },

    createUser: (tenantId, username, password, role = 'user') => {
        const hash = bcrypt.hashSync(password, 10);
        try {
            return db.prepare('INSERT INTO users (tenant_id, username, password_hash, role) VALUES (?, ?, ?, ?)')
                .run(tenantId, username, hash, role);
        } catch (err) {
            if (err.message.includes('UNIQUE constraint')) throw new Error('Username already exists');
            throw err;
        }
    },

    deleteUser: (tenantId, userId) => {
        return db.prepare('DELETE FROM users WHERE tenant_id = ? AND id = ?').run(tenantId, userId);
    },

    // ===== STUDENTS (Tenant-Aware) =====
    getAllStudents: (tenantId) => {
        return db.prepare('SELECT * FROM students WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
    },

    addStudent: (tenantId, name, phone, classNumber = null, studentId = null, gradeNumber = null) => {
        try {
            return db.prepare('INSERT INTO students (tenant_id, name, phone_number, class_number, student_id, grade_number) VALUES (?, ?, ?, ?, ?, ?)')
                .run(tenantId, name, phone, classNumber, studentId, gradeNumber);
        } catch (err) {
            if (err.message.includes('UNIQUE constraint')) {
                throw new Error('Phone number already exists for this tenant');
            }
            throw err;
        }
    },

    addStudentsBulk: (tenantId, students) => {
        const insert = db.prepare('INSERT INTO students (tenant_id, name, phone_number, class_number, student_id, grade_number) VALUES (?, ?, ?, ?, ?, ?)');
        let added = 0, skipped = 0;

        for (const student of students) {
            try {
                insert.run(tenantId, student.name, student.phone, student.classNumber || null, student.studentId || null, student.gradeNumber || null);
                added++;
            } catch (err) {
                if (err.message.includes('UNIQUE constraint')) {
                    skipped++;
                } else {
                    throw err;
                }
            }
        }
        return { added, skipped };
    },

    deleteStudent: (tenantId, studentId) => {
        return db.prepare('DELETE FROM students WHERE tenant_id = ? AND id = ?').run(tenantId, studentId);
    },

    updateCampaignStatus: (tenantId, campaignId, status) => {
        db.prepare('UPDATE campaigns SET status = ? WHERE tenant_id = ? AND id = ?').run(status, tenantId, campaignId);
    },

    getCampaignMessages: (tenantId, campaignId) => {
        return db.prepare('SELECT * FROM history WHERE tenant_id = ? AND campaign_id = ? ORDER BY timestamp DESC').all(tenantId, campaignId);
    },

    updateStudentClassGrade: (tenantId, studentId, classNumber, gradeNumber) => {
        const updates = [];
        const params = [];

        if (classNumber !== null && classNumber !== undefined) {
            updates.push('class_number = ?');
            params.push(classNumber);
        }

        if (gradeNumber !== null && gradeNumber !== undefined) {
            updates.push('grade_number = ?');
            params.push(gradeNumber);
        }

        if (updates.length === 0) return { changes: 0 };

        params.push(tenantId, studentId);
        const query = `UPDATE students SET ${updates.join(', ')} WHERE tenant_id = ? AND id = ?`;
        return db.prepare(query).run(...params);
    },

    // ===== CAMPAIGNS (Tenant-Aware) =====
    createCampaign: (tenantId, name, totalMsg, createdBy) => {
        return db.prepare(`
            INSERT INTO campaigns (tenant_id, name, total_msg, created_by) 
            VALUES (?, ?, ?, ?)
        `).run(tenantId, name, totalMsg, createdBy);
    },

    getCampaigns: (tenantId) => {
        return db.prepare('SELECT * FROM campaigns WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
    },

    updateCampaignStats: (tenantId, campaignId, type) => {
        const field = type === 'sent' ? 'sent_msg' : 'failed_msg';
        return db.prepare(`UPDATE campaigns SET ${field} = ${field} + 1 WHERE tenant_id = ? AND id = ?`)
            .run(tenantId, campaignId);
    },

    getCampaignHistory: (tenantId, campaignId) => {
        return db.prepare('SELECT * FROM history WHERE tenant_id = ? AND campaign_id = ? ORDER BY timestamp DESC')
            .all(tenantId, campaignId);
    },

    getFailedRecipients: (tenantId, campaignId) => {
        return db.prepare(`
            SELECT DISTINCT recipient, message 
            FROM history 
            WHERE tenant_id = ? AND campaign_id = ? AND status LIKE 'FAILED%'
        `).all(tenantId, campaignId);
    },

    logMessage: (tenantId, campaignId, recipient, message, status) => {
        return db.prepare(`
            INSERT INTO history (tenant_id, campaign_id, recipient, message, status) 
            VALUES (?, ?, ?, ?, ?)
        `).run(tenantId, campaignId, recipient, message, status);
    }
};
