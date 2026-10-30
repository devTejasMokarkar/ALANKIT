const { Router } = require("express");
const mongoose = require("mongoose");

const router = Router();

const mongoStates = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
};

router.get("/health", (req, res) => {
    const mongoState = mongoose.connection.readyState;

    res.status(mongoState === 1 ? 200 : 503).json({
        Status: mongoState === 1 ? "OK" : "ERROR",
        Message: mongoState === 1 ? "Service is healthy" : "Service is not healthy",
        Uptime: process.uptime(),
        Timestamp: new Date().toISOString(),
        MongoDB: mongoStates[mongoState] || "unknown",
    });
});

module.exports = router;
