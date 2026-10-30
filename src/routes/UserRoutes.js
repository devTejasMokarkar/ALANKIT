const { Router } = require("express");
const { validateUserDetails } = require("../middleware/ValidateUserDetails");
const { postUserDetails, getUserDetailsByGstin, getUserDetailsByMobileNumber } = require("../controllers/UserController");
const { generateInvoice, getInvoicesByMobileAndGstin, downloadInvoicesZip, downloadAllInvoicesZip } = require("../controllers/InvoiceController");
const { updateInvoiceSeries, getInvoiceSeriesHistory } = require("../controllers/InvoiceSeriesController");

const { registrationGate } = require("../middleware/RegistrationGate");
const router = Router();

router.post("/user-details", validateUserDetails, registrationGate, postUserDetails);
router.get("/user-details/mobile/:mobileNumber", getUserDetailsByMobileNumber);
router.post("/user-details/invoice/generate", generateInvoice);
router.get("/user-details/invoices", getInvoicesByMobileAndGstin);
router.get("/user-details/invoices/download-zip", downloadInvoicesZip);
router.get("/user-details/invoices/download-all-zip", downloadAllInvoicesZip);
router.put("/user-details/invoice-series", updateInvoiceSeries);
router.get("/user-details/invoice-series/history", getInvoiceSeriesHistory);
// router.get("/user-details/invoices/:invoiceId", getInvoiceById);
router.get("/user-details/:gstin", getUserDetailsByGstin);

module.exports = router;
