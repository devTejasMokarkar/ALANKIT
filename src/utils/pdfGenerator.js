const fs = require("fs");
const fsPromises = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
const { execFile } = require("child_process");
const { createLogoCache } = require("./LogoCache");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

let sharp;
try {
    sharp = require("sharp");
} catch (error) {
    console.error("[pdfGenerator] sharp is not installed in this environment. Run: npm install && pm2 restart <app-name>");
}


class PdfGenerationError extends Error {
    constructor(message) {
        super(message);
        this.name = "PdfGenerationError";
        this.statusCode = 500;
    }
}

function createLogoError(message) {
    const error = new PdfGenerationError(message);
    error.statusCode = 400;
    return error;
}

const safeText = (value, fallback = "") => {
    if (value === null || value === undefined || value === "") {
        return fallback;
    }

    return String(value);
};

const money = (value) => Number(value || 0).toFixed(2);
const number = (value) => Number(value || 0).toFixed(1).replace(/\.0$/, "");
const percent = (value) => Number(value || 0)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
const PAGE_WIDTH = 617;
const MIN_PAGE_HEIGHT = 608;
const PAGE_MARGIN = 5;
const PAGE_BORDER_WIDTH = PAGE_WIDTH - (PAGE_MARGIN * 2);
const ITEM_TABLE_START_Y = 367;
const SUPPORTED_LOGO_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/svg+xml",
    "image/webp",
    "image/avif",
    "application/pdf",
];
const ITEM_TABLE_HEADER_HEIGHT = 11;
const TOTALS_HEIGHT = 84;
const TERMS_GAP = 8;
const MAX_BUYER_ADDRESS_LENGTH = 50;
const QR_X = 10;
const QR_Y = 64;
const QR_SIZE = 190;
const ITEM_TABLE_COLUMNS = [
    { label: "S.No.", width: 38, align: "center" },
    { label: "Description", width: 140, align: "center" },
    { label: "SAC Code/HSN Code", width: 108, align: "center" },
    { label: "Qty.", width: 34, align: "center" },
    { label: "Unit Price", width: 60, align: "center" },
    { label: "GST Rate", width: 100, align: "center", valueAlign: "center" },
    { label: "Gross Amount", width: 127, align: "center", valueAlign: "right" },
];

function drawCell(doc, x, y, width, height, text, options = {}) {
    const {
        fill = null,
        align = "left",
        bold = false,
        fontSize = 7,
        padding = 3,
        color = "#000000",
        stroke = "#000000",
        ellipsis = true,
        valign = "top",
    } = options;

    if (fill) {
        doc.rect(x, y, width, height).fillAndStroke(fill, stroke);
    } else {
        doc.rect(x, y, width, height).stroke(stroke);
    }

    doc.fillColor(color)
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(fontSize);

    const textHeight = doc.heightOfString(safeText(text), {
        width: width - (padding * 2),
    });
    const textY = ellipsis || valign === "middle"
        ? y + Math.max(padding, (height - Math.min(textHeight, height - (padding * 2))) / 2)
        : y + padding;

    doc
        .text(safeText(text), x + padding, textY, {
            width: width - (padding * 2),
            height: height - (padding * 2),
            align,
            ellipsis,
        });
}

function getCellHeight(doc, text, width, options = {}) {
    const {
        bold = false,
        fontSize = 7,
        padding = 3,
        minHeight = 12,
    } = options;

    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);

    const textHeight = doc.heightOfString(safeText(text), {
        width: width - (padding * 2),
    });

    return Math.max(minHeight, Math.ceil(textHeight + (padding * 2)));
}

// Newly added
function getAddressCellHeight(doc, address, width) {
    const fontSize = 7;
    const padding = 3;
    const availableWidth = width - (padding * 2);

    doc.font("Helvetica").fontSize(fontSize);

    const textHeight = doc.heightOfString(safeText(address), {
        width: availableWidth,
        lineGap: 1,
    });

    return Math.max(12, Math.ceil(textHeight + (padding * 2)));
}


function getItemRowHeight(doc, values, columns, options) {
    return values.reduce((height, value, columnIndex) => Math.max(
        height,
        getCellHeight(doc, value, columns[columnIndex].width, options)
    ), options.minHeight);
}

function getItemRowsLayout(doc, rows, columns) {
    const profile = { fontSize: 8, padding: 3, minHeight: 13 };
    const rowHeights = rows.map((values) => getItemRowHeight(doc, values, columns, profile));

    return { ...profile, rowHeights, ellipsis: false };
}

function getItemRows(invoiceData) {
    return (invoiceData.ItemList || []).map((item, index) => {
        const quantity = getLineQuantity(item);
        const unitPrice = getLineUnitPrice(item);
        const gstRate = getLineGstRate(item);
        const grossAmount = getLineGrossAmount(item);

        return [
            index + 1,
            item.PrdDesc || item.PrdName || item.Description || "",
            item.HsnCd || item.SacCd || "",
            number(quantity),
            money(unitPrice),
            `${percent(gstRate)}%`,
            money(grossAmount),
        ];
    });
}

/**
 * Measures the needed height for the identity section (logo + trade name)
 * and returns the overflow beyond the default 70px.
 */
