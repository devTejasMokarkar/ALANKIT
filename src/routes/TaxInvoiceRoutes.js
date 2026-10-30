const { Router } = require("express");
const { generateTaxInvoice, downloadTaxInvoicesZip } = require("../controllers/TaxInvoiceController");

const router = Router();

router.post("/user-details/tax-invoice/generate", generateTaxInvoice);
router.get("/user-details/tax-invoices/download-zip", downloadTaxInvoicesZip);

module.exports = router;
