const logger = require("./Logger");

async function timeStage(req, res, stage, operation) {
    const startedAt = Date.now();
    res.locals.activeStage = stage;
    res.locals.stageStartedAt = startedAt;
    try {
        return await operation();
    } finally {
        const durationMs = Date.now() - startedAt;
        res.locals.stageDurations = res.locals.stageDurations || {};
        res.locals.stageDurations[stage] = durationMs;
        res.locals.activeStage = null;
        if (durationMs >= 1000) {
            logger.warn("Slow request stage", {
                requestId: req.requestId, stage, durationMs,
                clientDisconnected: res.destroyed && !res.writableFinished,
            });
        }
    }
}

module.exports = { timeStage };
