const { hasText } = require("../utils/Helpers");

const GSTIN_REGEX = /^[0-9]{2}[0-9A-Z]{13}$/;
const MOBILE_NUMBER_REGEX = /^91[6-9][0-9]{9}$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NUMBER_REGEX = /^[0-9]{9,18}$/;
const UPI_ID_REGEX = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;
const INVOICE_SERIES_REGEX = /^[a-zA-Z1-9][a-zA-Z0-9/-]{0,15}$/;

function cleanText(value) {
    return typeof value === "string" ? value.trim() : value;
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch (error) {
        return false;
    }
}

function addRequiredStringError(errors, field, value) {
    if (typeof value !== "string") {
        errors.push(`${field} is required and must be a string`);
        return true;
    }

    if (!hasText(value)) {
        errors.push(`${field} cannot be empty`);
        return true;
    }

    return false;
}

function validateUserDetails(req, res, next) {
    const payload = req.body || {};
    const bankDetails = payload.BankDetails || {};
    const errors = [];

    if (!bankDetails || typeof bankDetails !== "object" || Array.isArray(bankDetails)) {
        errors.push("Bank Details is required and must be an object");
    }

    const requiredFields = [
        ["MobileNumber", payload.MobileNumber],
        ["BankDetails.BankName", bankDetails.BankName],
        ["BankDetails.AccountNumber", bankDetails.AccountNumber],
        ["BankDetails.IFSCCode", bankDetails.IFSCCode]
    ];
    
    // ["BankDetails.UPIID", bankDetails.UPIID],
    
    requiredFields.forEach(([field, value]) => addRequiredStringError(errors, field, value));

    if (errors.length > 0) {
        return res.status(400).json({
            Status: "ERROR",
            Message: "Invalid user details",
            Errors: errors,
        });
    }

    const userDetails = {
        MobileNumber: cleanText(payload.MobileNumber),
        LogoS3Url: cleanText(payload.LogoS3Url),
        InvoiceSeries: cleanText(payload.InvoiceSeries),
        BankDetails: {
            BankName: cleanText(bankDetails.BankName),
            AccountNumber: cleanText(bankDetails.AccountNumber),
            IFSCCode: cleanText(bankDetails.IFSCCode).toUpperCase(),
            UPIID: cleanText(bankDetails.UPIID),
        },
    };

    if (payload.Gstin !== undefined) {
        if (typeof payload.Gstin !== "string") {
            errors.push("Gstin must be a string");
        } else {
            const gstin = cleanText(payload.Gstin);

            if (hasText(gstin)) {
                userDetails.Gstin = gstin.toUpperCase();

                if (!GSTIN_REGEX.test(userDetails.Gstin)) {
                    errors.push("Gstin must be a valid GSTIN");
                }
            }
        }
    }

    if (payload.UserName !== undefined) {
        if (typeof payload.UserName !== "string") {
            errors.push("UserName must be a string");
        } else {
            const userName = cleanText(payload.UserName);

            if (hasText(userName)) {
                userDetails.UserName = userName;

                if (userDetails.UserName.length < 2) {
                    errors.push("UserName must be at least 2 characters long");
                }
            }
        }
    }

    if (payload.SellerPanNo !== undefined) {
        if (typeof payload.SellerPanNo !== "string") {
            errors.push("SellerPanNo must be a string");
        } else {
            const sellerPanNo = cleanText(payload.SellerPanNo);
            if (hasText(sellerPanNo)) {
                userDetails.SellerPanNo = sellerPanNo;
            }
        }
    }

    if (payload.SellerTradeName !== undefined) {
        if (typeof payload.SellerTradeName !== "string") {
            errors.push("SellerTradeName must be a string");
        } else {
            const sellerTradeName = cleanText(payload.SellerTradeName);
            if (hasText(sellerTradeName)) {
                userDetails.SellerTradeName = sellerTradeName;
            }
        }
    }

    if (payload.SellerAddress !== undefined) {
        if (typeof payload.SellerAddress !== "string") {
            errors.push("SellerAddress must be a string");
        } else {
            const sellerAddress = cleanText(payload.SellerAddress);
            if (hasText(sellerAddress)) {
                userDetails.SellerAddress = sellerAddress;
            }
        }
    }

    if (payload.Password !== undefined) {
        if (typeof payload.Password !== "string") {
            errors.push("Password must be a string");
        } else if (hasText(payload.Password)) {
            userDetails.Password = payload.Password;

            if (userDetails.Password.length < 6) {
                errors.push("Password must be at least 6 characters long");
            }
        }
    }

    if (!MOBILE_NUMBER_REGEX.test(userDetails.MobileNumber)) {
        errors.push("MobileNumber must be a valid 12 digit Indian mobile number with country code, e.g. 919012334556");
    }

    if (userDetails.LogoS3Url !== undefined) {
        if (typeof userDetails.LogoS3Url !== "string") {
            errors.push("LogoS3Url must be a string");
        } else if (!hasText(userDetails.LogoS3Url)) {
            delete userDetails.LogoS3Url;
        } else if (!isHttpUrl(userDetails.LogoS3Url)) {
            errors.push("LogoS3Url must be a valid HTTP or HTTPS URL");
        }
    }

    // Validate optional InvoiceSeries
    if (userDetails.InvoiceSeries !== undefined) {
        if (typeof userDetails.InvoiceSeries !== "string") {
            errors.push("InvoiceSeries must be a string");
        } else if (!hasText(userDetails.InvoiceSeries)) {
            delete userDetails.InvoiceSeries;
        } else if (!INVOICE_SERIES_REGEX.test(userDetails.InvoiceSeries)) {
            errors.push("InvoiceSeries must start with a letter or 1-9 and contain only letters, numbers, /, or - up to 16 characters");
        }
    }

    if (!ACCOUNT_NUMBER_REGEX.test(userDetails["BankDetails"].AccountNumber)) {
        errors.push("Bank Details.AccountNumber must contain 9 to 18 digits only");
    }

    if (!IFSC_REGEX.test(userDetails["BankDetails"]["IFSCCode"])) {
        errors.push("Bank Details.IFSC Code must be a valid IFSC code");
    }
    
    if(userDetails["BankDetails"]["UPIID"]){
        if (!UPI_ID_REGEX.test(userDetails["BankDetails"]["UPIID"])) {
            errors.push("Bank Details.UPI ID must be a valid UPI ID");
        }
    }

    if (errors.length > 0) {
        return res.status(400).json({
            Status: "ERROR",
            Message: "Invalid user details",
            Errors: errors,
        });
    }

    req.validatedUserDetails = userDetails;
    next();
}

module.exports = { validateUserDetails };