function getHeaderYOffset(doc, invoiceData, hasLogo) {
    const DEFAULT_IDENTITY_HEIGHT = 70;
    const logoWidth = 110;
    const identityWidth = 244;
    const textWidth = hasLogo ? identityWidth - logoWidth : identityWidth;
    const tradeName = safeText(
        (invoiceData.SellerDtls || {}).TrdNm || (invoiceData.SellerDtls || {}).LglNm,
        "Trade Name"
    );

    doc.font("Helvetica-Bold").fontSize(11);
    const textHeight = doc.heightOfString(tradeName, { width: textWidth - 16 });
    const neededHeight = Math.ceil(textHeight + 36); // 18px top + 18px bottom padding
    const identityHeight = Math.max(DEFAULT_IDENTITY_HEIGHT, neededHeight);

    return identityHeight - DEFAULT_IDENTITY_HEIGHT;
}

function getInvoicePageHeight(invoiceData, headerYOffset) {
    const measureDoc = new PDFDocument({
        size: [PAGE_WIDTH, MIN_PAGE_HEIGHT],
        margin: PAGE_MARGIN,
        autoFirstPage: false,
    });
    const yOffset = headerYOffset !== undefined
        ? headerYOffset
        : getHeaderYOffset(measureDoc, invoiceData, false);
    const rows = getItemRows(invoiceData);
    const rowsLayout = getItemRowsLayout(measureDoc, rows, ITEM_TABLE_COLUMNS);
    const tableEndY = (ITEM_TABLE_START_Y + yOffset) + ITEM_TABLE_HEADER_HEIGHT +
        rowsLayout.rowHeights.reduce((sum, height) => sum + height, 0);
    const totalsEndY = tableEndY + TOTALS_HEIGHT;
    const termsStartY = Math.max(totalsEndY + TERMS_GAP, 459 + yOffset);
    // const contentEndY = termsStartY + TERMS_MIN_HEIGHT + PAGE_MARGIN;
    const termsHeight = 120; // enough for terms + bank details + footer

    const contentEndY =
        termsStartY +
        termsHeight +
        PAGE_MARGIN;

    return Math.max(MIN_PAGE_HEIGHT, Math.ceil(contentEndY));
}

function drawLabelValueRow(doc, x, y, labelWidth, valueWidth, height, label, value) {
    drawCell(doc, x, y, labelWidth, height, `${label} :`, {
        align: "right",
        bold: true,
        fontSize: 7,
        padding: 4,
        stroke: "#000000",
    });
    drawCell(doc, x + labelWidth, y, valueWidth, height, value, {
        align: "center",
        bold: true,
        fontSize: 7,
        stroke: "#000000",
    });
}

function formatDate(dateValue) {
    const value = safeText(dateValue);

    if (!value) {
        return "";
    }

    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
        const [year, month, day] = value.slice(0, 10).split("-");
        return `${day}/${month}/${year}`;
    }

    return value;
}

function formatAddress(party, maxLength) {
    const addressParts = [
        party?.Addr1,
        party?.Addr2,
        party?.Loc,
        ...(maxLength === undefined ? [party?.Pin] : []),
    ].filter(Boolean);

    // const address = addressParts.join(", ");
    // const pincode = (address.match(/\b\d{6}\b/) || [""])[0];

    const address = addressParts.join(", ");

// Check pincode from address first, otherwise use Pin key
    const pincode =(address.match(/\b\d{6}\b/) || [safeText(party?.Pin).trim()])[0];

    if (maxLength === undefined) {
        return address;
    }

    if (!pincode) {                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         
        return address.substring(0, maxLength);
    }

    const addressWithoutPincode = address.replace(new RegExp(`\\s*,?\\s*${pincode}\\b`), "");
    const pincodeSuffix = addressWithoutPincode ? `, ${pincode}` : pincode;
    const addressLength = Math.max(0, maxLength - pincodeSuffix.length);

    return `${addressWithoutPincode.substring(0, addressLength)}${pincodeSuffix}`.substring(0, maxLength);
}

function getNumberValue(...values) {
    const value = values.find((candidate) => (
        candidate !== undefined &&
        candidate !== null &&
        candidate !== ""
    ));

    return Number(value || 0);
}

function getGstinStateCode(gstin) {
    const value = safeText(gstin).trim();

    return /^\d{2}/.test(value) ? value.substring(0, 2) : "";
}

function isInterStateSupply(invoiceData) {
    const sellerStateCode = getGstinStateCode(invoiceData.SellerDtls?.Gstin);
    const buyerStateCode = getGstinStateCode(invoiceData.BuyerDtls?.Gstin);

    return Boolean(sellerStateCode && buyerStateCode && sellerStateCode !== buyerStateCode);
}

function getLineQuantity(item) {
    return getNumberValue(item.Qty, item.Quantity, 1);
}

function getLineUnitPrice(item) {
    return getNumberValue(item.UnitPrice, item.Price, item.Rate);
}

function getLineGrossAmount(item) {
    return getLineQuantity(item) * getLineUnitPrice(item);
}

function getLineGstRate(item) {
    return getNumberValue(item.GstRt, item.GSTRate);
}

function getSubtotal(items) {
    return items.reduce((sum, item) => sum + getLineGrossAmount(item), 0);
}

