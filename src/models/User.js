const mongoose = require("mongoose");
const { requiredUserIndexes } = require("../config/userIndexes");

const bankDetailsSchema = new mongoose.Schema(
    {
        BankName: { type: String, required: true, trim: true },
        AccountNumber: { type: String, required: true, trim: true },
        IFSCCode: { type: String, required: true, trim: true },
        UPIID: { type: String, required: false, trim: true },
    },
    { _id: false }
);

const userSchema = new mongoose.Schema(
    {
        id: { type: String, required: true, unique: true },
        Gstin: {
            type: String, minLength: 15, maxLength: 15, match: /^[0-9]{2}[0-9A-Z]{13}$/,
            unique: true,
            sparse: true,
            trim: true,
            uppercase: true
        },
        MobileNumber: {
            type: String,
            required: true,
            unique: true,
            sparse: true,
            trim: true,
            match: /^91[6-9][0-9]{9}$/,
        },
        UserName: { type: String, trim: true },
        Password: { type: String },
        SellerPanNo: { type: String, trim: true },
        SellerTradeName: { type: String, trim: true },
        SellerAddress: { type: String, trim: true },
        LogoS3Url: { type: String, trim: true },
        InvoiceSeries: { type: String, trim: true, match: /^[a-zA-Z1-9][a-zA-Z0-9/-]{0,15}$/ },
        BankDetails: { type: bankDetailsSchema, required: true },
    },
    {
        timestamps: { createdAt: "createdAt", updatedAt: false },
        collection: process.env.MONGODB_COLLECTION || "users",
        bufferCommands: false,
        autoIndex: false,
        autoCreate: false,
    }
);

const seriesIndex = requiredUserIndexes.find(index => index.key.InvoiceSeries);
userSchema.index(seriesIndex.key, seriesIndex.options);

const User = mongoose.model("User", userSchema);

module.exports = User;
