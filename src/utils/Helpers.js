/**
 * Returns true if the value is a non-empty, non-whitespace string.
 * @param {*} value
 * @returns {boolean}
 */
function hasText(value) {
    return typeof value === "string" && value.trim().length > 0;
}

module.exports = { hasText };