function getTaxBreakup(invoiceData) {
    const items = invoiceData.ItemList || [];
    const interState = isInterStateSupply(invoiceData);

    return items.reduce((totals, item) => {
        const taxAmount = (getLineGrossAmount(item) * getLineGstRate(item)) / 100;

        if (interState) {
            totals.igst += taxAmount;
        } else {
            totals.cgst += taxAmount / 2;
            totals.sgst += taxAmount / 2;
        }

        return totals;
    }, { igst: 0, cgst: 0, sgst: 0 });
}

function getInvoiceTotals(invoiceData) {
    const subtotal = getSubtotal(invoiceData.ItemList || []);
    const { igst, cgst, sgst } = getTaxBreakup(invoiceData);

    // Calculate net amount before round-off
    const netAmount = subtotal + igst + cgst + sgst;

    // Automatically round total invoice amount to nearest whole number
    const roundedTotal = Math.round(netAmount);

    // Calculate the round-off amount
    const roundOff = roundedTotal - netAmount;

    return {
        subtotal,
        igst,
        cgst,
        sgst,
        netAmount,
        roundOff,
        total: roundedTotal,
    };
}

// function getInvoiceTotals(invoiceData) {
//     const subtotal = getSubtotal(invoiceData.ItemList || []);
//     const { igst, cgst, sgst } = getTaxBreakup(invoiceData);
//     const netAmount = subtotal + igst + cgst + sgst;
//     const roundOff = Number(invoiceData.ValDtls?.RndOffAmt || 0);

//     return {
//         subtotal,
//         igst,
//         cgst,
//         sgst,
//         netAmount,
//         roundOff,
//         total: netAmount + roundOff,
//     };
// }

function getColumnX(startX, columns, columnIndex) {
    return startX + columns
        .slice(0, columnIndex)
        .reduce((sum, column) => sum + column.width, 0);
}

function drawLogo(doc, x, y, width, height, logoBuffer) {
    const imagePadding = 1;

    drawCell(doc, x, y, width, height, "", { padding: imagePadding });
    doc.image(logoBuffer, x + imagePadding, y + imagePadding, {
        fit: [width - (imagePadding * 2), height - (imagePadding * 2)],
        align: "center",
        valign: "center",
    });
}

function drawBuyerIdentity(doc, x, y, width, height, buyer, logoBuffer) {
    const logoWidth = 110;
    const hasLogo = Boolean(logoBuffer);
    const textX = hasLogo ? x + logoWidth : x;
    const textWidth = hasLogo ? width - logoWidth : width;
    const tradeName = safeText(buyer.TrdNm || buyer.LglNm, "Trade Name");

    if (hasLogo) {
        drawLogo(doc, x, y, logoWidth, height, logoBuffer);
    }

    drawCell(doc, textX, y, textWidth, height, "", {
        padding: 4,
    });

    doc.font("Helvetica-Bold").fontSize(11);
    const textHeight = doc.heightOfString(tradeName, { width: textWidth - 16 });
    const textY = y + Math.max(8, (height - textHeight) / 2);

    doc.fillColor("#000000")
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(tradeName, textX + 8, textY, {
            width: textWidth - 16,
            lineBreak: true,
        });
}

function drawHeader(doc, invoiceData, logoBuffer) {
    const pageWidth = doc.page.width;
    const titleX = pageWidth - 190;

    drawCell(doc, titleX, 5, 185, 28, "Tax Invoice", {
        fill: "#d9d9d9",
        align: "center",
        bold: true,
        fontSize: 18,
    });

    doc.moveTo(5, 5).lineTo(titleX, 5).stroke();
    doc.moveTo(5, 5).lineTo(5, 57).stroke();

    const rightX = pageWidth - 138;
    const identityY = QR_Y;
    const yOffset = getHeaderYOffset(doc, invoiceData, Boolean(logoBuffer));
    const identityHeight = 70 + yOffset;
    const infoGap = 15;
    const infoY = identityY + identityHeight + infoGap;
    const rowHeight = 35;
    const docDtls = invoiceData.DocDtls || {};
    const seller = invoiceData.SellerDtls || {};

    drawBuyerIdentity(doc, rightX - 112, identityY, 244, identityHeight, seller, logoBuffer);
    drawLabelValueRow(doc, rightX - 112, infoY, 112, 132, rowHeight, "PAN No", seller.Pan || safeText(seller.Gstin).substring(2, 12));
    drawLabelValueRow(doc, rightX - 112, infoY + rowHeight, 112, 132, rowHeight, "Invoice No.", docDtls.No);
    drawLabelValueRow(doc, rightX - 112, infoY + (rowHeight * 2), 112, 132, rowHeight, "Invoice Date", formatDate(docDtls.Dt));

    return yOffset;
}

function drawQr(doc, qrBuffer) {
    doc.image(qrBuffer, QR_X, QR_Y, { width: QR_SIZE, height: QR_SIZE });
}

