const XLSX = require('xlsx');
const path = require('path');

// Create an Excel template file with the correct structure for student import

const templateData = [
    [], // Empty row 0
    [], // Empty row 1
    ['Student  Info Table'], // Row 2: Title
    ['الجوال', 'الفصل', 'رقم الصف', 'اسم الطالب', 'رقم الطالب'], // Row 3: Headers
    ['966500000001', '1', '1314', 'أحمد محمد علي', '1234567890'], // Row 4: Example 1
    ['966500000002', '1', '1314', 'سارة خالد أحمد', '0987654321'], // Row 5: Example 2
    ['966500000003', '2', '1319', 'عمر عبدالله سعيد', '1122334455'], // Row 6: Example 3
];

const ws = XLSX.utils.aoa_to_sheet(templateData);

// Set column widths
ws['!cols'] = [
    { wch: 15 }, // Mobile column
    { wch: 10 }, // Class column
    { wch: 12 }, // Grade column
    { wch: 25 }, // Name column
    { wch: 15 }, // Student ID column
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Students');

// Save the template
const templatePath = path.join(__dirname, '../public/templates/student_template.xlsx');
XLSX.writeFile(wb, templatePath);

console.log('✅ Excel template created successfully at:', templatePath);
