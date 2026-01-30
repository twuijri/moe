const socket = io();

// State
let currentUser = null;
let currentCampaignId = null; // Track viewed campaign for retry
let currentCampaignMessage = ''; // Track message for retry if needed
let studentsData = []; // Global variable to store students for campaign selector

// Helper to get API base path based on tenant slug
function getApiBase() {
    const parts = window.location.pathname.split('/');
    // Format: /:slug or /:slug/login
    // parts[0] is empty, parts[1] is slug
    const slug = parts[1];
    if (slug && slug !== 'super' && slug !== 'login.html') {
        return `/${slug}/api`;
    }
    return '/api'; // Fallback
}

// Helper to determine login URL
function getLoginUrl() {
    const parts = window.location.pathname.split('/');
    const slug = parts[1];
    // If we have a valid slug that isn't a file or super
    if (slug && !slug.includes('.') && slug !== 'super') {
        return `/${slug}/login`;
    }
    return '/login.html';
}

// Auth Check
async function checkAuth() {
    try {
        const res = await fetch(`${getApiBase()}/me`);
        if (res.status === 401) return window.location.href = getLoginUrl();
        currentUser = await res.json();

        document.getElementById('current-user').innerText = `${currentUser.username} (${currentUser.role})`;

        // Show Days Left
        const daysEl = document.getElementById('subscription-days');
        if (daysEl && currentUser.daysLeft !== undefined) {
            daysEl.innerText = `${currentUser.daysLeft} يوم`;
            if (currentUser.daysLeft < 5) daysEl.style.color = '#ff5f5f';
            else daysEl.style.color = '#25d366';
        }

        // Join Socket Room
        if (currentUser.id) {
            socket.emit('join', currentUser.id);
        }

        if (currentUser.role === 'admin') {
            document.getElementById('nav-users').style.display = 'block';
            document.getElementById('nav-logs').style.display = 'block';
            document.getElementById('nav-settings').style.display = 'block';
            const manualAdd = document.getElementById('manual-add-container');
            if (manualAdd) manualAdd.style.display = 'flex';
        }

        // Load initial data
        loadSettings(); // Load branding first
        fetchStudents();
        fetchCampaigns();
        if (currentUser.role === 'admin') fetchUsers();

    } catch (err) {
        window.location.href = getLoginUrl();
    }
}
checkAuth();

async function logout() {
    await fetch(`${getApiBase()}/logout`, { method: 'POST' });
    window.location.href = getLoginUrl();
}

// Navigation
function showView(viewId) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById('view-' + viewId).classList.add('active');

    document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
    const navLink = document.getElementById('nav-' + viewId);
    if (navLink) navLink.classList.add('active');

    // Load student selector when viewing send campaign
    if (viewId === 'send') {
        loadStudentSelector();
    }
}

// --- Socket Events ---
socket.on('status_update', updateStatus);
socket.on('qr', (url) => {
    document.getElementById('qr-container').innerHTML = `<img src="${url}" alt="Scan QR" width="150">`;
    updateStatus({ ready: false, qr: url });
});
socket.on('ready', () => updateStatus({ ready: true }));
socket.on('log', addLog);
socket.on('campaign_progress', (data) => {
    // OLD: fetchCampaigns(); // causing DOM thrashing
    // NEW: Update locally
    updateCampaignRow(data.id, data.type);

    // If viewing this campaign, refresh details too (this might still cause minor refresh issues but details view is different)
    if (currentCampaignId && currentCampaignId == data.id) {
        viewCampaignDetails(currentCampaignId);
    }
});

// --- Logic ---

// Students
async function fetchStudents() {
    const res = await fetch(`${getApiBase()}/students`);
    const students = await res.json();
    studentsData = students; // Store globally
    const tbody = document.getElementById('students-table-body');
    tbody.innerHTML = students.map(s => `
        <tr>
            <td><input type="checkbox" class="student-row-checkbox" value="${s.id}" style="cursor: pointer;"></td>
            <td>${s.name}</td>
            <td>${s.phone_number}</td>
            <td>${s.class_number || '-'}</td>
            <td>${s.grade_number || '-'}</td>
            <td>${s.student_id || '-'}</td>
            <td>${currentUser.role === 'admin' ? `<button class="danger-btn" onclick="deleteStudent(${s.id})">حذف</button>` : '-'}</td>
        </tr>
    `).join('');
}

