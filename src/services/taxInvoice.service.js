const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const TaxInvoice = require("../models/TaxInvoice");
const User = require("../models/User");
const { generateTaxInvoicePdf } = require("../utils/pdfGenerator");
const { createZipBuffer } = require("../utils/zipGenerator");
const { InvoiceServiceError } = require("./invoice.service");

const taxInvoiceUploadDir = path.resolve(__dirname, "..", "..", "uploads", "tax-invoices");
const GSTIN_REGEX = /^[0-9]{2}[0-9A-Z]{13}$/;
const MOBILE_NUMBER_REGEX = /^91[6-9][0-9]{9}$/;
const INVOICE_DATE_REGEX = /^([0-2][0-9]|3[0-1])\/(0[1-9]|1[0-2])\/[0-9]{4}$/;

function validateInvoiceOwner(mobileNumber, gstin) {
    if (typeof mobileNumber !== "string" || !MOBILE_NUMBER_REGEX.test(mobileNumber.trim())) {
        throw new InvoiceServiceError("MobileNumber must be a valid 12 digit Indian mobile number with country code", 400);
    }

    const trimmedMobile = mobileNumber.trim();
    if (typeof gstin !== "string" || !gstin.trim()) {
        return {
            mobileNumber: trimmedMobile,
            gstin: "",
        };
    }

    const normalizedGstin = gstin.trim().toUpperCase();
    if (normalizedGstin === "NA") {
        return {
            mobileNumber: trimmedMobile,
            gstin: "NA",
        };
    }

    if (!GSTIN_REGEX.test(normalizedGstin)) {
        throw new InvoiceServiceError("Gstin must be a valid GSTIN or NA", 400);
    }

    return {
        mobileNumber: trimmedMobile,
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

function getTaxInvoicePdfPath(invoice) {
    const fileName = invoice.FileName || path.basename(invoice.RelativeUrl || "");

    if (!fileName) {
        return undefined;
    }

    return path.join(taxInvoiceUploadDir, path.basename(fileName));
}

function validateTaxInvoicePayload(body) {
    if (!body || typeof body !== "object") {
        throw new InvoiceServiceError("Request body is required", 400);
    }

    const requiredFields = [
        "InvoiceNo",
        "InvoiceDate",
        "BuyerTradeName",
        "BuyerAddress",
        "ProductDetails",
    ];

    const missingFields = requiredFields.filter((field) => !body[field]);

    if (missingFields.length > 0) {
        throw new InvoiceServiceError(`Missing required fields: ${missingFields.join(", ")}`, 400);
    }

    if (typeof body.BuyerAddress !== "string" || body.BuyerAddress.trim().length < 3) {
        throw new InvoiceServiceError("BuyerAddress must be a string with at least 3 characters", 400);
    }

    if (!Array.isArray(body.ProductDetails) || body.ProductDetails.length === 0) {
        throw new InvoiceServiceError("ProductDetails must be a non-empty array", 400);
    }
}

/**
 * Maps the flat tax-invoice request payload into the internal invoiceData
 * shape expected by the PDF generator draw* helpers.
 */
function mapPayloadToInvoiceData(body) {
    return {
        DocDtls: {
            No: body.InvoiceNo,
            Dt: body.InvoiceDate,
        },
        SellerDtls: {
            Gstin: body.SellerGstNo,
            Pan: body.SellerPanNo,
            TrdNm: body.SellerTradeName,
            LglNm: body.SellerTradeName,
            Addr1: body.SellerAddress,
        },
        BuyerDtls: {
            Gstin: body.BuyerGstNo || "",
            TrdNm: body.BuyerTradeName,
            LglNm: body.BuyerTradeName,
            Addr1: body.BuyerAddress,
        },
        ItemList: (body.ProductDetails || []).map((item) => ({
            SlNo: item["SrNo"] || item["Sr. No"] || item.SrNo || "",
            PrdDesc: item.Description || "",
            HsnCd: item["SAC/HSN Code"] || item["SACHSNCode"] || item.SACHSNCode || item.HsnCode || "",
            Qty: Number(item.Qty || 0),
            UnitPrice: Number(item["Unit Price"] || item.UnitPrice || 0),
            GstRt: Number(item["GST Rate"] || item.GSTRate || 0),
            GrossAmt: Number(item["Gross Amount"] || item.GrossAmount || 0),
        })),
        ValDtls: {
            SubTotal: Number(body.SubTotal || 0),
            IgstVal: Number(body["IGST Amount"] || body.IGSTAmount || 0),
            CgstVal: Number(body["CGST Amount"] || body.CGSTAmount || 0),
            SgstVal: Number(body["SGST Amount"] || body.SGSTAmount || 0),
            NetAmount: Number(body["Net Amount"] || body.NetAmount || 0),
            RndOffAmt: Number(body["Round Off"] || body.RoundOff || 0),
            TotInvVal: Number(body["Total Invoice Amount"] || body.TotalInvoiceAmount || 0),
        },
        PayDtls: {},
    };
}

async function generateTaxInvoiceMedia({ body, logoS3Url, mobileNumber, paymentMode, bankDetails }) {
    validateTaxInvoicePayload(body);
    const sellerGstin = body.SellerGstNo ? body.SellerGstNo.trim().toUpperCase() : "";
    const invoiceOwner = validateInvoiceOwner(mobileNumber, sellerGstin);

    const userQuery = { MobileNumber: invoiceOwner.mobileNumber };
    if (invoiceOwner.gstin && invoiceOwner.gstin !== "NA") {
        userQuery.Gstin = invoiceOwner.gstin;
    }

    const user = await User.findOne(userQuery, { _id: 0, id: 1, LogoS3Url: 1, Gstin: 1 }).lean();

    if (!user) {
        throw new InvoiceServiceError("User details not found for this MobileNumber", 404);
    }

    if (!body.SellerGstNo && user.Gstin) {
        body.SellerGstNo = user.Gstin;
    }

    const invoiceData = mapPayloadToInvoiceData(body);

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

    await fs.mkdir(taxInvoiceUploadDir, { recursive: true });

    const timestamp = Date.now();
    const fileName = `tax_invoice_${timestamp}.pdf`;
    const filePath = path.join(taxInvoiceUploadDir, fileName);
    const relativeUrl = `/user-details/uploads/tax-invoices/${fileName}`;

    const finalLogoUrl = logoS3Url || user.LogoS3Url || undefined;

    await generateTaxInvoicePdf({
        invoiceData,
        filePath,
        logoS3Url: finalLogoUrl,
    });

    const invoice = await TaxInvoice.create({
        InvoiceId: crypto.randomUUID(),
        UserId: user.id,
        MobileNumber: invoiceOwner.mobileNumber,
        Gstin: invoiceOwner.gstin || undefined,
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

async function getGeneratedTaxInvoices(mobileNumber, gstin) {
    const invoiceOwner = validateInvoiceOwner(mobileNumber, gstin);
    const query = { MobileNumber: invoiceOwner.mobileNumber };

    if (invoiceOwner.gstin) {
        query.Gstin = invoiceOwner.gstin;
    }

    return TaxInvoice.find(query, getInvoiceListProjection()).sort({ CreatedAt: -1 }).lean();
}

async function getGeneratedTaxInvoicesZip(mobileNumber, gstin, fromDate, toDate) {
    const invoices = filterInvoicesByDateRange(
        await getGeneratedTaxInvoices(mobileNumber, gstin),
        fromDate,
        toDate
    );

    if (invoices.length === 0) {
        throw new InvoiceServiceError("No tax invoices found for this MobileNumber, Gstin, and date range", 404);
    }

    const entries = [];
    const missingFiles = [];

    for (const invoice of invoices) {
        const pdfPath = getTaxInvoicePdfPath(invoice);

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
                throw new InvoiceServiceError("Unable to read tax invoice PDF file", 500);
            }

            missingFiles.push(path.basename(pdfPath));
        }
    }

    if (entries.length === 0) {
        const error = new InvoiceServiceError("No tax invoice PDF files found", 404);
        error.missingFiles = missingFiles;
        throw error;
    }

    const invoiceOwner = validateInvoiceOwner(mobileNumber, gstin);

    return {
        fileName: `tax_invoices_${invoiceOwner.mobileNumber}_${invoiceOwner.gstin}_${fromDate}_${toDate}.zip`
            .replace(/\//g, "-"),
        buffer: createZipBuffer(entries),
    };
}

module.exports = {
    generateTaxInvoiceMedia,
    getGeneratedTaxInvoices,
    getGeneratedTaxInvoicesZip,
};
