const { randomUUID } = require("crypto");
const logger = require("../utils/Logger");

function requestLogger(req, res, next) {
    const startedAt = Date.now();
    const incomingId = req.get("x-request-id");
    req.requestId = incomingId && /^[a-zA-Z0-9._-]{1,128}$/.test(incomingId) ? incomingId : randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    res.on("close", () => {
        if (!res.writableFinished) {
            logger.warn("Client disconnected before response", {
                requestId: req.requestId, method: req.method, path: req.path,
                durationMs: Date.now() - startedAt,
                activeStage: res.locals.activeStage || null,
                activeStageMs: res.locals.activeStage ? Date.now() - res.locals.stageStartedAt : null,
                stages: res.locals.stageDurations || {},
            });
        }
    });

    res.on("finish", () => {
        const durationMs = Date.now() - startedAt;
        const metadata = {
            requestId: req.requestId,
            stages: res.locals.stageDurations || {},
            method: req.method,
            path: req.originalUrl,
            statusCode: res.statusCode,
            durationMs,
            ip: req.ip,
        };

        if (res.statusCode >= 500) {
            logger.error("HTTP request failed", metadata);
            return;
        }

        if (res.statusCode >= 400) {
            logger.warn("HTTP request completed with client error", metadata);
            return;
        }

        logger.info("HTTP request completed", metadata);
    });

    next();
}

module.exports = { requestLogger };



