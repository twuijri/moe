const Database = require('better-sqlite3');
const db = new Database('./data/saas.db');

// Find tenant
const tenant = db.prepare('SELECT id FROM tenants WHERE slug = ?').get('aassy');
if (!tenant) {
    console.log('Tenant not found!');
    process.exit(1);
}

console.log(`Checking students for tenant ID: ${tenant.id}`);

// Get all students
const students = db.prepare('SELECT id, name, phone_number FROM students WHERE tenant_id = ? ORDER BY created_at DESC').all(tenant.id);

console.log(`\nTotal students: ${students.length}\n`);
students.forEach(s => {
    console.log(`ID: ${s.id}, Name: "${s.name}", Phone: "${s.phone_number}"`);
});

// Check specifically for "5555"
const duplicate = db.prepare('SELECT * FROM students WHERE tenant_id = ? AND phone_number = ?').get(tenant.id, '5555');
if (duplicate) {
    console.log('\n⚠️  Found duplicate with phone "5555":');
    console.log(duplicate);
}

db.close();