function drawIrnAndCustomer(doc, invoiceData, irnResponse, yOffset) {
    const leftX = 5;
    const rightX = 368;
    const y = 274 + (yOffset || 0);
    const leftWidth = 340;
    const rightWidth = 244;
    const seller = invoiceData.SellerDtls || {};
    const buyer = invoiceData.BuyerDtls || {};

    drawCell(doc, leftX, y, leftWidth, 13, "IRN No:", { bold: true, fontSize: 7 });
    doc.font("Helvetica").fontSize(7).fillColor("#000000").text(safeText(irnResponse.Irn), leftX + 4, y + 15, {
        width: leftWidth - 8,
        height: 10,
        ellipsis: true,
    });
    doc.rect(leftX, y + 13, leftWidth, 11).stroke();

    drawCell(doc, leftX, y + 24, leftWidth, 12, `GST No: ${safeText(seller.Gstin)}`, { bold: true, fontSize: 7 });
    drawCell(doc, leftX, y + 36, leftWidth, 13, safeText(seller.LglNm || seller.TrdNm), { bold: true, fontSize: 7 });
    drawCell(doc, leftX, y + 49, leftWidth, 13, formatAddress(seller), { fontSize: 7 });

    drawCell(doc, rightX, y, rightWidth, 18, "Original Copy", {
        fill: "#000000",
        color: "#ffffff",
        align: "right",
        bold: true,
        fontSize: 9,
        padding: 8,
    });
    drawCell(doc, rightX, y + 18, rightWidth, 12, `CUSTOMER GST: ${safeText(buyer.Gstin)}`, { bold: true, fontSize: 7 });
    drawCell(doc, rightX, y + 30, rightWidth, 12, `SHIPPING / CONSIGNEE TO : ${safeText(buyer.LglNm || buyer.TrdNm)}`, { bold: true, fontSize: 7, ellipsis: false });
    drawCell(doc, rightX, y + 42, rightWidth, 12, safeText(buyer.LglNm || buyer.TrdNm), { fontSize: 7 });
    // drawCell(doc, rightX, y + 54, rightWidth, 12, formatAddress(buyer), { fontSize: 7 });
    const buyerAddress = formatAddress(buyer, MAX_BUYER_ADDRESS_LENGTH);

    const buyerAddressHeight = getAddressCellHeight(
        doc,
        buyerAddress,
        rightWidth
    );

    drawCell(
        doc,
        rightX,
        y + 54,
        rightWidth,
        buyerAddressHeight,
        buyerAddress,
        {
            fontSize: 7,
            padding: 3,
            ellipsis: false,
            valign: "top",
        }
    );
}

/**
 * Draws seller / buyer details WITHOUT IRN No.
 * Used by the tax-invoice PDF (no QR, no IRN).
 */
function drawSellerBuyerNoIrn(doc, invoiceData, yOffset) {
    const leftX = 5;
    const rightX = 368;
    const y = 274 + (yOffset || 0);
    const leftWidth = 340;
    const rightWidth = 244;
    const seller = invoiceData.SellerDtls || {};
    const buyer = invoiceData.BuyerDtls || {};

    drawCell(doc, leftX, y, leftWidth, 12, `GST No: ${safeText(seller.Gstin)}`, { bold: true, fontSize: 7 });
    drawCell(doc, leftX, y + 12, leftWidth, 13, safeText(seller.LglNm || seller.TrdNm), { bold: true, fontSize: 7 });
    drawCell(doc, leftX, y + 25, leftWidth, 13, formatAddress(seller), { fontSize: 7 });

    drawCell(doc, rightX, y, rightWidth, 18, "Original Copy", {
        fill: "#000000",
        color: "#ffffff",
        align: "right",
        bold: true,
        fontSize: 9,
        padding: 8,
    });
    drawCell(doc, rightX, y + 18, rightWidth, 12, `CUSTOMER GST: ${safeText(buyer.Gstin)}`, { bold: true, fontSize: 7 });
    drawCell(doc, rightX, y + 30, rightWidth, 12, `SHIPPING / CONSIGNEE TO : ${safeText(buyer.LglNm || buyer.TrdNm)}`, { bold: true, fontSize: 7, ellipsis: false });
    drawCell(doc, rightX, y + 42, rightWidth, 12, safeText(buyer.LglNm || buyer.TrdNm), { fontSize: 7 });
    // drawCell(doc, rightX, y + 54, rightWidth, 12, formatAddress(buyer), { fontSize: 7 });
    const buyerAddress = formatAddress(buyer, MAX_BUYER_ADDRESS_LENGTH);

    const buyerAddressHeight = getAddressCellHeight(
        doc,
        buyerAddress,
        rightWidth
    );
    
    drawCell(
        doc,
        rightX,
        y + 54,
        rightWidth,
        buyerAddressHeight,
        buyerAddress,
        {
            fontSize: 7,
            padding: 3,
            ellipsis: false,
            valign: "top",
        }
    );
}

function drawItemsTable(doc, invoiceData, yOffset) {
    const startX = 5;
    const startY = ITEM_TABLE_START_Y + (yOffset || 0);
    const columns = ITEM_TABLE_COLUMNS;

    let x = startX;
    columns.forEach((column) => {
        drawCell(doc, x, startY, column.width, ITEM_TABLE_HEADER_HEIGHT, column.label, {
            fill: "#d9d9d9",
            align: column.align,
            bold: true,
            fontSize: 7,
        });
        x += column.width;
    });

    const rows = getItemRows(invoiceData);
    const rowsLayout = getItemRowsLayout(doc, rows, columns);

    let y = startY + ITEM_TABLE_HEADER_HEIGHT;
    rows.forEach((values, index) => {
        const rowHeight = rowsLayout.rowHeights[index];

        x = startX;
        values.forEach((value, columnIndex) => {
            drawCell(doc, x, y, columns[columnIndex].width, rowHeight, value, {
                align: columns[columnIndex].valueAlign || columns[columnIndex].align,
                fontSize: rowsLayout.fontSize,
                padding: rowsLayout.padding,
                ellipsis: false,
                valign: "middle",
            });
            x += columns[columnIndex].width;
        });
        y += rowHeight;
    });

    return y;
}

