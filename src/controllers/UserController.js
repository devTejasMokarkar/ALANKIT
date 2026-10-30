const crypto = require("crypto");
const { timeStage } = require("../utils/RequestTiming");
const User = require("../models/User");
const logger = require("../utils/Logger");
const { sendDuplicateUserError } = require("../utils/DuplicateUserError");

async function postUserDetails(req, res, next) {
    try {
        const payload = req.validatedUserDetails;
        const userId = crypto.randomUUID();
        const userDetails = {
            id: userId,
            MobileNumber: payload.MobileNumber,
            BankDetails: {
                BankName: payload.BankDetails.BankName,
                AccountNumber: payload.BankDetails.AccountNumber,
                IFSCCode: payload.BankDetails.IFSCCode,
                UPIID: payload.BankDetails.UPIID,
            },
        };

        if (payload.Gstin) {
            userDetails.Gstin = payload.Gstin;
        }

        if (payload.SellerPanNo) {
            userDetails.SellerPanNo = payload.SellerPanNo;
        }

        if (payload.SellerTradeName) {
            userDetails.SellerTradeName = payload.SellerTradeName;
        }

        if (payload.SellerAddress) {
            userDetails.SellerAddress = payload.SellerAddress;
        }

        if (payload.UserName) {
            userDetails.UserName = payload.UserName;
        }

        if (payload.Password) {
            userDetails.Password = payload.Password;
        }

        if (payload.InvoiceSeries) {
            userDetails.InvoiceSeries = payload.InvoiceSeries;
        }

        // Keep the source URL. Registration performs no logo fetch or file write.
        if (payload.LogoS3Url) userDetails.LogoS3Url = payload.LogoS3Url;

        if (res.destroyed) return;
        const user = new User(userDetails);
        res.locals.registrationWriteStarted = true;

        await timeStage(req, res, "mongo_insert", () => user.save());
        logger.info("User details created", {
            userId,
            gstin: payload.Gstin,
            mobileNumber: payload.MobileNumber,
            userName: payload.UserName,
        });

        if (res.destroyed) return;
        return res.status(201).json({
            Status: "OK",
            Message: "User Entered Successfully",
            UserId: userId,
        });
    } catch (error) {
        if (sendDuplicateUserError(res, error)) return;

        next(error);
    } finally {
        res.locals.releaseRegistration?.();
    }
}

async function getUserDetailsByGstin(req, res, next) {
    try {
        const gstin = req.params.gstin.toUpperCase();

        // if (!GSTIN_REGEX.test(gstin)) {
        //     logger.warn("Invalid GSTIN lookup rejected", { gstin });

        //     return res.status(400).json({
        //         Status: "ERROR",
        //         Message: "Invalid GSTIN",
        //     });
        // }

        const user = await User.findOne({ Gstin: gstin }, { _id: 0, __v: 0 }).lean();

        if (!user) {
            logger.warn("User details lookup missed", { gstin });

            return res.status(404).json({
                Status: "ERROR",
                Message: "User details not found",
            });
        }

        logger.info("User details fetched", { gstin, userId: user.id });

        return res.status(200).json({
            Status: "OK",
            Message: "User details fetched successfully",
            Data: user,
        });
    } catch (error) {
        next(error);
    }
}

async function getUserDetailsByMobileNumber(req, res, next) {
    try {
        const mobileNumber = req.params.mobileNumber;

        if (!/^91[6-9][0-9]{9}$/.test(mobileNumber)) {
            logger.warn("Invalid mobile number lookup rejected", { mobileNumber });

            return res.status(400).json({
                Status: "ERROR",
                Message: "Invalid mobile number",
            });
        }

        const user = await User.findOne({ MobileNumber: mobileNumber }, { _id: 0, __v: 0 }).lean();

        if (!user) {
            logger.warn("User details mobile lookup missed", { mobileNumber });

            return res.status(404).json({
                Status: "ERROR",
                Message: "User details not found",
            });
        }

        logger.info("User details fetched by mobile number", { mobileNumber, userId: user.id });

        return res.status(200).json({
            Status: "OK",
            Message: "User details fetched successfully",
            Data: user,
        });
    } catch (error) {
        next(error);
    }
}

module.exports = { postUserDetails, getUserDetailsByGstin, getUserDetailsByMobileNumber };
