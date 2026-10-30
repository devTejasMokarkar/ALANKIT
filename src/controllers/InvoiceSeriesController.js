const User = require("../models/User");
const { sendDuplicateUserError } = require("../utils/DuplicateUserError");
const InvoiceSeriesHistory = require("../models/InvoiceSeriesHistory");
const logger = require("../utils/Logger");

const GSTIN_REGEX = /^[0-9]{2}[0-9A-Z]{13}$/;
const MOBILE_NUMBER_REGEX = /^91[6-9][0-9]{9}$/;
const INVOICE_SERIES_REGEX = /^[a-zA-Z1-9][a-zA-Z0-9/-]{0,15}$/;

async function updateInvoiceSeries(req, res, next) {
    try {
        const { Gstin, MobileNumber, InvoiceSeries } = req.body || {};
        const errors = [];

        if (Gstin !== undefined && Gstin !== null && typeof Gstin !== "string") {
            errors.push("Gstin must be a string if provided");
        } else if (typeof Gstin === "string" && Gstin.trim()) {
            if (!GSTIN_REGEX.test(Gstin.trim().toUpperCase())) {
                errors.push("Gstin must be a valid GSTIN");
            }
        }

        if (!MobileNumber || typeof MobileNumber !== "string" || !MobileNumber.trim()) {
            errors.push("MobileNumber is required");
        } else if (!MOBILE_NUMBER_REGEX.test(MobileNumber.trim())) {
            errors.push("MobileNumber must be a valid 12 digit Indian mobile number with country code");
        }

        if (!InvoiceSeries || typeof InvoiceSeries !== "string" || !InvoiceSeries.trim()) {
            errors.push("InvoiceSeries is required");
        } else if (!INVOICE_SERIES_REGEX.test(InvoiceSeries.trim())) {
            errors.push("InvoiceSeries must start with a letter or 1-9 and contain only letters, numbers, /, or - up to 16 characters");
        }

        if (errors.length > 0) {
            return res.status(400).json({
                Status: "ERROR",
                Message: "Invalid request",
                Errors: errors,
            });
        }

        const gstin = typeof Gstin === "string" && Gstin.trim() ? Gstin.trim().toUpperCase() : undefined;
        const mobileNumber = MobileNumber.trim();
        const invoiceSeries = InvoiceSeries.trim();
        const query = { MobileNumber: mobileNumber };

        if (gstin) {
            query.Gstin = gstin;
        }

        const user = await User.findOneAndUpdate(
            query,
            { InvoiceSeries: invoiceSeries },
            { new: true, runValidators: true, projection: { _id: 0, __v: 0 } }
        ).lean();

        if (!user) {
            logger.warn("Invoice series update failed — user not found", { gstin, mobileNumber });

            return res.status(404).json({
                Status: "ERROR",
                Message: gstin
                    ? "User not found for the given GSTIN and Mobile Number"
                    : "User not found for the given Mobile Number",
            });
        }

        // Record the history entry
        await new InvoiceSeriesHistory({
            Gstin: gstin,
            MobileNumber: mobileNumber,
            InvoiceSeries: invoiceSeries,
        }).save();

        logger.info("Invoice series updated", { gstin, mobileNumber, invoiceSeries });

        return res.status(200).json({
            Status: "OK",
            Message: "Invoice series updated successfully",
            Data: {
                Gstin: gstin,
                MobileNumber: mobileNumber,
                InvoiceSeries: invoiceSeries,
            },
        });
    } catch (error) {
        if (sendDuplicateUserError(res, error)) return;
        next(error);
    }
}

async function getInvoiceSeriesHistory(req, res, next) {
    try {
        const { gstin, mobileNumber } = req.query || {};
        const errors = [];

        if (gstin !== undefined && gstin !== null && typeof gstin !== "string") {
            errors.push("gstin query parameter must be a string if provided");
        } else if (typeof gstin === "string" && gstin.trim() && !GSTIN_REGEX.test(gstin.trim().toUpperCase())) {
            errors.push("gstin must be a valid GSTIN");
        }

        if (!mobileNumber || typeof mobileNumber !== "string" || !mobileNumber.trim()) {
            errors.push("mobileNumber query parameter is required");
        } else if (!MOBILE_NUMBER_REGEX.test(mobileNumber.trim())) {
            errors.push("mobileNumber must be a valid 12 digit Indian mobile number with country code");
        }

        if (errors.length > 0) {
            return res.status(400).json({
                Status: "ERROR",
                Message: "Invalid request",
                Errors: errors,
            });
        }

        const cleanGstin = typeof gstin === "string" && gstin.trim() ? gstin.trim().toUpperCase() : undefined;
        const cleanMobile = mobileNumber.trim();
        const query = { MobileNumber: cleanMobile };

        if (cleanGstin) {
            query.Gstin = cleanGstin;
        }

        // Verify user exists
        const user = await User.findOne(query, { _id: 0, id: 1 }).lean();

        if (!user) {
            logger.warn("Invoice series history lookup — user not found", {
                gstin: cleanGstin,
                mobileNumber: cleanMobile,
            });

            return res.status(404).json({
                Status: "ERROR",
                Message: cleanGstin
                    ? "User not found for the given GSTIN and Mobile Number"
                    : "User not found for the given Mobile Number",
            });
        }

        const history = await InvoiceSeriesHistory.find(
            query,
            { _id: 0, __v: 0, Gstin: 0, MobileNumber: 0 }
        )
            .sort({ createdAt: -1 })
            .lean();

        logger.info("Invoice series history fetched", {
            gstin: cleanGstin,
            mobileNumber: cleanMobile,
            count: history.length,
        });

        return res.status(200).json({
            Status: "OK",
            Message: "Invoice series history fetched successfully",
            Data: history,
        });
    } catch (error) {
        next(error);
    }
}

module.exports = { updateInvoiceSeries, getInvoiceSeriesHistory };