function drawTotals(doc, invoiceData, y) {
    const startX = 5;
    const columns = ITEM_TABLE_COLUMNS;
    const gstRateColumnIndex = columns.length - 2;
    const grossAmountColumnIndex = columns.length - 1;
    const labelX = getColumnX(startX, columns, gstRateColumnIndex);
    const labelWidth = columns[gstRateColumnIndex].width;
    const valueX = getColumnX(startX, columns, grossAmountColumnIndex);
    const valueWidth = columns[grossAmountColumnIndex].width;
    const totals = getInvoiceTotals(invoiceData);
    const rows = [
        ["Subtotal:", totals.subtotal],
        ["IGST Amount:", totals.igst],
        ["CGST Amount:", totals.cgst],
        ["SGST Amount:", totals.sgst],
        ["Net Amount:", totals.netAmount],
        ["Round Off:", totals.roundOff],
        ["Total Invoice Amount:", totals.total],
    ];

    let rowY = y;
    rows.forEach(([label, value], index) => {
        const isStrong = index >= 4;
        drawCell(doc, labelX, rowY, labelWidth, 12, label, {
            align: "center",
            bold: isStrong,
            fontSize: 7,
            padding: 5,
        });
        drawCell(doc, valueX, rowY, valueWidth, 12, money(value), {
            align: "right",
            bold: isStrong,
            fontSize: 7,
            padding: 5,
        });
        rowY += 12;
    });

    return rowY;
}

function drawTotalsFromPayload(doc, invoiceData, y) {
    const startX = 5;
    const columns = ITEM_TABLE_COLUMNS;
    const gstRateColumnIndex = columns.length - 2;
    const grossAmountColumnIndex = columns.length - 1;

    const labelX = getColumnX(startX, columns, gstRateColumnIndex);
    const labelWidth = columns[gstRateColumnIndex].width;

    const valueX = getColumnX(startX, columns, grossAmountColumnIndex);
    const valueWidth = columns[grossAmountColumnIndex].width;

    const valDtls = invoiceData.ValDtls || {};

    const subtotal = Number(valDtls.SubTotal || 0);
    const igst = Number(valDtls.IgstVal || 0);
    const cgst = Number(valDtls.CgstVal || 0);
    const sgst = Number(valDtls.SgstVal || 0);

    // Net amount before round-off
    const netAmount = Number(
        valDtls.NetAmount || (subtotal + igst + cgst + sgst)
    );

    // Automatically round total invoice amount
    const roundedTotal = Math.round(netAmount);

    // Calculate round-off difference
    const roundOff = roundedTotal - netAmount;

    const rows = [
        ["Subtotal:", subtotal],
        ["IGST Amount:", igst],
        ["CGST Amount:", cgst],
        ["SGST Amount:", sgst],
        ["Net Amount:", netAmount],
        ["Round Off:", roundOff],
        ["Total Invoice Amount:", roundedTotal],
    ];

    let rowY = y;

    rows.forEach(([label, value], index) => {
        const isStrong = index >= 4;

        drawCell(doc, labelX, rowY, labelWidth, 12, label, {
            align: "center",
            bold: isStrong,
            fontSize: 7,
            padding: 5,
        });

        drawCell(doc, valueX, rowY, valueWidth, 12, money(value), {
            align: "right",
            bold: isStrong,
            fontSize: 7,
            padding: 5,
        });

        rowY += 12;
    });

    return rowY;
}




/**
 * Draws totals using explicit values from the request payload
 * instead of computing from item lines.
 */
// function drawTotalsFromPayload(doc, invoiceData, y) {
//     const startX = 5;
//     const columns = ITEM_TABLE_COLUMNS;
//     const gstRateColumnIndex = columns.length - 2;
//     const grossAmountColumnIndex = columns.length - 1;
//     const labelX = getColumnX(startX, columns, gstRateColumnIndex);
//     const labelWidth = columns[gstRateColumnIndex].width;
//     const valueX = getColumnX(startX, columns, grossAmountColumnIndex);
//     const valueWidth = columns[grossAmountColumnIndex].width;
//     const valDtls = invoiceData.ValDtls || {};
//     const rows = [
//         ["Subtotal:", Number(valDtls.SubTotal || 0)],
//         ["IGST Amount:", Number(valDtls.IgstVal || 0)],
//         ["CGST Amount:", Number(valDtls.CgstVal || 0)],
//         ["SGST Amount:", Number(valDtls.SgstVal || 0)],
//         ["Net Amount:", Number(valDtls.NetAmount || 0)],
//         ["Round Off:", Number(valDtls.RndOffAmt || 0)],
//         ["Total Invoice Amount:", Number(valDtls.TotInvVal || 0)],
//     ];

