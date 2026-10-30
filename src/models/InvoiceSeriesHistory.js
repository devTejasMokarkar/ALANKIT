const mongoose = require("mongoose");

const invoiceSeriesHistorySchema = new mongoose.Schema(
    {
        Gstin: {
            type: String,
            trim: true,
            uppercase: true,
            validate: {
                validator(value) {
                    return !value || /^[0-9]{2}[0-9A-Z]{13}$/.test(value);
                },
                message: "Gstin must be a valid GSTIN",
            },
        },
        MobileNumber: {
            type: String,
            required: true,
            trim: true,
            match: /^91[6-9][0-9]{9}$/,
        },
        InvoiceSeries: {
            type: String,
            required: true,
            trim: true,
            match: /^[a-zA-Z1-9][a-zA-Z0-9/-]{0,15}$/,
        },
    },
    {
        timestamps: { createdAt: "createdAt", updatedAt: false },
        collection: "invoice_series_history",
    }
);

invoiceSeriesHistorySchema.index({ Gstin: 1, MobileNumber: 1 });

const InvoiceSeriesHistory = mongoose.model("InvoiceSeriesHistory", invoiceSeriesHistorySchema);

module.exports = InvoiceSeriesHistory;
