const db = require('./db');
const bcrypt = require('bcryptjs');

try {
    console.log('Creating Test Tenant...');
    // Create tenant: slug='omar', name='Omar School', admin='omar', pass='123456'
    db.createTenant('omar', 'Omar School', 'omar', '123456', '966500000000');
    console.log('✅ Tenant "omar" created successfully.');

    // The createTenant function automatically creates the admin user? 
    // Wait, let me check db.js implementation of createTenant...
    // createTenant just inserts into tenants table.
    // We ALSO need to create the admin USER for this tenant in the users table.

    const tenant = db.getTenantBySlug('omar');
    if (tenant) {
        console.log('Creating Admin User for Tenant...');
        db.createUser(tenant.id, 'omar', '123456', 'admin');
        console.log('✅ Admin user "omar" created for tenant.');
    }

} catch (err) {
    console.error('Error:', err.message);
}