//     let rowY = y;
//     rows.forEach(([label, value], index) => {
//         const isStrong = index >= 4;
//         drawCell(doc, labelX, rowY, labelWidth, 12, label, {
//             align: "center",
//             bold: isStrong,
//             fontSize: 7,
//             padding: 5,
//         });
//         drawCell(doc, valueX, rowY, valueWidth, 12, money(value), {
//             align: "right",
//             bold: isStrong,
//             fontSize: 7,
//             padding: 5,
//         });
//         rowY += 12;
//     });

//     return rowY;
// }

function drawTerms(doc, invoiceData, y, yOffset) {
    const seller = invoiceData.SellerDtls || {};
    const startY = Math.max(y + TERMS_GAP, 459 + (yOffset || 0));
    const bodyY = startY + 24;

    doc.rect(5, startY, 607, 20).fill("#d9d9d9");
    doc.strokeColor("#000000");
    doc.moveTo(5, startY).lineTo(612, startY).stroke();
    doc.moveTo(5, startY + 20).lineTo(612, startY + 20).stroke();
    doc.fillColor("#000000")
        .font("Helvetica-Bold")
        .fontSize(8)
        .text("Terms & Special Instructions:", 8, startY + 6, {
            width: 601,
            height: 12,
        });

    const lines = [
        "1. DD/Cheque in favour of seller payable at registered office only.",
        "2. Interest will be applicable if payment not made within 45 days of receipt of goods/services as per Provision of Section 16 MSMED Act, 2006",
        "3. Goods once sold will not be taken back or exchanged.",
        "4. If cheque bounced then charges is applicable of Rs.1000/-.",
        "5. All disputes will be settled at District Courts Only.",
        `6. Payment Mode: ${safeText(invoiceData.PayDtls?.Mode, "Cash")}`,
    ];

    doc.font("Helvetica").fontSize(6).fillColor("#000000")
        .text(lines.join("\n"), 9, bodyY, {
            width: 595,
            height: 48,
            lineGap: 0,
        });

    doc.font("Helvetica").fontSize(6).fillColor("#000000")
        .text(`Bank Name: ${safeText(invoiceData.PayDtls?.Nm || seller.BankName)}`, 20, bodyY + 42, {
            width: 220,
            ellipsis: true,
        })
        .text(`Account No: ${safeText(invoiceData.PayDtls?.AcctDet)}`, 20, bodyY + 50, {
            width: 220,
            ellipsis: true,
        })
        .text(`IFSC Code: ${safeText(invoiceData.PayDtls?.Ifsc)}`, 20, bodyY + 58, {
            width: 220,
            ellipsis: true,
        });

    // Footer should always stay near bottom border
    const footerBottomMargin = 2;
    const footerHeight = 18;

    let footerY =
        doc.page.height -
        PAGE_MARGIN -
        footerHeight -
        footerBottomMargin;

    // Never allow footer to overlap bank details
    footerY = Math.max(footerY, bodyY + 68);

    doc.font("Helvetica")
        .fontSize(7)
        .fillColor("#000000")
        .text(
            "This is a computer-generated invoice and does not require a signature.",
            200,
            footerY,
            {
                width: 260,
                align: "center",
            }
        );

    doc.font("Helvetica-Bold")
        .fontSize(7)
        .fillColor("#000000")
        .text(
            "Generated via WhatsApp by Alankit (GSP)",
            200,
            footerY + 10,
            {
                width: 260,
                align: "center",
            }
        );
}

async function createQRCodeBuffer(signedQRCode) {
    if (!signedQRCode || typeof signedQRCode !== "string") {
        const error = new PdfGenerationError("SignedQRCode is required");
        error.statusCode = 400;
        throw error;
    }

    try {
        return QRCode.toBuffer(signedQRCode, {
            errorCorrectionLevel: "M",
            margin: 0,
            width: 260,
        });
    } catch (error) {
        const qrError = new PdfGenerationError("Invalid SignedQRCode");
        qrError.statusCode = 400;
        throw qrError;
    }
}

function fetchLogoBuffer(logoS3Url, redirectCount = 0, deadlineAt = Date.now() + 10000) {
    return new Promise((resolve, reject) => {
        if (Date.now() >= deadlineAt) {
            reject(createLogoError("LogoS3Url image download timed out"));
            return;
        }
        const url = new URL(logoS3Url);
        const client = url.protocol === "https:" ? https : http;
        const request = client.get(url, (response) => {
            response.on("aborted", () => {
                reject(createLogoError("LogoS3Url image download was interrupted"));
            });
            response.on("error", () => {
                reject(createLogoError("Unable to read LogoS3Url image"));
            });
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.resume();

                if (!response.headers.location || redirectCount >= 3) {
                    reject(createLogoError("Unable to fetch LogoS3Url"));
                    return;
                }

                resolve(fetchLogoBuffer(new URL(response.headers.location, url).toString(), redirectCount + 1, deadlineAt));
                return;
            }

            if (response.statusCode < 200 || response.statusCode >= 300) {
                response.resume();
                reject(createLogoError("Unable to fetch LogoS3Url"));
                return;
            }

            const chunks = [];
            let totalBytes = 0;
            const maxLogoBytes = 5 * 1024 * 1024;

            response.on("data", (chunk) => {
                totalBytes += chunk.length;

                if (totalBytes > maxLogoBytes) {
                    request.destroy(createLogoError("LogoS3Url image must be 5 MB or smaller"));
                    return;
                }

                chunks.push(chunk);
            });
            response.on("end", () => {
                if (!response.complete) {
                    reject(createLogoError("LogoS3Url image download was incomplete"));
                    return;
                }
                const buffer = Buffer.concat(chunks);
                const contentType = inferContentTypeFromBuffer(buffer, safeText(response.headers["content-type"]).toLowerCase());
                const isSupportedLogoType = SUPPORTED_LOGO_MIME_TYPES.some((type) => contentType.includes(type));

                if (contentType && !isSupportedLogoType) {
                    resolve(null);
                    return;
                }

                resolve({
                    buffer,
                    contentType,
                });
            });
        });

        // Bound the whole download, including a response that keeps trickling data.
        const deadline = setTimeout(() => {
            request.destroy(createLogoError("LogoS3Url image download timed out"));
        }, Math.max(1, deadlineAt - Date.now()));
        deadline.unref();
        request.once("close", () => clearTimeout(deadline));
        request.on("error", (error) => {
            reject(error instanceof PdfGenerationError ? error : createLogoError("Unable to fetch LogoS3Url"));
        });
    });
}

