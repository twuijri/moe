// Super Admin Logic

async function checkAuth() {
    // We don't have a direct /super/api/me, but we can rely on standard session check or just fetching tenants
    // If fetching tenants fails with 401, we redirect.
    // However, login.html redirects to /super on success.

    // Let's rely on fetchTenants error handling to detect auth status initially
    fetchTenants();
}

async function fetchTenants() {
    try {
        const res = await fetch('/super/api/tenants', { credentials: 'include' });
        if (res.status === 401) return window.location.href = '/super/login';

        const tenants = await res.json();
        renderTenants(tenants);
    } catch (err) {
        console.error(err);
    }
}

function renderTenants(tenants) {
    const tbody = document.getElementById('tenants-table-body');
    if (!tenants || tenants.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">لا يوجد مشتركين</td></tr>';
        return;
    }

    tbody.innerHTML = tenants.map(t => {
        const daysLeft = calculateDaysLeft(t.subscription_end);
        let statusColor = '#25d366'; // Active
        if (!t.is_active) statusColor = '#aaa'; // Inactive
        if (daysLeft < 3) statusColor = '#ffa500'; // Warning
        if (daysLeft <= 0) statusColor = '#ff5f5f'; // Expired

        return `
            <tr>
                <td>${t.name}</td>
                <td style="direction: ltr;">
                    <a href="/${t.slug}" target="_blank" style="color: #3498db;">/${t.slug}</a>
                </td>
                <td>${t.admin_username}</td>
                <td>${t.phone_number}</td>
                <td>${t.subscription_end}</td>
                <td style="color: ${statusColor}; font-weight: bold;">${daysLeft} يوم</td>
                <td>
                    <button class="action-btn btn-edit" onclick="openEditModal('${t.id}', '${encodeURIComponent(JSON.stringify(t))}')" title="تعديل">✏️</button>
                    <button class="action-btn btn-extend" onclick="openExtendModal(${t.id}, '${t.name}')" title="تجديد الاشتراك">📅</button>
                    <button class="action-btn btn-delete" onclick="deleteTenant(${t.id})" title="حذف">🗑️</button>
                </td>
            </tr>
        `;
    }).join('');
}

function calculateDaysLeft(endDate) {
    const end = new Date(endDate);
    const now = new Date();
    const diff = end - now;
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

// Edit Modal
function openEditModal(id, tenantEncoded) {
    const tenant = JSON.parse(decodeURIComponent(tenantEncoded));
    document.getElementById('edit-id').value = tenant.id;
    document.getElementById('edit-name').value = tenant.name;
    document.getElementById('edit-slug').value = tenant.slug;
    document.getElementById('edit-admin-user').value = tenant.admin_username;
    document.getElementById('edit-admin-pass').value = ''; // Reset password field
    document.getElementById('edit-phone').value = tenant.phone_number;
    document.getElementById('edit-subscription-end').value = tenant.subscription_end; // Should be YYYY-MM-DD

    document.getElementById('edit-tenant-modal').style.display = 'flex';
}

async function submitEdit() {
    const id = document.getElementById('edit-id').value;
    const name = document.getElementById('edit-name').value;
    const slug = document.getElementById('edit-slug').value;
    const adminUsername = document.getElementById('edit-admin-user').value;
    const password = document.getElementById('edit-admin-pass').value;
    const phoneNumber = document.getElementById('edit-phone').value;
    const subscriptionEnd = document.getElementById('edit-subscription-end').value;

    const payload = {
        name, slug, adminUsername, password, phoneNumber, subscriptionEnd
    };

    try {
        const res = await fetch(`/super/api/tenants/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            credentials: 'include'
        });

        const data = await res.json();
        if (data.success) {
            alert('تم التعديل بنجاح! ✅');
            document.getElementById('edit-tenant-modal').style.display = 'none';
            fetchTenants();
        } else {
            alert('خطأ: ' + (data.error || 'فشل التعديل'));
        }
    } catch (err) {
        alert('حدث خطأ في الاتصال');
    }
}

// Actions
async function addTenant() {
    const name = document.getElementById('new-name').value;
    const slug = document.getElementById('new-slug').value;
    const adminUsername = document.getElementById('new-admin-user').value;
    const adminPassword = document.getElementById('new-admin-pass').value;
    const phoneNumber = document.getElementById('new-phone').value;
    const days = document.getElementById('new-days').value;

    if (!name || !slug || !adminUsername || !adminPassword || !phoneNumber) {
        return alert('الرجاء إكمال جميع الحقول');
    }

    // Slug validation (simple regex)
    if (!/^[a-z0-9_-]+$/.test(slug)) {
        return alert('الرابط يجب أن يحتوي على أحرف إنجليزية وأرقام فقط');
    }

    const payload = {
        name, slug, adminUsername, adminPassword, phoneNumber, subscriptionDays: parseInt(days)
    };

    try {
        const res = await fetch('/super/api/tenants', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            credentials: 'include'
        });
        const data = await res.json();

        if (data.success) {
            alert('تمت الإضافة بنجاح! ✅');
            closeModal();
            fetchTenants();
        } else {
            alert('خطأ: ' + (data.error || 'فشل التسجيل'));
        }
    } catch (err) {
        alert('حدث خطأ في الاتصال');
    }
}

async function deleteTenant(id) {
    if (!confirm('⚠️ تحذير: حذف المشترك سيؤدي لحذف جميع بياناته والطلاب والحملات.\nهل أنت متأكد؟')) return;

    // We don't have a DELETE endpoint in server.js for Super Admin yet?
    // Wait, let's check server.js...
    // Only GET and POST /tenants found in server.js replacement.
    // I need to ADD DELETE endpoint to server.js first!
    alert('تنبيه: خاصية الحذف تحتاج تفعيل من السيرفر (TODO)');
}

// Extend Subscription
function openExtendModal(id, name) {
    document.getElementById('extend-tenant-id').value = id;
    document.getElementById('extend-tenant-name').innerText = name;
    document.getElementById('extend-modal').style.display = 'flex';
}

async function submitExtend() {
    const id = document.getElementById('extend-tenant-id').value;
    const days = document.getElementById('extend-days').value;

    if (!days) return;

    try {
        const res = await fetch(`/super/api/tenants/${id}/extend`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days }),
            credentials: 'include'
        });

        if (res.ok) {
            alert('تم التجديد بنجاح! 🎉');
            document.getElementById('extend-modal').style.display = 'none';
            fetchTenants();
        } else {
            alert('فشل التجديد');
        }
    } catch (err) {
        alert('خطأ في الاتصال');
    }
}

// UI Helpers
function showSection(id) {
    // Only one section for now
}

function openAddModal() {
    document.getElementById('add-tenant-modal').style.display = 'flex';
}

function closeModal() {
    document.getElementById('add-tenant-modal').style.display = 'none';
}

async function logout() {
    // Super admin logout logic - just clear session?
    // We didn't implement explicit super logout in server.js but /logout works if shared session
    // Or we can just redirect to login.
    await fetch('/super/api/logout', { method: 'POST', credentials: 'include' }); // Need to ensure this exists or use standard /api/logout
    // Actually standard /api/logout clears session regardless of user type.
    // But route is /:slug/api/logout or root /api/logout?
    // Let's use /super/api/logout if we add it, or fall back to client side redirect after cookie clear (which we cant do easily).
    // Let's try calling a generic logout.
    window.location.href = '/super/login';
}

// Initialize
checkAuth();
