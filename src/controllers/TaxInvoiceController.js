const { generateTaxInvoiceMedia, getGeneratedTaxInvoicesZip } = require("../services/taxInvoice.service");
const logger = require("../utils/Logger");

function getRequestHostName(req) {
    const host = req.get("host") || req.hostname || "";

    if (host.startsWith("[")) {
        return host.slice(1, host.indexOf("]"));
    }

    return host.split(":")[0];
}

function isLocalRequest(req) {
    const hostName = getRequestHostName(req);

    return [
        "localhost",
        "127.0.0.1",
        "::1",
        "0.0.0.0",
        "172.25.4.190",
    ].includes(hostName);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function wantsHtml(req) {
    return (req.get("accept") || "").includes("text/html");
}

function renderZipDownloadError(error, req) {
    const fromDate = req.query?.fromDate || req.query?.from || "";
    const toDate = req.query?.toDate || req.query?.to || "";
    const missingFiles = Array.isArray(error.missingFiles) ? error.missingFiles : [];
    const missingFilesHtml = missingFiles.length > 0
        ? `<ul>${missingFiles.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}</ul>`
        : "";

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tax Invoice ZIP download failed</title>
    <style>
        body { margin: 0; font-family: Arial, sans-serif; background: #f6f8fb; color: #172033; }
        main { max-width: 720px; margin: 48px auto; padding: 28px; background: #fff; border: 1px solid #d8dee9; border-radius: 8px; }
        h1 { margin: 0 0 12px; font-size: 24px; }
        p { line-height: 1.5; }
        dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 20px 0; }
        dt { font-weight: 700; }
        dd { margin: 0; word-break: break-word; }
        ul { padding-left: 20px; }
        .status { color: #b42318; font-weight: 700; }
    </style>
</head>
<body>
    <main>
        <p class="status">Error ${escapeHtml(error.statusCode || 500)}</p>
        <h1>Tax Invoice ZIP download failed</h1>
        <p>${escapeHtml(error.message)}</p>
        <dl>
            <dt>Mobile number</dt><dd>${escapeHtml(req.query?.mobileNumber)}</dd>
            <dt>GSTIN</dt><dd>${escapeHtml(req.query?.gstin)}</dd>
            <dt>From date</dt><dd>${escapeHtml(fromDate)}</dd>
            <dt>To date</dt><dd>${escapeHtml(toDate)}</dd>
        </dl>
        ${missingFilesHtml ? `<h2>Missing PDF files</h2>${missingFilesHtml}` : ""}
        <p>Please generate the tax invoice PDF again or make sure the referenced PDF exists in the uploads/tax-invoices folder.</p>
    </main>
</body>
</html>`;
}

async function generateTaxInvoice(req, res, next) {
    try {
        const { LogoS3Url, MobileNumber, PaymentMode, BankDetails, ...invoiceFields } = req.body || {};

        const result = await generateTaxInvoiceMedia({
            body: invoiceFields,
            logoS3Url: LogoS3Url,
            mobileNumber: MobileNumber,
            paymentMode: PaymentMode,
            bankDetails: BankDetails,
        });

        const protocol = isLocalRequest(req) ? "http" : "https";
        const mediaUrl = `${protocol}://${req.get("host")}${result.relativeUrl}`;

        logger.info("Tax Invoice PDF generated", {
            fileName: result.fileName,
            mediaUrl,
            mobileNumber: MobileNumber,
        });

        return res.status(201).json({
            status: true,
            message: "Tax Invoice PDF generated successfully",
            mediaUrl,
            fileName: result.fileName,
        });
    } catch (error) {
        if (error.statusCode) {
            const log = error.statusCode >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);

            log("Tax Invoice PDF generation failed", {
                message: error.message,
                statusCode: error.statusCode,
            });

            return res.status(error.statusCode).json({
                status: false,
                message: error.message,
            });
        }

        next(error);
    }
}

async function downloadTaxInvoicesZip(req, res, next) {
    try {
        const { mobileNumber, gstin, fromDate, toDate, from, to } = req.query || {};
        const zip = await getGeneratedTaxInvoicesZip(
            mobileNumber,
            gstin,
            fromDate || from,
            toDate || to
        );

        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${zip.fileName}"`);

        return res.status(200).send(zip.buffer);
    } catch (error) {
        if (error.statusCode) {
            logger.warn("Tax Invoice ZIP download failed", {
                message: error.message,
                statusCode: error.statusCode,
                mobileNumber: req.query?.mobileNumber,
                gstin: req.query?.gstin,
                fromDate: req.query?.fromDate || req.query?.from,
                toDate: req.query?.toDate || req.query?.to,
                missingFiles: error.missingFiles,
            });

            if (wantsHtml(req)) {
                return res
                    .status(error.statusCode)
                    .type("html")
                    .send(renderZipDownloadError(error, req));
            }

            return res.status(error.statusCode).json({
                Status: "ERROR",
                Message: error.message,
            });
        }

        next(error);
    }
}

module.exports = {
    generateTaxInvoice,
    downloadTaxInvoicesZip,
};
