const requiredUserIndexes = [
    { key: { id: 1 }, options: { name: "id_1", unique: true } },
    { key: { Gstin: 1 }, options: { name: "Gstin_1", unique: true, sparse: true } },
    { key: { MobileNumber: 1 }, options: { name: "MobileNumber_1", unique: true } },
    {
        key: { InvoiceSeries: 1 },
        options: {
            name: "InvoiceSeries_unique",
            unique: true,
            partialFilterExpression: { InvoiceSeries: { $type: "string", $gt: "" } },
            collation: { locale: "en", strength: 2 },
        },
    },
];

async function ensureUserIndexes(collection) {
    let indexes;
    try { indexes = await collection.indexes(); }
    catch (error) {
        if (error.code !== 26) throw error;
        indexes = [];
    }
    for (const { key, options } of requiredUserIndexes) {
        const existing = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key) && index.unique);
        if (existing && !options.collation) continue;
        if (existing && existing.collation?.locale === "en" && existing.collation.strength === 2) continue;
        // Never drop an index or modify existing records to make an index build succeed.
        await collection.createIndex(key, options);
    }
}

module.exports = { requiredUserIndexes, ensureUserIndexes };
