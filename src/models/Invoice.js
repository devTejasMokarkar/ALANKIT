const mongoose = require("mongoose");

const invoiceSchema = new mongoose.Schema(
    {
        InvoiceId: { type: String, required: true, unique: true },
        UserId: { type: String, required: true, trim: true },
        MobileNumber: {
            type: String,
            required: true,
            trim: true,
            match: /^91[6-9][0-9]{9}$/,
            index: true,
        },
        Gstin: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            match: /^[0-9]{2}[0-9A-Z]{13}$/,
            index: true,
        },
        Irn: { type: String, required: true, trim: true },
        AckNo: { type: String, required: true, trim: true },
        AckDt: { type: String, trim: true },
        InvoiceNo: { type: String, trim: true },
        InvoiceDate: { type: String, trim: true },
        TotalAmount: { type: Number, default: 0 },
        FileName: { type: String, required: true, trim: true },
        CloudinaryPublicId: { type: String, trim: true },
        RelativeUrl: { type: String, required: true, trim: true },
        InvoiceData: { type: mongoose.Schema.Types.Mixed },
    },
    {
        timestamps: { createdAt: "CreatedAt", updatedAt: false },
        collection: process.env.MONGODB_INVOICE_COLLECTION || "invoices",
    }
);

invoiceSchema.index({ MobileNumber: 1, Gstin: 1, CreatedAt: -1 });

const Invoice = mongoose.model("Invoice", invoiceSchema);

module.exports = Invoice;
