const db = require('../db');

function extractTenant(req, res, next) {
    // Try getting from params first (if mounted with /:slug)
    let slug = req.params.slug;

    // Fallback to path extraction (for app.get or custom routing)
    if (!slug) {
        const pathParts = req.path.split('/');
        slug = pathParts[1];
    }

    // Cleanup if slug has query params or extra chars (unlikely with params but possible with path)
    if (slug && slug.includes('?')) slug = slug.split('?')[0];

    if (!slug || slug === 'api' || slug === 'super' || slug === 'login.html') {
        return next();
    }

    const tenant = db.getTenantBySlug(slug);

    if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
    }

    if (!tenant.is_active) {
        return res.status(403).json({ error: 'Tenant account is inactive' });
    }

    // Attach tenant to request
    req.tenant = tenant;
    req.tenantId = tenant.id;

    // Rewrite URL to remove slug for easier routing downstream?
    // Actually, keeping it explicitly might be safer, but Express router handling needs care.
    // Better approach: Mount router at /:slug

    next();
}

module.exports = { extractTenant };
