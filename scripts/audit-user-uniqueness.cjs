const path = require('node:path');
const mongoose = require('mongoose');
const { ensureUserIndexes } = require('../src/config/userIndexes');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.development') });

(async () => {
    const connection = await mongoose.createConnection(process.env.MONGODB_URI, {
        dbName: process.env.MONGODB_DB, autoIndex: false, autoCreate: false,
        serverSelectionTimeoutMS: 8000,
    }).asPromise();
    try {
        const collection = connection.db.collection(process.env.MONGODB_COLLECTION || 'users');
        const duplicates = {};
        for (const field of ['Gstin', 'MobileNumber', 'InvoiceSeries']) {
            const groups = await collection.aggregate([
                { $match: { [field]: { $type: 'string', $gt: '' } } },
                { $group: { _id: { $toUpper: { $trim: { input: `$${field}` } } }, count: { $sum: 1 } } },
                { $match: { count: { $gt: 1 } } },
                { $count: 'duplicateGroups' },
            ], { maxTimeMS: 30000 }).toArray();
            duplicates[field] = groups[0]?.duplicateGroups || 0;
        }
        console.log(JSON.stringify({ database: process.env.MONGODB_DB, duplicateGroups: duplicates }, null, 2));
        if (Object.values(duplicates).some(Boolean)) {
            throw new Error('Existing duplicates found. No records changed. Resolve duplicates before enforcing indexes.');
        }
        if (process.argv.includes('--apply')) {
            await ensureUserIndexes(collection);
            console.log('Unique indexes verified for GSTIN, mobile number, and invoice series. No records changed or deleted.');
        }
    } finally { await connection.close(); }
})().catch(error => { console.error(error.message.replaceAll(process.env.MONGODB_URI || '', '[redacted]')); process.exitCode = 1; });
