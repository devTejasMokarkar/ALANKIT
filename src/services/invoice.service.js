const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const Invoice = require("../models/Invoice");
const TaxInvoice = require("../models/TaxInvoice");
const User = require("../models/User");
const { decodeSignedInvoice } = require("../utils/decodeSignedInvoice");
const { generateInvoicePdf } = require("../utils/pdfGenerator");
const { createZipBuffer } = require("../utils/zipGenerator");

const invoiceUploadDir = path.resolve(__dirname, "..", "..", "uploads", "invoices");
const taxInvoiceUploadDir = path.resolve(__dirname, "..", "..", "uploads", "tax-invoices");
const GSTIN_REGEX = /^[0-9]{2}[0-9A-Z]{13}$/;
const MOBILE_NUMBER_REGEX = /^91[6-9][0-9]{9}$/;
const INVOICE_DATE_REGEX = /^([0-2][0-9]|3[0-1])\/(0[1-9]|1[0-2])\/[0-9]{4}$/;

class InvoiceServiceError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.name = "InvoiceServiceError";
        this.statusCode = statusCode;
    }
}

function validateIrnResponse(invoiceResponse) {
    if (!invoiceResponse || typeof invoiceResponse !== "object") {
        throw new InvoiceServiceError("invoiceResponse is required", 400);
    }

    const requiredFields = ["AckNo", "AckDt", "Irn", "SignedInvoice", "SignedQRCode", "Status"];
    const missingFields = requiredFields.filter((field) => !invoiceResponse[field]);

    if (missingFields.length > 0) {
        throw new InvoiceServiceError(`Missing invoiceResponse fields: ${missingFields.join(", ")}`, 400);
    }
}

function validateLogoS3Url(logoS3Url) {
    if (logoS3Url === undefined || logoS3Url === null || logoS3Url === "") {
        return undefined;
    }

    if (typeof logoS3Url !== "string") {
        throw new InvoiceServiceError("LogoS3Url must be a string", 400);
    }

    const trimmedLogoS3Url = logoS3Url.trim();

    if (!trimmedLogoS3Url) {
        return undefined;
    }

    try {
        const url = new URL(trimmedLogoS3Url);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("Invalid protocol");
        }
    } catch (error) {
        throw new InvoiceServiceError("LogoS3Url must be a valid HTTP or HTTPS URL", 400);
    }

    return trimmedLogoS3Url;
}

function validateInvoiceOwner(mobileNumber, gstin) {
    if (typeof mobileNumber !== "string" || !MOBILE_NUMBER_REGEX.test(mobileNumber.trim())) {
        throw new InvoiceServiceError("MobileNumber must be a valid 12 digit Indian mobile number with country code", 400);
    }

    const normalizedGstin = typeof gstin === "string" ? gstin.trim().toUpperCase() : "";

    if (normalizedGstin && !GSTIN_REGEX.test(normalizedGstin)) {
        throw new InvoiceServiceError("Gstin must be a valid GSTIN", 400);
    }

    return {
        mobileNumber: mobileNumber.trim(),
        gstin: normalizedGstin,
    };
}

function getInvoiceListProjection() {
    return {
        _id: 0,
        __v: 0,
        InvoiceData: 0,
    };
}

function sanitizeZipFileName(value, fallback) {
    const fileName = String(value || fallback || "invoice")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    return fileName || fallback || "invoice";
}

function parseDdMmYyyy(value, fieldName) {
    if (typeof value !== "string" || !INVOICE_DATE_REGEX.test(value.trim())) {
        throw new InvoiceServiceError(`${fieldName} must be in dd/mm/yyyy format`, 400);
    }

    const [day, month, year] = value.trim().split("/").map(Number);
    const parsedDate = new Date(Date.UTC(year, month - 1, day));

    if (
        parsedDate.getUTCFullYear() !== year ||
        parsedDate.getUTCMonth() !== month - 1 ||
        parsedDate.getUTCDate() !== day
    ) {
        throw new InvoiceServiceError(`${fieldName} must be a valid calendar date`, 400);
    }

    return parsedDate;
}

function validateInvoiceDateRange(fromDate, toDate) {
    const from = parseDdMmYyyy(fromDate, "fromDate");
    const to = parseDdMmYyyy(toDate, "toDate");

    if (from > to) {
        throw new InvoiceServiceError("fromDate must be before or equal to toDate", 400);
    }

    return { from, to };
}

function filterInvoicesByDateRange(invoices, fromDate, toDate) {
    const range = validateInvoiceDateRange(fromDate, toDate);

    return invoices.filter((invoice) => {
        if (!invoice.InvoiceDate) {
            return false;
        }

        try {
            const invoiceDate = parseDdMmYyyy(invoice.InvoiceDate, "InvoiceDate");

            return invoiceDate >= range.from && invoiceDate <= range.to;
        } catch (error) {
            return false;
        }
    });
}

function getInvoicePdfPath(invoice) {
    const fileName = invoice.FileName || path.basename(invoice.RelativeUrl || "");

    if (!fileName) {
        return undefined;
    }

    return path.join(invoiceUploadDir, path.basename(fileName));
}

