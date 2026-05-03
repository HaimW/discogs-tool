function doSearch() {
    var val = document.getElementById('search-input').value.trim();
    _filters.q = val;
    _filters.page = 1;
    renderCollection();
}

function clearSearch() {
    _filters.q = '';
    _filters.page = 1;
    renderCollection();
}

function setFilter(key, value) {
    _filters[key] = value;
    _filters.page = 1;
    renderCollection();
}

function setSort(s) {
    _filters.sort = s;
    _filters.page = 1;
    renderCollection();
}

function goPage(p) {
    _filters.page = p;
    renderCollection();
    window.scrollTo(0, 0);
}

function clearAllFilters() {
    _filters.q = '';
    _filters.genre = '';
    _filters.folder = '';
    _filters.country = '';
    _filters.page = 1;
    renderCollection();
}

// ============ Setlists ============
