const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Auto-run all necessary migrations on server startup

const dataDir = path.join(__dirname, '../data');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'saas.db');
const db = new Database(dbPath, { verbose: console.log });

console.log('🔄 Running automatic database migrations...');

try {
    // Migration 1: Add class_number and student_id columns
    const tableInfo = db.prepare("PRAGMA table_info(students)").all();
    const hasClassNumber = tableInfo.some(col => col.name === 'class_number');
    const hasStudentId = tableInfo.some(col => col.name === 'student_id');

    if (!hasClassNumber) {
        console.log('  ➤ Adding class_number column...');
        db.exec('ALTER TABLE students ADD COLUMN class_number INTEGER');
        console.log('  ✅ Added class_number column');
    }

    if (!hasStudentId) {
        console.log('  ➤ Adding student_id column...');
        db.exec('ALTER TABLE students ADD COLUMN student_id TEXT');
        console.log('  ✅ Added student_id column');
    }

    // Migration 2: Add grade_number column
    const hasGradeNumber = tableInfo.some(col => col.name === 'grade_number');

    if (!hasGradeNumber) {
        console.log('  ➤ Adding grade_number column...');
        db.exec('ALTER TABLE students ADD COLUMN grade_number TEXT');
        console.log('  ✅ Added grade_number column');
    }

    if (hasClassNumber && hasStudentId && hasGradeNumber) {
        console.log('  ⏭️  All columns already exist, skipping migrations');
    }

    console.log('✅ Database migrations completed successfully!');
} catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
}

db.close();