function toggleAllStudents() {
    const selectAll = document.getElementById('select-all-students');
    const checkboxes = document.querySelectorAll('.student-row-checkbox');
    checkboxes.forEach(cb => cb.checked = selectAll.checked);
}

function getSelectedStudentIds() {
    const checkboxes = document.querySelectorAll('.student-row-checkbox:checked');
    return Array.from(checkboxes).map(cb => parseInt(cb.value));
}

async function bulkDeleteStudents() {
    const ids = getSelectedStudentIds();
    if (ids.length === 0) return alert('الرجاء تحديد طلاب للحذف');
    if (!confirm(`هل تريد حذف ${ids.length} طالب/طالبة؟`)) return;

    try {
        const res = await fetch(`${getApiBase()}/students/bulk-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(`تم حذف ${data.deleted} طالب/طالبة`);
        document.getElementById('select-all-students').checked = false;
        fetchStudents();
    } catch (err) {
        alert(err.message);
    }
}

function openBulkEditModal() {
    const ids = getSelectedStudentIds();
    if (ids.length === 0) return alert('الرجاء تحديد طلاب للتعديل');
    document.getElementById('bulk-edit-modal').style.display = 'flex';
}

function closeBulkEditModal() {
    document.getElementById('bulk-edit-modal').style.display = 'none';
    document.getElementById('bulk-class-number').value = '';
    document.getElementById('bulk-grade-number').value = '';
}

async function saveBulkEdit() {
    const ids = getSelectedStudentIds();
    const classNumber = document.getElementById('bulk-class-number').value;
    const gradeNumber = document.getElementById('bulk-grade-number').value;

    if (!classNumber && !gradeNumber) {
        return alert('الرجاء إدخال رقم الفصل أو رقم الصف');
    }

    try {
        const res = await fetch(`${getApiBase()}/students/bulk-edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ids,
                classNumber: classNumber ? parseInt(classNumber) : null,
                gradeNumber: gradeNumber || null
            })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(`تم تعديل ${data.updated} طالب/طالبة`);
        closeBulkEditModal();
        document.getElementById('select-all-students').checked = false;
        fetchStudents();
    } catch (err) {
        alert(err.message);
    }
}

async function deleteStudent(id) {
    if (!confirm('هل أنت متأكد من الحذف؟')) return;
    await fetch(`${getApiBase()}/students/${id}`, { method: 'DELETE' });
    fetchStudents();
}

function filterStudents() {
    const term = document.getElementById('search-student').value.toLowerCase();
    const rows = document.querySelectorAll('#students-table-body tr');
    rows.forEach(row => {
        row.style.display = row.innerText.toLowerCase().includes(term) ? '' : 'none';
    });
}

// Excel Upload
function openModal() { document.getElementById('upload-modal').style.display = 'flex'; }
function closeModal() { document.getElementById('upload-modal').style.display = 'none'; }

