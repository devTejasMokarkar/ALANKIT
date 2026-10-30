function log(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const details = Object.keys(metadata).length > 0 ? ` ${JSON.stringify(metadata)}` : "";

    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${details}`);
}

function info(message, metadata) {
    log("info", message, metadata);
}

function warn(message, metadata) {
    log("warn", message, metadata);
}

function error(message, metadata) {
    log("error", message, metadata);
}

module.exports = { info, warn, error };