function inferContentTypeFromBuffer(buffer, fallback = "") {
    const normalizedFallback = safeText(fallback).toLowerCase();

    if (!buffer || !Buffer.isBuffer(buffer)) {
        return normalizedFallback === "9j" ? "image/jpeg" : normalizedFallback;
    }

    if (buffer.slice(0, 4).toString("hex") === "ffd8ff") {
        return "image/jpeg";
    }

    if (buffer.slice(0, 8).toString("hex") === "89504e470d0a1a0a") {
        return "image/png";
    }

    if (buffer.slice(0, 5).toString("latin1") === "%PDF-") {
        return "application/pdf";
    }

    const head = buffer.slice(0, 512).toString("latin1").toLowerCase();
    if (head.includes("<svg") || head.includes("<?xml")) {
        return "image/svg+xml";
    }

    if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
        return "image/webp";
    }

    if (buffer.slice(0, 4).toString("ascii") === "ftyp" || head.includes("ftyp")) {
        return "image/avif";
    }

    if (normalizedFallback === "9j" || normalizedFallback === "jpeg" || normalizedFallback === "jpg" || normalizedFallback === "image/jpg") {
        return "image/jpeg";
    }

    return normalizedFallback;
}

function isPdfBuffer(buffer, contentType) {
    return contentType.includes("application/pdf") || buffer.slice(0, 4).toString() === "%PDF";
}

