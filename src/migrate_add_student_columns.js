const Database = require('better-sqlite3');
const path = require('path');

// Migration script to add class_number and student_id columns to students table

const dataDir = path.join(__dirname, '../data');
const db = new Database(path.join(dataDir, 'saas.db'), { verbose: console.log });

console.log('🔄 Running database migration...');

try {
    // Check if columns already exist
    const tableInfo = db.prepare("PRAGMA table_info(students)").all();
    const hasClassNumber = tableInfo.some(col => col.name === 'class_number');
    const hasStudentId = tableInfo.some(col => col.name === 'student_id');

    if (!hasClassNumber) {
        console.log('Adding class_number column...');
        db.exec('ALTER TABLE students ADD COLUMN class_number INTEGER');
        console.log('✅ Added class_number column');
    } else {
        console.log('⏭️  class_number column already exists');
    }

    if (!hasStudentId) {
        console.log('Adding student_id column...');
        db.exec('ALTER TABLE students ADD COLUMN student_id TEXT');
        console.log('✅ Added student_id column');
    } else {
        console.log('⏭️  student_id column already exists');
    }

    console.log('✅ Migration completed successfully!');
} catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
}

db.close();
