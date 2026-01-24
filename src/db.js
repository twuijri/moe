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

// Initialize Tables (Will create history if dropped above)
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user', -- 'admin' or 'user'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone_number TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'processing', -- processing, completed
        total_msg INTEGER DEFAULT 0,
        sent_msg INTEGER DEFAULT 0,
        failed_msg INTEGER DEFAULT 0,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER,
        recipient TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
    );

    CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL, -- INFO, WARN, ERROR
        message TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

// Create Default Admin if not exists
const admin = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', hash, 'admin');
    console.log('Default admin account created: admin / admin123');
}

module.exports = {
    // Settings Methods
    getSettings: () => {
        const rows = db.prepare('SELECT * FROM settings').all();
        // Convert to object
        return rows.reduce((acc, row) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
    },
    updateSetting: (key, value) => {
        return db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
    },

    // System Log Methods
    addSystemLog: (level, message) => {
        db.prepare('INSERT INTO system_logs (level, message) VALUES (?, ?)').run(level, message);
    },
    getSystemLogs: (limit = 100) => {
        return db.prepare('SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
    },

    // User Methods
    getUserByUsername: (username) => {
        return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    },
    getUserById: (id) => {
        return db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
    },
    createUser: (username, password, role) => {
        const hash = bcrypt.hashSync(password, 10);
        try {
            return db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role);
        } catch (err) {
            if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('Username exists');
            throw err;
        }
    },
    getAllUsers: () => {
        return db.prepare('SELECT id, username, role, created_at FROM users').all();
    },
    deleteUser: (id) => {
        return db.prepare('DELETE FROM users WHERE id = ?').run(id);
    },

    // Student Methods
    getAllStudents: () => {
        const stmt = db.prepare('SELECT * FROM students ORDER BY name ASC');
        return stmt.all();
    },
    addStudent: (name, phoneNumber) => {
        try {
            const stmt = db.prepare('INSERT INTO students (name, phone_number) VALUES (?, ?)');
            return stmt.run(name, phoneNumber);
        } catch (err) {
            if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                throw new Error('Phone number already exists');
            }
            throw err;
        }
    },
    deleteStudent: (id) => {
        const stmt = db.prepare('DELETE FROM students WHERE id = ?');
        return stmt.run(id);
    },
    // Bulk Import (Transaction)
    addStudentsBulk: (students) => {
        const insert = db.prepare('INSERT INTO students (name, phone_number) VALUES (@name, @phone)');
        const insertMany = db.transaction((list) => {
            let added = 0;
            let errors = 0;
            for (const student of list) {
                try {
                    insert.run(student);
                    added++;
                } catch (err) {
                    errors++;
                }
            }
            return { added, errors };
        });
        return insertMany(students);
    },

    // Campaign Methods
    createCampaign: (name, total, userId) => {
        const stmt = db.prepare('INSERT INTO campaigns (name, total_msg, created_by) VALUES (?, ?, ?)');
        return stmt.run(name, total, userId);
    },
    getCampaigns: () => {
        return db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    },
    getCampaignHistory: (campaignId) => {
        return db.prepare('SELECT * FROM history WHERE campaign_id = ?').all(campaignId);
    },
    updateCampaignStats: (id, status) => {
        // status: 'sent' or 'failed'
        if (status === 'sent') {
            db.prepare('UPDATE campaigns SET sent_msg = sent_msg + 1 WHERE id = ?').run(id);
        } else {
            db.prepare('UPDATE campaigns SET failed_msg = failed_msg + 1 WHERE id = ?').run(id);
        }
    },
    getFailedRecipients: (campaignId) => {
        // Get unique recipients who FAILED and did NOT succeed later (simplified: just get all failed attempts? 
        // Strategy: Get distinct recipient who has NO 'SENT' status in this campaign.
        const stmt = db.prepare(`
            SELECT DISTINCT recipient 
            FROM history 
            WHERE campaign_id = ? AND recipient NOT IN (
                SELECT recipient FROM history WHERE campaign_id = ? AND status = 'SENT'
            )
         `);
        return stmt.all(campaignId, campaignId);
    },

    // History Methods
    logMessage: (campaignId, recipient, message, status) => {
        const stmt = db.prepare('INSERT INTO history (campaign_id, recipient, message, status) VALUES (?, ?, ?, ?)');
        return stmt.run(campaignId, recipient, message, status);
    },
    getRecentHistory: (limit = 50) => {
        const stmt = db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT ?');
        return stmt.all(limit);
    }
};
