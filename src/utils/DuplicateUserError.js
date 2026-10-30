function sendDuplicateUserError(res, error) {
    if (error.code !== 11000) return false;
    const fields = Object.keys(error.keyPattern || error.keyValue || {})
        .filter(field => ["Gstin", "MobileNumber", "InvoiceSeries"].includes(field));
    res.status(409).json({
        Status: "ERROR",
        Code: "DUPLICATE_USER_DETAILS",
        Message: fields.length ? `User details already exist for ${fields.join(", ")}` : "User details already exist",
        Fields: fields,
    });
    return true;
}

module.exports = { sendDuplicateUserError };