async function uploadExcel() {
    const fileInput = document.getElementById('excel-file');
    const file = fileInput.files[0];
    if (!file) return alert('الرجاء اختيار ملف');

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch(`${getApiBase()}/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(`تم الرفع! تمت الاضافة: ${data.added}, مكرر / أخطاء: ${data.skipped || data.errors || 0}`);
        closeModal();
        fetchStudents();
    } catch (err) {
        alert(err.message);
    }
}

function downloadTemplate() {
    window.location.href = `${getApiBase()}/template`;
}

async function addStudentManual() {
    const name = document.getElementById('manual-name').value;
    const phone = document.getElementById('manual-phone').value;

    if (!name || !phone || phone.length < 9) return alert('الرجاء ادخال الاسم ورقم الجوال الصحيح (9 أرقام على الأقل)');

    try {
        const res = await fetch(`${getApiBase()}/students`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, phone })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert('تمت الإضافة بنجاح');
        document.getElementById('manual-name').value = '';
        document.getElementById('manual-phone').value = '';
        fetchStudents();
    } catch (err) {
        alert(err.message);
    }
}

// Student Selection for Campaigns
function loadStudentSelector() {
    const selector = document.getElementById('student-selector');
    if (!studentsData || studentsData.length === 0) {
        selector.innerHTML = '<p style="color: #999; text-align: center;">لا يوجد طلاب مسجلين</p>';
        return;
    }

    // Populate class filter dropdown
    const classFilter = document.getElementById('class-filter');
    const classes = [...new Set(studentsData.map(s => s.class_number).filter(c => c !== null))];
    classes.sort((a, b) => a - b);

    classFilter.innerHTML = '<option value="all">جميع الفصول</option>' +
        classes.map(c => `<option value="${c}">الفصل ${c}</option>`).join('');

    // Populate grade filter dropdown
    const gradeFilter = document.getElementById('grade-filter');
    const grades = [...new Set(studentsData.map(s => s.grade_number).filter(g => g !== null))];
    grades.sort();

    gradeFilter.innerHTML = '<option value="all">جميع الصفوف</option>' +
        grades.map(g => `<option value="${g}">صف ${g}</option>`).join('');

    renderStudentCheckboxes();
}

function renderStudentCheckboxes() {
    const selector = document.getElementById('student-selector');
    const classFilter = document.getElementById('class-filter');
    const gradeFilter = document.getElementById('grade-filter');
    const selectedClass = classFilter ? classFilter.value : 'all';
    const selectedGrade = gradeFilter ? gradeFilter.value : 'all';

    let filteredStudents = studentsData;

    // Apply class filter
    if (selectedClass !== 'all') {
        filteredStudents = filteredStudents.filter(s => s.class_number == selectedClass);
    }

    // Apply grade filter
    if (selectedGrade !== 'all') {
        filteredStudents = filteredStudents.filter(s => s.grade_number == selectedGrade);
    }

    if (filteredStudents.length === 0) {
        selector.innerHTML = '<p style="color: #999; text-align: center; padding: 10px;">لا توجد نتائج للفلتر المحدد</p>';
        return;
    }

    selector.innerHTML = filteredStudents.map(student => {
        const classInfo = student.class_number ? `فصل ${student.class_number}` : '';
        const gradeInfo = student.grade_number ? `صف ${student.grade_number}` : '';
        const info = [classInfo, gradeInfo].filter(x => x).join(' - ');

        return `
        <label style="display: block; padding: 8px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.05);" class="student-label">
            <input type="checkbox" class="student-checkbox" value="${student.id}" style="margin-left: 8px;">
            ${student.name} ${info ? `(${info})` : ''} - ${student.phone_number}
        </label>
    `;
    }).join('');
}

function filterStudentsByFilters() {
    renderStudentCheckboxes();
}

function selectAllStudents() {
    document.querySelectorAll('.student-checkbox').forEach(cb => cb.checked = true);
}

function deselectAllStudents() {
    document.querySelectorAll('.student-checkbox').forEach(cb => cb.checked = false);
}

// Campaigns
async function startCampaign() {
    const name = document.getElementById('campaign-name').value;
    const message = document.getElementById('message-content').value;
    if (!message) return alert('الرجاء كتابة نص الرسالة');

    // Get selected student IDs
    const selectedIds = Array.from(document.querySelectorAll('.student-checkbox:checked'))
        .map(cb => parseInt(cb.value));

    if (selectedIds.length === 0) {
        return alert('الرجاء اختيار طالب واحد على الأقل');
    }

    if (!confirm('هل تريد بدء إرسال الحملة؟')) return;

    try {
        const res = await fetch(`${getApiBase()}/campaign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, message, studentIds: selectedIds })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(`تم بدء الحملة! سيتم إرسال ${data.count} رسالة.`);
        document.getElementById('message-content').value = '';
        showView('campaigns');
        fetchCampaigns();
    } catch (err) {
        alert(err.message);
    }
}

