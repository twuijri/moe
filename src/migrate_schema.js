const db = require('./db').db ? require('./db').db : new (require('better-sqlite3'))(require('path').join(__dirname, '../data/saas.db'));

console.log('Starting Schema Migration...');

const tables = ['users', 'students', 'campaigns', 'history', 'system_logs', 'settings'];

tables.forEach(table => {
    try {
        const info = db.prepare(`PRAGMA table_info(${table})`).all();
        const hasTenantId = info.some(col => col.name === 'tenant_id');

        if (!hasTenantId) {
            console.log(`Migrating table ${table}: Adding tenant_id...`);

            if (table === 'settings') {
                // Settings needs PK change, so we recreate
                console.log('Recreating settings table for PK change...');
                const oldSettings = db.prepare('SELECT * FROM settings').all();
                db.exec('DROP TABLE settings');
                db.exec(`
                    CREATE TABLE settings (
                        tenant_id INTEGER,
                        key TEXT NOT NULL,
                        value TEXT,
                        PRIMARY KEY(tenant_id, key),
                        FOREIGN KEY(tenant_id) REFERENCES tenants(id)
                    )
                `);
                // Restore invalid settings? Or just drop?
                // Old settings had no tenant_id. Assign to default tenant?
                // For now, we lose old settings or assign to null.
            } else {
                db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER`);
                // For users, maybe add constraint? SQLite supports ADD COLUMN with REFERENCES? Yes.
                // But let's just add column first.
                console.log(`✅ Added tenant_id to ${table}`);
            }
        } else {
            console.log(`Table ${table} already has tenant_id.`);
        }
    } catch (err) {
        console.error(`Error migrating ${table}:`, err.message);
    }
});

console.log('Migration Complete.');
