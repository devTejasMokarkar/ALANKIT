const path = require("path");
const dotenv = require("dotenv");

const appEnv = process.env.APP_ENV;
const validEnvs = ["development", "production"];

if (!appEnv) {
    throw new Error("APP_ENV is required and must be either 'development' or 'production'.");
}

if (!validEnvs.includes(appEnv)) {
    throw new Error(`Invalid APP_ENV value '${appEnv}'. Allowed values are: ${validEnvs.join(", ")}.`);
}

const envFilePath = path.resolve(process.cwd(), `.env.${appEnv}`);
const result = dotenv.config({ path: envFilePath });

if (result.error) {
    throw result.error;
}

process.env.NODE_ENV = appEnv;

const app = require("./app");
const { connectDB, closeConnection } = require("./src/config/database");
const logger = require("./src/utils/Logger");
const { invoicePdfPool } = require("./src/services/invoicePdfPool");
const { invoiceGate } = require("./src/middleware/InvoiceGate");
const { registrationGate } = require("./src/middleware/RegistrationGate");

const port = process.env.PORT;
const host = process.env.HOST;

let server;
let shuttingDown = false;

async function startServer() {
    try {
        await connectDB();
        await invoicePdfPool.warm();

        server = app.listen(port, host, () => {
            logger.info("Server started", { url: `http://${host}:${port}` });
        });

        server.on("error", async (error) => {
            logger.error("Server listen failed", {
                host,
                port,
                message: error.message,
                code: error.code,
            });

            await closeConnection();
            process.exit(1);
        });
    } catch (error) {
        logger.error("Server startup failed", {
            message: error.message,
            stack: error.stack,
        });
        process.exit(1);
    }
}

startServer();

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutdown signal received; draining HTTP requests");
    const deadline = setTimeout(() => {
        logger.warn("Shutdown drain deadline reached; some write outcomes may be unknown");
        server?.closeAllConnections();
        process.exit(1);
    }, 30000);
    deadline.unref();
    try {
        if (server?.listening) {
            await new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
                server.closeIdleConnections();
            });
        }
        await Promise.all([registrationGate.waitForIdle(), invoiceGate.waitForIdle()]);
        await invoicePdfPool.close();
        await closeConnection();
        clearTimeout(deadline);
        logger.info("Server shutdown complete");
        process.exit(0);
    } catch (error) {
        logger.error("Shutdown failed", { message: error.message });
        process.exit(1);
    }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
