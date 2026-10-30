const { parentPort } = require("worker_threads");
const { generateInvoicePdf } = require("../utils/pdfGenerator");

parentPort.on("message", async ({ invoiceData, irnResponse, logoS3Url }) => {
    try {
        const pdf = await generateInvoicePdf({ invoiceData, irnResponse, logoS3Url });
        // Own the transferred allocation; PDFKit buffers may share Node's buffer pool.
        const bytes = Uint8Array.from(pdf);
        parentPort.postMessage({ bytes }, [bytes.buffer]);
    } catch (error) {
        parentPort.postMessage({ error: {
            message: error.statusCode === 400 ? error.message : "PDF generation failed",
            statusCode: error.statusCode === 400 ? 400 : 500,
        } });
    }
});

parentPort.postMessage({ ready: true });
