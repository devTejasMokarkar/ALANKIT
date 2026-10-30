const mongoose = require("mongoose");

const taxInvoiceSchema = new mongoose.Schema(
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
            required: false,
            trim: true,
            uppercase: true,
            index: true,
            sparse: true,
            validate: {
                validator: function (value) {
                    if (!value || value === "NA") {
                        return true;
                    }

                    return /^[0-9]{2}[0-9A-Z]{13}$/.test(value);
                },
                message: "Gstin must be a valid GSTIN or NA",
            },
        },
        InvoiceNo: { type: String, trim: true },
        InvoiceDate: { type: String, trim: true },
        TotalAmount: { type: Number, default: 0 },
        FileName: { type: String, required: true, trim: true },
        RelativeUrl: { type: String, required: true, trim: true },
        InvoiceData: { type: mongoose.Schema.Types.Mixed },
    },
    {
        timestamps: { createdAt: "CreatedAt", updatedAt: false },
        collection: process.env.MONGODB_TAX_INVOICE_COLLECTION || "tax_invoices",
    }
);

taxInvoiceSchema.index({ MobileNumber: 1, Gstin: 1, CreatedAt: -1 });

const TaxInvoice = mongoose.model("TaxInvoice", taxInvoiceSchema);

module.exports = TaxInvoice;
