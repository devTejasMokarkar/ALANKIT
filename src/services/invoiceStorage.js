const crypto = require("crypto");
const fs = require("fs/promises");

function storageError(message, statusCode = 502) {
    return Object.assign(new Error(message), { statusCode });
}

function getConfig() {
    let url;
    try { url = process.env.CLOUDINARY_URL ? new URL(process.env.CLOUDINARY_URL) : undefined; }
    catch (_) { throw storageError("Invalid CLOUDINARY_URL configuration", 500); }
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || url?.hostname;
    const apiKey = process.env.CLOUDINARY_API_KEY || (url && decodeURIComponent(url.username));
    const apiSecret = process.env.CLOUDINARY_API_SECRET || (url && decodeURIComponent(url.password));
    if (!cloudName || !apiKey || !apiSecret || !/^[a-zA-Z0-9_-]+$/.test(cloudName)) {
        throw storageError("Cloudinary invoice storage is not configured", 500);
    }
    return { cloudName, apiKey, apiSecret };
}

async function uploadInvoicePdf(buffer, fileName) {
    const { cloudName, apiKey, apiSecret } = getConfig();
    const publicId = `invoices/${fileName}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHash("sha1")
        .update(`overwrite=false&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`).digest("hex");
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "application/pdf" }), fileName);
    form.append("public_id", publicId);
    form.append("overwrite", "false");
    form.append("timestamp", String(timestamp));
    form.append("api_key", apiKey);
    form.append("signature", signature);
    try {
        const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`, {
            method: "POST", body: form, signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw storageError("Cloudinary invoice upload failed");
        const result = await response.json();
        if (!result.secure_url?.startsWith(`https://res.cloudinary.com/${cloudName}/`) || !result.public_id) {
            throw storageError("Invalid Cloudinary upload response");
        }
        return { secureUrl: result.secure_url, publicId: result.public_id };
    } catch (_) {
        throw storageError("Cloudinary invoice upload failed");
    }
}

async function readInvoicePdf(invoice, legacyPath) {
    if (!/^https:\/\//i.test(invoice.RelativeUrl || "")) return fs.readFile(legacyPath);
    const url = new URL(invoice.RelativeUrl);
    if (url.hostname !== "res.cloudinary.com" || url.port || url.username || url.password) {
        throw storageError("Invalid stored invoice URL");
    }
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: "error" });
        if (response.status === 404) throw Object.assign(new Error("Invoice PDF not found"), { code: "ENOENT" });
        if (!response.ok) throw storageError("Unable to download invoice PDF from Cloudinary");
        return Buffer.from(await response.arrayBuffer());
    } catch (error) {
        if (error.code === "ENOENT") throw error;
        throw storageError("Unable to download invoice PDF from Cloudinary");
    }
}

module.exports = { uploadInvoicePdf, readInvoicePdf };
