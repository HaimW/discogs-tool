// ============ Utility ============

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Escape a value for use inside a single-quoted JS string within a
// double-quoted inline handler attribute, e.g. onclick="fn('VALUE')".
// Two layers: JS string escaping first, then HTML entity escaping —
// the browser decodes entities in attribute values before the JS parser
// runs, so a literal " in the data can never terminate the attribute.
function escJs(str) {
    if (!str) return '';
    var js = String(str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    return escHtml(js);
}