async function generateInvoiceMedia({ invoiceResponse, logoS3Url, mobileNumber, gstin, paymentMode, bankDetails }) {
    validateIrnResponse(invoiceResponse);
    const invoiceOwner = validateInvoiceOwner(mobileNumber, gstin);
    console.log("LogoS3URL: ", logoS3Url);
    const validatedLogoS3Url = validateLogoS3Url(logoS3Url);
    console.log("validatedLogoS3Url: ", validateLogoS3Url(logoS3Url));
    const user = await User.findOne({
        MobileNumber: invoiceOwner.mobileNumber,
        Gstin: invoiceOwner.gstin,
    }, { _id: 0, id: 1, LogoS3Url: 1 }).lean();

    if (!user) {
        throw new InvoiceServiceError("User details not found for this MobileNumber and Gstin", 404);
    }

    const invoiceData = decodeSignedInvoice(invoiceResponse.SignedInvoice);
    console.log("Invoice Data: ", invoiceData);

    // Merge payment mode and bank details into PayDtls
    invoiceData.PayDtls = invoiceData.PayDtls || {};
    if (paymentMode !== undefined && paymentMode !== null) {
        invoiceData.PayDtls.Mode = String(paymentMode);
    }
    if (bankDetails && typeof bankDetails === "object") {
        invoiceData.PayDtls.Nm = bankDetails.BankName || invoiceData.PayDtls.Nm;
        invoiceData.PayDtls.AcctDet = bankDetails.AccountNumber || invoiceData.PayDtls.AcctDet;
        invoiceData.PayDtls.Ifsc = bankDetails.IFSCCode || invoiceData.PayDtls.Ifsc;
        invoiceData.PayDtls.Upi = bankDetails.UPIID || invoiceData.PayDtls.Upi;
    }

    await fs.mkdir(invoiceUploadDir, { recursive: true });

    const timestamp = Date.now();
    const fileName = `invoice_${timestamp}.pdf`;
    const filePath = path.join(invoiceUploadDir, fileName);
    const relativeUrl = `/user-details/uploads/invoices/${fileName}`;

    const finalLogoUrl = validatedLogoS3Url || user.LogoS3Url || undefined;

    await generateInvoicePdf({
        invoiceData,
        irnResponse: invoiceResponse,
        filePath,
        logoS3Url: finalLogoUrl,
    });

    const invoice = await Invoice.create({
        InvoiceId: crypto.randomUUID(),
        UserId: user.id,
        MobileNumber: invoiceOwner.mobileNumber,
        Gstin: invoiceOwner.gstin,
        Irn: invoiceResponse.Irn,
        AckNo: String(invoiceResponse.AckNo),
        AckDt: invoiceResponse.AckDt,
        InvoiceNo: invoiceData.DocDtls?.No,
        InvoiceDate: invoiceData.DocDtls?.Dt,
        TotalAmount: Number(invoiceData.ValDtls?.TotInvVal || 0),
        FileName: fileName,
        RelativeUrl: relativeUrl,
        InvoiceData: invoiceData,
    });

    return {
        invoiceId: invoice.InvoiceId,
        fileName,
        relativeUrl,
    };
}

async function getGeneratedInvoices(mobileNumber, gstin) {
    const invoiceOwner = validateInvoiceOwner(mobileNumber, gstin);
    const query = { MobileNumber: invoiceOwner.mobileNumber };

    if (invoiceOwner.gstin) {
        query.Gstin = invoiceOwner.gstin;
    }

    return Invoice.find(query, getInvoiceListProjection()).sort({ CreatedAt: -1 }).lean();
}

// async function getGeneratedInvoiceById(invoiceId) {
//     if (typeof invoiceId !== "string" || !invoiceId.trim()) {
//         throw new InvoiceServiceError("InvoiceId is required", 400);
//     }

//     const invoice = await Invoice.findOne({
//         InvoiceId: invoiceId.trim(),
//     }, { _id: 0, __v: 0 }).lean();

//     if (!invoice) {
//         throw new InvoiceServiceError("Invoice not found", 404);
//     }

//     return invoice;
// }

async function getGeneratedInvoicesZip(mobileNumber, gstin, fromDate, toDate) {
    const invoices = filterInvoicesByDateRange(
        await getGeneratedInvoices(mobileNumber, gstin),
        fromDate,
        toDate
    );

    if (invoices.length === 0) {
        throw new InvoiceServiceError("No invoices found for this MobileNumber, Gstin, and date range", 404);
    }

    const entries = [];
    const missingFiles = [];

    for (const invoice of invoices) {
        const pdfPath = getInvoicePdfPath(invoice);

        if (!pdfPath) {
            missingFiles.push(invoice.FileName || invoice.RelativeUrl || invoice.InvoiceId);
            continue;
        }

        try {
            const buffer = await fs.readFile(pdfPath);
            const displayName = sanitizeZipFileName(
                invoice.InvoiceNo || invoice.InvoiceId,
                path.basename(invoice.FileName, ".pdf")
            );

            entries.push({
                name: `${displayName}_${invoice.InvoiceId}.pdf`,
                buffer,
                modifiedAt: invoice.CreatedAt,
            });
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw new InvoiceServiceError("Unable to read invoice PDF file", 500);
            }

            missingFiles.push(path.basename(pdfPath));
        }
    }

    if (entries.length === 0) {
        const error = new InvoiceServiceError("No invoice PDF files found", 404);
        error.missingFiles = missingFiles;
        throw error;
    }

    const invoiceOwner = validateInvoiceOwner(mobileNumber, gstin);

    return {
        fileName: `invoices_${invoiceOwner.mobileNumber}_${invoiceOwner.gstin}_${fromDate}_${toDate}.zip`
            .replace(/\//g, "-"),
        buffer: createZipBuffer(entries),
    };
}

