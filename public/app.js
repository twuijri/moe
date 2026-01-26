const socket = io();

// State
let currentUser = null;
let currentCampaignId = null; // Track viewed campaign for retry
let currentCampaignMessage = ''; // Track message for retry if needed

// Auth Check
async function checkAuth() {
    try {
        const res = await fetch('/api/me');
        if (res.status === 401) return window.location.href = '/login.html';
        currentUser = await res.json();

        document.getElementById('current-user').innerText = `${currentUser.username} (${currentUser.role})`;
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
        window.location.href = '/login.html';
    }
}
checkAuth();

async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
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
    // Actually details view is a table list, appending is better but refreshing is likely OK as user is not clicking ON the list usually, just viewing.
    // But if sending is fast, it flickers. Ideally append row.
    if (currentCampaignId && currentCampaignId == data.id) {
        viewCampaignDetails(currentCampaignId);
    }
});

// --- Logic ---

// Students
let studentsData = []; // Global variable to store students for campaign selector

async function fetchStudents() {
    const res = await fetch('/api/students');
    const students = await res.json();
    studentsData = students; // Store globally
    const tbody = document.getElementById('students-table-body');
    tbody.innerHTML = students.map(s => `
        <tr>
            <td>${s.name}</td>
            <td>${s.phone_number}</td>
            <td>${currentUser.role === 'admin' ? `<button class="danger-btn" onclick="deleteStudent(${s.id})">حذف</button>` : '-'}</td>
        </tr>
    `).join('');
}

async function deleteStudent(id) {
    if (!confirm('هل أنت متأكد من الحذف؟')) return;
    await fetch(`/api/students/${id}`, { method: 'DELETE' });
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
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(`تم الرفع! تمت الاضافة: ${data.added}, مكرر/أخطاء: ${data.errors}`);
        closeModal();
        fetchStudents();
    } catch (err) {
        alert(err.message);
    }
}

function downloadTemplate() {
    window.location.href = '/api/template';
}

async function addStudentManual() {
    const name = document.getElementById('manual-name').value;
    const phone = document.getElementById('manual-phone').value;

    if (!name || !phone) return alert('الرجاء ادخال الاسم ورقم الجوال');

    try {
        const res = await fetch('/api/students', {
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

    selector.innerHTML = studentsData.map(student => `
        <label style="display: block; padding: 8px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.05);">
            <input type="checkbox" class="student-checkbox" value="${student.id}" checked style="margin-left: 8px;">
            ${student.name} (${student.phone_number})
        </label>
    `).join('');
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
        const res = await fetch('/api/campaign', {
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
    const res = await fetch('/api/campaigns');
    const campaigns = await res.json();
    const listContainer = document.getElementById('campaigns-list');

    // Only rebuild if empty or count mismatch (simple approach) or diffing?
    // simplest: clear and rebuild IS OKAY only if we are NOT doing it on every progress event.
    // The issue was calling this function on every progress event.
    // So we will keep this valid for initial load, but we will add IDs.

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

    const res = await fetch(`/api/campaigns/${id}`);
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
        const res = await fetch(`/api/campaign/${currentCampaignId}/retry`, {
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
    const res = await fetch('/api/users');
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

    const res = await fetch('/api/users', {
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
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    fetchUsers();
}

// System Logs
function downloadLogs() {
    window.location.href = '/api/logs/download';
}

async function fetchLogs() {
    const res = await fetch('/api/logs');
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
        const res = await fetch('/api/settings');
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

    await fetch('/api/settings', {
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
        const res = await fetch('/api/settings/logo', { method: 'POST', body: formData });
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
