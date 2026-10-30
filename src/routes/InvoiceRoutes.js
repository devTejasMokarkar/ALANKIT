const { invoiceGate } = require("../middleware/InvoiceGate");
const { Router } = require("express");
const { generateInvoice } = require("../controllers/InvoiceController");

const router = Router();

router.post("/api/invoice/generate", invoiceGate, generateInvoice);

module.exports = router;