/**
 * Downloads a single ZIP containing PDFs from both normal invoices (with QR)
 * and tax invoices (without QR) for the given mobile number / GSTIN and date range.
 */
async function getGeneratedAllInvoicesZip(mobileNumber, gstin, fromDate, toDate) {
    const invoiceOwner = validateInvoiceOwner(mobileNumber, gstin);
    const query = { MobileNumber: invoiceOwner.mobileNumber };

    if (invoiceOwner.gstin) {
        query.Gstin = invoiceOwner.gstin;
    }

    // Fetch both collections in parallel
    const [allNormal, allTax] = await Promise.all([
        Invoice.find(query, { _id: 0, __v: 0, InvoiceData: 0 }).sort({ CreatedAt: -1 }).lean(),
        TaxInvoice.find(query, { _id: 0, __v: 0, InvoiceData: 0 }).sort({ CreatedAt: -1 }).lean(),
    ]);

    // Apply date filter to both
    const range = validateInvoiceDateRange(fromDate, toDate);

    function inRange(invoice) {
        if (!invoice.InvoiceDate) return false;
        try {
            const d = parseDdMmYyyy(invoice.InvoiceDate, "InvoiceDate");
            return d >= range.from && d <= range.to;
        } catch (_) {
            return false;
        }
    }

    const normalInvoices = allNormal.filter(inRange);
    const taxInvoices = allTax.filter(inRange);

    if (normalInvoices.length === 0 && taxInvoices.length === 0) {
        throw new InvoiceServiceError("No invoices found for this MobileNumber, Gstin, and date range", 404);
    }

    const entries = [];
    const missingFiles = [];

    // Collect normal invoice PDFs (subfolder: invoices/)
    for (const invoice of normalInvoices) {
        const fileName = invoice.FileName || path.basename(invoice.RelativeUrl || "");
        if (!fileName) {
            missingFiles.push(invoice.InvoiceId || invoice.FileName || "unknown");
            continue;
        }
        const pdfPath = path.join(invoiceUploadDir, path.basename(fileName));
        try {
            const buffer = await fs.readFile(pdfPath);
            const displayName = sanitizeZipFileName(
                invoice.InvoiceNo || invoice.InvoiceId,
                path.basename(fileName, ".pdf")
            );
            entries.push({
                name: `invoices/${displayName}_${invoice.InvoiceId}.pdf`,
                buffer,
                modifiedAt: invoice.CreatedAt,
            });
        } catch (error) {
            if (error.code !== "ENOENT") throw new InvoiceServiceError("Unable to read invoice PDF file", 500);
            missingFiles.push(path.basename(pdfPath));
        }
    }

    // Collect tax invoice PDFs (subfolder: tax-invoices/)
    for (const invoice of taxInvoices) {
        const fileName = invoice.FileName || path.basename(invoice.RelativeUrl || "");
        if (!fileName) {
            missingFiles.push(invoice.InvoiceId || invoice.FileName || "unknown");
            continue;
        }
        const pdfPath = path.join(taxInvoiceUploadDir, path.basename(fileName));
        try {
            const buffer = await fs.readFile(pdfPath);
            const displayName = sanitizeZipFileName(
                invoice.InvoiceNo || invoice.InvoiceId,
                path.basename(fileName, ".pdf")
            );
            entries.push({
                name: `tax-invoices/${displayName}_${invoice.InvoiceId}.pdf`,
                buffer,
                modifiedAt: invoice.CreatedAt,
            });
        } catch (error) {
            if (error.code !== "ENOENT") throw new InvoiceServiceError("Unable to read tax invoice PDF file", 500);
            missingFiles.push(path.basename(pdfPath));
        }
    }

    if (entries.length === 0) {
        const error = new InvoiceServiceError("No invoice PDF files found", 404);
        error.missingFiles = missingFiles;
        throw error;
    }

    return {
        fileName: `all_invoices_${invoiceOwner.mobileNumber}_${invoiceOwner.gstin || "all"}_${fromDate}_${toDate}.zip`
            .replace(/\//g, "-"),
        buffer: createZipBuffer(entries),
        missingFiles,
    };
}

module.exports = {
    generateInvoiceMedia,
    getGeneratedInvoices,
    // getGeneratedInvoiceById,
    getGeneratedInvoicesZip,
    getGeneratedAllInvoicesZip,
    InvoiceServiceError,
};
