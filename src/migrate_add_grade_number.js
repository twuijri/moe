const Database = require('better-sqlite3');
const path = require('path');

// Migration script to add grade_number column to students table

const dataDir = path.join(__dirname, '../data');
const db = new Database(path.join(dataDir, 'saas.db'), { verbose: console.log });

console.log('🔄 Running migration for grade_number...');

try {
    const tableInfo = db.prepare("PRAGMA table_info(students)").all();
    const hasGradeNumber = tableInfo.some(col => col.name === 'grade_number');

    if (!hasGradeNumber) {
        console.log('Adding grade_number column...');
        db.exec('ALTER TABLE students ADD COLUMN grade_number TEXT');
        console.log('✅ Added grade_number column');
    } else {
        console.log('⏭️  grade_number column already exists');
    }

    console.log('✅ Migration completed successfully!');
} catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
}

db.close();
