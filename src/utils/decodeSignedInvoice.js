class InvoiceDecodeError extends Error {
    constructor(message) {
        super(message);
        this.name = "InvoiceDecodeError";
        this.statusCode = 400;
    }
}

function base64UrlDecode(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");

    return Buffer.from(padded, "base64").toString("utf8");
}

function parseJson(value, label) {
    try {
        return JSON.parse(value);
    } catch (error) {
        throw new InvoiceDecodeError(`Invalid SignedInvoice ${label}`);
    }
}

function unwrapInvoicePayload(payload) {
    const candidates = [
        payload?.data,
        payload?.Data,
        payload?.invoice,
        payload?.Invoice,
        payload?.payload,
        payload,
    ];

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        if (typeof candidate === "string") {
            const parsed = parseJson(candidate, "invoice payload");

            if (parsed?.SellerDtls || parsed?.BuyerDtls || parsed?.DocDtls || parsed?.ItemList) {
                return parsed;
            }
        }

        if (typeof candidate === "object" && (candidate.SellerDtls || candidate.BuyerDtls || candidate.DocDtls || candidate.ItemList)) {
            return candidate;
        }
    }

    throw new InvoiceDecodeError("SignedInvoice does not contain GST invoice data");
}

function decodeSignedInvoice(signedInvoice) {
    if (!signedInvoice || typeof signedInvoice !== "string") {
        throw new InvoiceDecodeError("SignedInvoice is required");
    }

    const tokenParts = signedInvoice.split(".");

    if (tokenParts.length < 2 || !tokenParts[1]) {
        throw new InvoiceDecodeError("Invalid SignedInvoice JWT format");
    }

    const payloadText = base64UrlDecode(tokenParts[1]);
    const payload = parseJson(payloadText, "JWT payload");

    return unwrapInvoicePayload(payload);
}

module.exports = { decodeSignedInvoice, InvoiceDecodeError };