async function fetchCampaigns() {
    const res = await fetch(`${getApiBase()}/campaigns`);
    const campaigns = await res.json();
    const listContainer = document.getElementById('campaigns-list');

    listContainer.innerHTML = campaigns.map(c => `
        <div id="camp-row-${c.id}" class="glass-card" style="margin-bottom: 10px; padding: 10px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="viewCampaignDetails(${c.id}, '${c.name ? c.name.replace(/'/g, "\\'") : 'بدون اسم'}')">
            <div>
                <strong>${c.name || 'بدون اسم'}</strong><br>
                <small>${new Date(c.created_at).toLocaleString('ar-SA')}</small>
            </div>
            <div style="text-align: left; direction: ltr;">
                <span id="camp-sent-${c.id}" style="color: #25d366" title="تم الارسال">✔ ${c.sent_msg}</span> / 
                <span id="camp-failed-${c.id}" style="color: #ff5f5f" title="فشل">❌ ${c.failed_msg}</span> / 
                <span id="camp-pending-${c.id}" style="color: #aaa" title="قيد الانتظار">⏳ ${c.total_msg - (c.sent_msg + c.failed_msg)}</span>
            </div>
        </div>
    `).join('');
}

function updateCampaignRow(id, type) {
    // type: 'sent' or 'failed'
    const sentEl = document.getElementById(`camp-sent-${id}`);
    const failedEl = document.getElementById(`camp-failed-${id}`);
    const pendingEl = document.getElementById(`camp-pending-${id}`);

    if (sentEl && failedEl && pendingEl) {
        let sent = parseInt(sentEl.innerText.split(' ')[1]);
        let failed = parseInt(failedEl.innerText.split(' ')[1]);
        let pending = parseInt(pendingEl.innerText.split(' ')[1]);

        if (type === 'sent') {
            sent++;
            pending--;
        } else if (type === 'failed') {
            failed++;
            pending--;
        }

        sentEl.innerText = `✔ ${sent}`;
        failedEl.innerText = `❌ ${failed}`;
        pendingEl.innerText = `⏳ ${pending}`;
    }
}

async function viewCampaignDetails(id, name = null) {
    if (name) document.getElementById('campaign-title').innerText = `التفاصيل: ${name}`;
    currentCampaignId = id;

    const res = await fetch(`${getApiBase()}/campaigns/${id}`);
    const history = await res.json();

    if (!Array.isArray(history)) {
        console.error('History is not an array:', history);
        return alert('Error loading details: ' + (history.error || 'Unknown error'));
    }

    // UI Logic: Hide List, Show Details
    document.getElementById('campaigns-list').style.display = 'none';
    document.getElementById('campaign-details').style.display = 'block';

    // Check for failures
    const failedCount = history.filter(h => h.status.includes('FAILED')).length;
    const retryBtn = document.getElementById('retry-btn');

    // Always show button, but disable/style based on count
    retryBtn.style.display = 'block';

    if (failedCount > 0) {
        retryBtn.disabled = false;
        retryBtn.style.opacity = '1';
        retryBtn.style.background = '#ffa500';
        retryBtn.style.cursor = 'pointer';
        retryBtn.innerText = `🔄 إعادة إرسال للفاشلين (${failedCount})`;
    } else {
        retryBtn.disabled = true;
        retryBtn.style.opacity = '0.5';
        retryBtn.style.background = '#666';
        retryBtn.style.cursor = 'not-allowed';
        retryBtn.innerText = `🔄 إعادة إرسال للفاشلين (0)`;
    }

    // Grab message from first entry if available for retry logic
    if (history.length > 0) currentCampaignMessage = history[0].message;

    document.getElementById('campaign-history-body').innerHTML = history.map(h => `
        <tr>
            <td>${h.recipient}</td>
            <td style="color: ${h.status === 'SENT' ? '#25d366' : '#ff5f5f'}">${h.status === 'SENT' ? 'تم الارسال' : 'فشل'}</td>
            <td>${new Date(h.timestamp).toLocaleTimeString('ar-SA')}</td>
        </tr>
    `).join('');
}

