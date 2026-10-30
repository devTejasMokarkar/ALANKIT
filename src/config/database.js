const mongoose = require("mongoose");
const logger = require("../utils/Logger");
const { ensureUserIndexes } = require("./userIndexes");

async function connectDB() {
    const mongoUri = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB;

    if (!mongoUri || (!mongoUri.startsWith("mongodb://") && !mongoUri.startsWith("mongodb+srv://"))) {
        throw new Error('MONGODB_URI must start with "mongodb://" or "mongodb+srv://"');
    }

    if (!dbName || dbName.trim().length === 0) {
        throw new Error("MONGODB_DB is required");
    }

    logger.info("Connecting to MongoDB", { dbName });
    await mongoose.connect(mongoUri, {
        dbName, autoIndex: true, autoCreate: true,
        maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 100),
        maxConnecting: 10,
        waitQueueTimeoutMS: 5000,
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
    });
    try {
        await ensureUserIndexes(mongoose.connection.db.collection(process.env.MONGODB_COLLECTION || "users"));
    } catch (error) {
        await mongoose.disconnect();
        if (error.code === 11000) {
            throw new Error("Cannot enforce unique user fields: existing duplicates must be resolved before startup. Run scripts/audit-user-uniqueness.cjs.");
        }
        throw error;
    }
    logger.info("Connected to MongoDB", { dbName });
}

async function closeConnection() {
    logger.info("Closing MongoDB connection");
    await mongoose.connection.close();
    logger.info("MongoDB connection closed");
}

module.exports = { connectDB, closeConnection };
