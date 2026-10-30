const { Router } = require("express");
const { generateInvoice } = require("../controllers/InvoiceController");

const router = Router();

router.post("/api/invoice/generate", generateInvoice);

module.exports = router;