async function retryCampaign() {
    if (!currentCampaignId) return;
    if (!confirm('هل تريد إعادة محاولة إرسال الرسائل التي فشلت فقط؟')) return;

    try {
        const res = await fetch(`${getApiBase()}/campaign/${currentCampaignId}/retry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: currentCampaignMessage })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(`جاري إعادة المحاولة لـ ${data.count} رقم.`);
    } catch (err) {
        alert(err.message);
    }
}

function closeDetails() {
    document.getElementById('campaign-details').style.display = 'none';
    document.getElementById('campaigns-list').style.display = 'block'; // Show list again
    currentCampaignId = null;
}

// Users (Admin)
async function fetchUsers() {
    const res = await fetch(`${getApiBase()}/users`);
    const users = await res.json();
    document.getElementById('users-table-body').innerHTML = users.map(u => `
        <tr>
            <td>${u.username}</td>
            <td>${u.role}</td>
            <td>${u.username !== 'admin' ? `<button class="danger-btn" onclick="deleteUser(${u.id})">حذف</button>` : ''}</td>
        </tr>
    `).join('');
}

async function addUser() {
    const username = document.getElementById('new-username').value;
    const password = document.getElementById('new-password').value;
    const role = document.getElementById('new-role').value;

    if (!username || !password) return alert('أكمل البيانات');

    const res = await fetch(`${getApiBase()}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role })
    });
    const data = await res.json();
    if (data.success) {
        document.getElementById('new-username').value = '';
        document.getElementById('new-password').value = '';
        fetchUsers();
    } else {
        alert(data.error);
    }
}

async function deleteUser(id) {
    if (!confirm('حذف المستخدم؟')) return;
    await fetch(`${getApiBase()}/users/${id}`, { method: 'DELETE' });
    fetchUsers();
}

// System Logs
function downloadLogs() {
    window.location.href = `${getApiBase()}/logs/download`;
}

async function fetchLogs() {
    const res = await fetch(`${getApiBase()}/logs`);
    if (res.status === 403) return alert('غير مصرح لك');

    const logs = await res.json();
    document.getElementById('logs-table-body').innerHTML = logs.map(log => {
        let color = 'white';
        if (log.level === 'ERROR') color = '#ff5f5f';
        if (log.level === 'WARN') color = '#ffa500';

        return `
            <tr>
                <td style="color: ${color}; font-weight: bold;">${log.level}</td>
                <td style="direction: ltr; text-align: left;">${log.message}</td>
                <td>${new Date(log.timestamp).toLocaleString('ar-SA')}</td>
            </tr>
        `;
    }).join('');
}

// Settings
async function loadSettings() {
    try {
        const res = await fetch(`${getApiBase()}/settings`);
        const settings = await res.json();

        if (settings.site_name) {
            document.title = settings.site_name;
            const header = document.getElementById('site-name-display');
            if (header) header.innerText = settings.site_name;
            const input = document.getElementById('setting-site-name');
            if (input) input.value = settings.site_name;
        }

        if (settings.site_logo) {
            const logoUrl = settings.site_logo + '?t=' + new Date().getTime(); // Cache bust
            const display = document.getElementById('site-logo-display');
            if (display) {
                display.src = logoUrl;
                display.style.display = 'block';
            }
            const preview = document.getElementById('setting-logo-preview');
            if (preview) {
                preview.src = logoUrl;
                preview.style.display = 'block';
            }
        }
    } catch (err) {
        console.error('Failed to load settings', err);
    }
}

async function saveSiteName() {
    const siteName = document.getElementById('setting-site-name').value;
    if (!siteName) return alert('اكتب الاسم');

    await fetch(`${getApiBase()}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteName })
    });
    alert('تم حفظ الاسم ✅');
    loadSettings();
}

async function uploadLogo() {
    const fileInput = document.getElementById('setting-logo-file');
    const file = fileInput.files[0];
    if (!file) return alert('الرجاء اختيار صورة الشعار');

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch(`${getApiBase()}/settings/logo`, { method: 'POST', body: formData });
        const data = await res.json();

        if (data.success) {
            alert('تم رفع الشعار بنجاح ✅');
            loadSettings();
        } else {
            alert('فشل الرفع');
        }
    } catch (err) {
        alert(err.message);
    }
}

// Helpers
function updateStatus(status) {
    const el = document.getElementById('status-indicator');
    if (status.ready) {
        el.innerText = "متصل وجاهز ✅";
        el.classList.add('ready');
        el.style.color = '#25d366';
        document.getElementById('qr-container').innerHTML = '';
    } else {
        el.innerText = status.qr ? "امسح الباركود" : "جاري الاتصال...";
        el.classList.remove('ready');
        el.style.color = 'white';
    }
}

function addLog(msg) {
    const div = document.createElement('div');
    div.innerText = `[${new Date().toLocaleTimeString('ar-SA')}] ${msg}`;
    div.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
    document.getElementById('log-container').prepend(div);
}


