const express = require("express");
const path = require("path");
const healthRoutes = require("./src/routes/HealthRoutes");
const userRoutes = require("./src/routes/UserRoutes");
// const invoiceRoutes = require("./src/routes/InvoiceRoutes");
const taxInvoiceRoutes = require("./src/routes/TaxInvoiceRoutes");
const { requestLogger } = require("./src/middleware/RequestLogger");
const logger = require("./src/utils/Logger");

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb" }));
app.use(requestLogger);
app.use(
    "/user-details/uploads",
    express.static(path.join(__dirname, "uploads"), {
        fallthrough: false,
        immutable: true,
        maxAge: "1d",
        setHeaders: (res, filePath) => {
            if (filePath.toLowerCase().endsWith(".pdf")) {
                res.setHeader("Content-Type", "application/pdf");
                res.setHeader("Content-Disposition", "inline");
            }
        },
    })
);

// Routes
app.use(healthRoutes);
app.use(userRoutes);
// app.use(invoiceRoutes);
app.use(taxInvoiceRoutes);

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
    logger.error("Unhandled request error", {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        message: error.message,
        stack: error.stack,
    });

    if (res.destroyed || res.headersSent) return;
    if (/^Mongo/.test(error.name) && /Timeout|Network|ServerSelection|NotConnected|PoolCleared/.test(error.name)) {
        res.setHeader("Retry-After", "1");
        return res.status(503).json({
            Status: "ERROR", Code: "DATABASE_UNAVAILABLE",
            Message: "Database is busy or unavailable. Check registration by mobile number before retrying.",
            RequestId: req.requestId,
            WriteOutcomeUnknown: Boolean(res.locals.registrationWriteStarted),
        });
    }
    res.status(500).json({
        Status: "ERROR",
        Message: "Internal Server Error",
    });
});

module.exports = app;
