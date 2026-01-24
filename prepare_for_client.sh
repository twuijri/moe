#!/bin/bash

# Script to clean the project for client delivery
# WARNING: This deletes all data!

echo "⚠️  WARNING: This will delete ALL database data, logs, and branding."
echo "Use this ONLY if you are preparing to send the files to a client."
read -p "Are you sure you want to continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]
then
    echo "Cancelled."
    exit 1
fi

echo "Cleaning..."

# 1. Delete Database
# 1. Delete Database (Stored in Docker Volume now)
# We need to remove the volume
if docker volume ls | grep -q watsapp-google_whatsapp_data; then
    docker volume rm watsapp-google_whatsapp_data
    echo "✅ Database volume deleted."
fi
# Also remove session volume
if docker volume ls | grep -q watsapp-google_whatsapp_session; then
    docker volume rm watsapp-google_whatsapp_session
    echo "✅ Session volume deleted."
fi

# Fallback: Check local folder just in case
if [ -d "data" ]; then
    rm -rf data
    echo "✅ Local data folder cleanup."
fi

# 3. Delete Branding (Optional - ask?)
# Just delete for fresh start
if ls public/site_logo* 1> /dev/null 2>&1; then
    rm public/site_logo*
    echo "✅ Custom logo deleted."
fi

# 4. Delete Node Modules (to reduce size for transfer)
# Only if user wants to zip it. Actually, maybe keep them if they don't know how to install.
# But for delivery, usually you delete.
# Let's ask.
read -p "Do you want to delete 'node_modules' to make the folder smaller? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]
then
    rm -rf node_modules
    echo "✅ node_modules deleted."
fi

echo "✨ System is now fresh and ready for client delivery!"
echo "Note: The client will start with a fresh database and default 'admin / admin123' account."