function convertPdfLogoToPngBuffer(pdfBuffer) {
    return new Promise(resolve => {
        // With no output prefix, pdftoppm writes the PNG to stdout; '-' reads PDF from stdin.
        const child = execFile("pdftoppm", [
            "-f", "1", "-singlefile", "-png", "-r", "150", "-",
        ], { timeout: 10000, encoding: "buffer", maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
            resolve(error ? null : stdout);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(pdfBuffer);
    });
}

async function renderLogoBuffer(logoS3Url) {
    if (!logoS3Url) {
        return null;
    }

    if (!sharp) {
        console.error("[pdfGenerator] Skipping logo rendering because sharp is unavailable.");
        return null;
    }

    let logoBuffer;
    let contentType = "";

    const isLocal = logoS3Url.startsWith("/") || logoS3Url.includes("/user-details/uploads/");
    if (isLocal) {
        try {
            let pathname = logoS3Url;
            if (logoS3Url.startsWith("http")) {
                const parsed = new URL(logoS3Url);
                pathname = parsed.pathname;
            }

            const relativePath = pathname.replace("/user-details/uploads/", "");
            const filePath = path.resolve(__dirname, "..", "..", "uploads", relativePath);

            logoBuffer = await fsPromises.readFile(filePath);
            const ext = path.extname(filePath).toLowerCase();
            if (ext === ".pdf") {
                contentType = "application/pdf";
            } else if (ext === ".png") {
                contentType = "image/png";
            } else if (ext === ".jpg" || ext === ".jpeg") {
                contentType = "image/jpeg";
            } else if (ext === ".svg") {
                contentType = "image/svg+xml";
            } else if (ext === ".webp") {
                contentType = "image/webp";
            } else if (ext === ".avif") {
                contentType = "image/avif";
            }
        } catch (err) {
            console.error("Failed to read local logo file:", err);
            return null;
        }
    } else {
        try {
            const logoAsset = await fetchLogoBuffer(logoS3Url);
            if (!logoAsset) {
                return null;
            }
            logoBuffer = logoAsset.buffer;
            contentType = logoAsset.contentType;
        } catch (error) {
            return null;
        }
    }

    if (isPdfBuffer(logoBuffer, contentType)) {
        logoBuffer = await convertPdfLogoToPngBuffer(logoBuffer);
    }

    if (!logoBuffer) return null;

    try {
        // Remove EXIF, normalize, resize, and convert to PNG (for transparent bg support)
        logoBuffer = await sharp(logoBuffer)
            .rotate()      // applies orientation
            .resize({
                width: 324,
                height: 450,
                fit: "inside",
                withoutEnlargement: true,
            })
            .png()
            .toBuffer();

        return logoBuffer;
    } catch (err) {
        console.error("Sharp conversion failed:", err);
        return null;
    }
}

// Cache normalized PNG buffers in memory; no logo files are created.
const getMemoryLogo = createLogoCache(renderLogoBuffer, { maxEntries: 32 });
async function createLogoBuffer(logoS3Url) {
    if (!logoS3Url) return null;
    try { return await getMemoryLogo(logoS3Url); }
    catch (error) { return null; }
}

async function generateInvoicePdf({ invoiceData, irnResponse, filePath, logoS3Url }) {
    if (!invoiceData?.SellerDtls || !invoiceData?.BuyerDtls || !Array.isArray(invoiceData?.ItemList)) {
        const error = new PdfGenerationError("Missing required invoice data");
        error.statusCode = 400;
        throw error;
    }

    const qrBuffer = await createQRCodeBuffer(irnResponse.SignedQRCode);

    const logoBuffer = await createLogoBuffer(logoS3Url);

    const measureDoc = new PDFDocument({ size: [PAGE_WIDTH, MIN_PAGE_HEIGHT], margin: PAGE_MARGIN, autoFirstPage: false });
    const headerYOffset = getHeaderYOffset(measureDoc, invoiceData, Boolean(logoBuffer));
    const pageHeight = getInvoicePageHeight(invoiceData, headerYOffset);

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: [PAGE_WIDTH, pageHeight],
            margin: PAGE_MARGIN,
            bufferPages: false,
            autoFirstPage: true,
            info: {
                Title: `Tax Invoice ${safeText(invoiceData.DocDtls?.No)}`,
                Author: safeText(invoiceData.SellerDtls?.LglNm, "NIC E-Invoice"),
            },
        });

        doc.on("error", () => reject(new PdfGenerationError("PDF generation failure")));
        if (filePath) {
            const stream = fs.createWriteStream(filePath);
            stream.on("finish", resolve);
            stream.on("error", () => reject(new PdfGenerationError("File write failure")));
            doc.pipe(stream);
        } else {
            const chunks = [];
            doc.on("data", chunk => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
        }

        doc.lineWidth(0.7).strokeColor("#000000");
        doc.rect(PAGE_MARGIN, PAGE_MARGIN, PAGE_BORDER_WIDTH, pageHeight - (PAGE_MARGIN * 2)).stroke("#000000");
        const yOffset = drawHeader(doc, invoiceData, logoBuffer);
        drawQr(doc, qrBuffer);
        drawIrnAndCustomer(doc, invoiceData, irnResponse, yOffset);
        const tableEndY = drawItemsTable(doc, invoiceData, yOffset);
        const totalsEndY = drawTotals(doc, invoiceData, tableEndY);
        drawTerms(doc, invoiceData, totalsEndY, yOffset);

        doc.end();
    });
}

/**
 * Generates a tax-invoice PDF WITHOUT QR code and IRN.
 * Same layout as the IRN invoice but the QR / IRN area is omitted
 * and totals are taken directly from the payload.
 */
async function generateTaxInvoicePdf({ invoiceData, filePath, logoS3Url }) {
    if (!invoiceData?.SellerDtls || !invoiceData?.BuyerDtls || !Array.isArray(invoiceData?.ItemList)) {
        const error = new PdfGenerationError("Missing required invoice data");
        error.statusCode = 400;
        throw error;
    }

    const logoBuffer = await createLogoBuffer(logoS3Url);
    const measureDoc = new PDFDocument({ size: [PAGE_WIDTH, MIN_PAGE_HEIGHT], margin: PAGE_MARGIN, autoFirstPage: false });
    const headerYOffset = getHeaderYOffset(measureDoc, invoiceData, Boolean(logoBuffer));
    const pageHeight = getInvoicePageHeight(invoiceData, headerYOffset);

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: [PAGE_WIDTH, pageHeight],
            margin: PAGE_MARGIN,
            bufferPages: false,
            autoFirstPage: true,
            info: {
                Title: `Tax Invoice ${safeText(invoiceData.DocDtls?.No)}`,
                Author: safeText(invoiceData.SellerDtls?.LglNm, "Tax Invoice"),
            },
        });

        const stream = fs.createWriteStream(filePath);

        stream.on("finish", resolve);
        stream.on("error", () => reject(new PdfGenerationError("File write failure")));
        doc.on("error", () => reject(new PdfGenerationError("PDF generation failure")));

        doc.pipe(stream);

        doc.lineWidth(0.7).strokeColor("#000000");
        doc.rect(PAGE_MARGIN, PAGE_MARGIN, PAGE_BORDER_WIDTH, pageHeight - (PAGE_MARGIN * 2)).stroke("#000000");
        const yOffset = drawHeader(doc, invoiceData, logoBuffer);
        // NO QR code drawn
        drawSellerBuyerNoIrn(doc, invoiceData, yOffset);
        const tableEndY = drawItemsTable(doc, invoiceData, yOffset);
        const totalsEndY = drawTotalsFromPayload(doc, invoiceData, tableEndY);
        drawTerms(doc, invoiceData, totalsEndY, yOffset);

        doc.end();
    });
}

module.exports = { generateInvoicePdf, generateTaxInvoicePdf, fetchLogoBuffer, createLogoBuffer, PdfGenerationError };
