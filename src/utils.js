// ============ Utility ============

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Escape a value for use inside a single-quoted JS string within a
// double-quoted inline handler attribute, e.g. onclick="fn('VALUE')".
// New markup should not need it: use act() (src/actions.js) instead.
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

// Milliseconds for a date value (ISO string, number or Date), or null when it
// is missing or not a real date (L5). Callers decide what "no date" means.
function dateMs(value) {
    if (value === null || value === undefined || value === '') return null;
    var ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

// Which page numbers a pager shows (L6): the first 3, the last 3, and 2 either
// side of the current page, with null for one "…" per gap. A gap of a single
// page shows that page instead, since "…" would take the same room.
function paginationPages(page, totalPages) {
    function shown(p) {
        return p <= 3 || p > totalPages - 3 || (p >= page - 2 && p <= page + 2);
    }
    var out = [];
    for (var p = 1; p <= totalPages; p++) {
        if (shown(p) || (shown(p - 1) && shown(p + 1))) out.push(p);
        else if (out[out.length - 1] !== null) out.push(null);
    }
    return out;
}

// The pager's HTML. `goFn` names the global function that loads a page
// (e.g. 'goPage'); it is only ever one of the app's own names.
function renderPagination(page, totalPages, goFn) {
    if (totalPages <= 1) return '';
    var html = '<div class="pagination">';
    if (page > 1) html += '<span class="page-link"' + act('click', goFn, [page - 1]) + '>&laquo; Prev</span>';
    paginationPages(page, totalPages).forEach(function (p) {
        if (p === null) html += '<span class="page-dots">...</span>';
        else if (p === page) html += '<span class="page-link active">' + p + '</span>';
        else html += '<span class="page-link"' + act('click', goFn, [p]) + '>' + p + '</span>';
    });
    if (page < totalPages) html += '<span class="page-link"' + act('click', goFn, [page + 1]) + '>Next &raquo;</span>';
    return html + '</div>';
}
