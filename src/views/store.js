// ============ Store View ============

var _storeFilters = { q: '', status: '', batchId: null };
var _storeItemsCache = [];

// ---- Main render ----

function renderStore() {
    Promise.all([
        dbGetAll('releases'),
        dbGetAll('store_items'),
        dbGetAll('store_batches')
    ]).then(function (res) {
        var releases = res[0];
        var storeItems = res[1];
        var batches = res[2];

        _storeItemsCache = storeItems;

        var releaseMap = {};
        releases.forEach(function (r) { releaseMap[r.id] = r; });

        var batchMap = {};
        batches.forEach(function (b) { batchMap[b.id] = b; });

        var enriched = storeItems.map(function (item) {
            var rel = releaseMap[item.id] || {};
            return {
                id: item.id,
                serial: item.serial || '',
                manual_serial: item.manual_serial || false,
                store_status: item.store_status || 'active',
                sold_date: item.sold_date || null,
                sold_price: item.sold_price || null,
                batch_id: item.batch_id || null,
                median_price: item.median_price || null,
                median_price_currency: item.median_price_currency || null,
                median_price_updated_at: item.median_price_updated_at || null,
                added_at: item.added_at || '',
                artist: rel.artist || 'Unknown',
                title: rel.title || 'Unknown',
                year: rel.year || '',
                country: rel.country || '',
                styles: rel.styles || '',
                format: rel.format || '',
                cover_url: rel.cover_url || null
            };
        });

        // Apply filters
        var filtered = enriched;
        var q = _storeFilters.q.toLowerCase();
        if (q) {
            filtered = filtered.filter(function (r) {
                return r.serial.toLowerCase().indexOf(q) !== -1 ||
                    r.artist.toLowerCase().indexOf(q) !== -1 ||
                    r.title.toLowerCase().indexOf(q) !== -1;
            });
        }
        if (_storeFilters.status) {
            filtered = filtered.filter(function (r) { return r.store_status === _storeFilters.status; });
        }
        if (_storeFilters.batchId !== null) {
            filtered = filtered.filter(function (r) { return r.batch_id === _storeFilters.batchId; });
        }

        filtered.sort(function (a, b) { return a.serial.localeCompare(b.serial); });

        var hasSerials = storeItems.length > 0;
        var serializeBtnLabel = hasSerials ? 'Serialize New Records' : 'Serialize Collection';

        var html = '';

        // ---- Header ----
        html += '<div class="store-header">';
        html += '<div class="store-title-row">';
        html += '<div class="collection-stats"><h1>Store</h1>';
        html += '<span class="stat-count">' + storeItems.length + ' serialized · ' +
            storeItems.filter(function (i) { return i.store_status === 'sold'; }).length + ' sold</span>';
        html += '</div>';
        html += '<div class="store-header-actions">';
        html += '<button class="btn btn-primary" onclick="storeSerializePreview()">' + serializeBtnLabel + '</button>';
        html += '<button class="btn" onclick="storePrintAll()">Print All</button>';
        html += '</div>';
        html += '</div>';

        // Search bar
        html += '<div class="search-bar" style="margin-top:12px;">';
        html += '<input type="text" class="search-input" id="store-search-input" placeholder="Search serial, artist or title..." ' +
            'value="' + escHtml(_storeFilters.q) + '" ' +
            'oninput="storeSetFilter(\'q\',this.value)">';
        if (_storeFilters.q) {
            html += '<button class="btn btn-clear" onclick="storeSetFilter(\'q\',\'\')">Clear</button>';
        }
        html += '</div>';
        html += '</div>';

        // ---- Status filter pills ----
        html += '<div class="genre-pills" style="margin-top:16px;">';
        html += '<span class="filter-label">Status:</span>';
        html += '<span class="genre-pill' + (!_storeFilters.status ? ' active' : '') + '" onclick="storeSetFilter(\'status\',\'\')">All</span>';
        html += '<span class="genre-pill' + (_storeFilters.status === 'active' ? ' active' : '') + '" onclick="storeSetFilter(\'status\',\'active\')">Active</span>';
        html += '<span class="genre-pill' + (_storeFilters.status === 'sold' ? ' active' : '') + '" onclick="storeSetFilter(\'status\',\'sold\')">Sold</span>';
        html += '</div>';

        // ---- Batches section ----
        html += '<div class="store-batches-section">';
        html += '<div class="store-section-hd">';
        html += '<span class="store-section-title">Batches</span>';
        html += '<button class="btn btn-sm" onclick="storeNewBatchPrompt()">+ New Batch</button>';
        html += '</div>';

        if (batches.length === 0) {
            html += '<p class="store-batches-empty">No batches yet. Create a batch to group records for a selling event.</p>';
        } else {
            html += '<div class="store-batch-list">';
            if (_storeFilters.batchId !== null) {
                html += '<span class="batch-tag batch-tag-active" onclick="storeSetFilter(\'batchId\',null)">All Inventory ×</span>';
            } else {
                html += '<span class="batch-tag" onclick="storeSetFilter(\'batchId\',null)">All Inventory</span>';
            }
            batches.forEach(function (b) {
                var count = storeItems.filter(function (i) { return i.batch_id === b.id; }).length;
                var isActive = _storeFilters.batchId === b.id;
                html += '<span class="batch-tag' + (isActive ? ' batch-tag-active' : '') + '" onclick="storeSetFilter(\'batchId\',' + b.id + ')">' +
                    escHtml(b.name) + ' <span class="batch-count">' + count + '</span></span>';
                html += '<button class="btn btn-sm" onclick="storePrintBatch(' + b.id + ',\'' + escJs(b.name) + '\')" title="Print batch">Print</button>';
                html += '<button class="btn btn-sm btn-danger" onclick="storeDeleteBatchConfirm(' + b.id + ',\'' + escJs(b.name) + '\')" title="Delete batch">&times;</button>';
            });
            html += '</div>';
        }
        html += '</div>';

        // ---- Inventory table ----
        html += '<div class="store-inventory">';

        if (storeItems.length === 0) {
            html += '<div class="empty-state">' +
                '<div class="vinyl-icon-huge">&#9898;</div>' +
                '<p class="empty-title">No records serialized yet</p>' +
                '<p class="empty-subtitle">Click "Serialize Collection" to assign permanent serial numbers to your records.</p>' +
                '<button class="btn btn-primary btn-large" onclick="storeSerializePreview()">Serialize Collection</button>' +
                '</div>';
        } else if (filtered.length === 0) {
            html += '<div class="empty-state"><p class="empty-title">No records match your filters</p>' +
                '<button class="btn btn-primary" onclick="storeClearFilters()">Clear Filters</button></div>';
        } else {
            html += '<div class="store-table-wrap"><table class="store-table">';
            html += '<thead><tr>' +
                '<th>Serial</th><th>Artist</th><th>Title</th><th>Year</th>' +
                '<th>Country</th><th>Style</th><th>Format</th>' +
                '<th>Median $</th><th>Status</th><th>Batch</th><th>Actions</th>' +
                '</tr></thead><tbody>';

            filtered.forEach(function (r) {
                var batchName = (r.batch_id && batchMap[r.batch_id]) ? batchMap[r.batch_id].name : '';
                var statusHtml = r.store_status === 'sold'
                    ? '<span class="badge-sold">SOLD</span>' +
                      (r.sold_date ? '<span class="sold-detail">' + r.sold_date.slice(0, 10) + '</span>' : '') +
                      (r.sold_price ? '<span class="sold-detail">' + escHtml(r.sold_price) + '</span>' : '')
                    : '<span class="badge-active">Active</span>';

                var priceHtml = r.median_price
                    ? escHtml((r.median_price_currency || '') + ' ' + Number(r.median_price).toFixed(2))
                    : '<span class="text-dim">—</span>';

                html += '<tr class="store-row' + (r.store_status === 'sold' ? ' store-row-sold' : '') + '">';

                // Serial cell with inline edit
                html += '<td id="serial-cell-' + r.id + '" class="serial-cell">' +
                    '<span class="serial-number' + (r.manual_serial ? ' serial-manual' : '') + '">' + escHtml(r.serial) + '</span>' +
                    '<button class="btn-icon" title="Edit serial" onclick="storeBeginEditSerial(' + r.id + ',\'' + escJs(r.serial) + '\')">✎</button>' +
                    '</td>';

                html += '<td class="td-artist">' + escHtml(r.artist) + '</td>';
                html += '<td class="td-title">' + escHtml(r.title) + '</td>';
                html += '<td>' + escHtml(String(r.year || '—')) + '</td>';
                html += '<td>' + escHtml(r.country || '—') + '</td>';
                html += '<td class="td-style">' + escHtml(r.styles || '—') + '</td>';
                html += '<td>' + escHtml(r.format || '—') + '</td>';
                html += '<td id="median-cell-' + r.id + '" class="td-price">' + priceHtml + '</td>';
                html += '<td>' + statusHtml + '</td>';

                // Batch cell
                html += '<td class="td-batch">';
                if (batchName) {
                    html += '<span class="batch-tag-sm">' + escHtml(batchName) + '</span> ';
                }
                html += '<button class="btn-icon" title="Assign batch" onclick="storeAssignBatchModal(' + r.id + ',' + (r.batch_id || 'null') + ')">+</button>';
                html += '</td>';

                // Actions
                html += '<td class="td-actions">';
                html += '<a class="btn btn-sm" href="https://www.discogs.com/release/' + r.id + '" target="_blank" rel="noopener" title="Open on Discogs">↗</a>';
                html += '<button class="btn btn-sm" onclick="storeRefreshPrice(' + r.id + ')" title="Refresh median price">$ ↺</button>';
                if (r.store_status === 'active') {
                    html += '<button class="btn btn-sm btn-sold" onclick="storeMarkSoldModal(' + r.id + ')" title="Mark as sold">Sold</button>';
                }
                html += '<button class="btn btn-sm btn-danger" onclick="storeRemoveConfirm(' + r.id + ',\'' + escJs(r.serial) + '\',\'' + escJs(r.artist) + '\',\'' + escJs(r.title) + '\')" title="Remove from store and collection">&times;</button>';
                html += '</td>';

                html += '</tr>';
            });

            html += '</tbody></table></div>';
        }

        html += '</div>'; // .store-inventory

        document.getElementById('app').innerHTML = html;
    });
}

// ---- Filter helpers ----

function storeSetFilter(key, value) {
    _storeFilters[key] = value;
    renderStore();
}

function storeClearFilters() {
    _storeFilters = { q: '', status: '', batchId: null };
    renderStore();
}

// ---- Modal helpers ----

function _showModal(html) {
    var existing = document.getElementById('store-modal');
    if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.id = 'store-modal';
    overlay.className = 'store-modal-overlay';
    overlay.innerHTML = '<div class="store-modal">' + html + '</div>';
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) _closeModal();
    });
    document.body.appendChild(overlay);
}

function _closeModal() {
    var m = document.getElementById('store-modal');
    if (m) m.remove();
}

// ---- Serialize ----

function storeSerializePreview() {
    Promise.all([dbGetAll('releases'), dbGetAll('store_items')]).then(function (res) {
        var releases = res[0];
        var storeItems = res[1];
        var serializedIds = {};
        storeItems.forEach(function (s) { serializedIds[s.id] = true; });
        var toSerialize = releases.filter(function (r) { return !serializedIds[r.id]; });

        if (toSerialize.length === 0) {
            _showModal(
                '<h2 class="modal-title">Nothing to Serialize</h2>' +
                '<p class="modal-body">All records in your collection already have serial numbers.</p>' +
                '<div class="modal-actions"><button class="btn btn-primary" onclick="_closeModal()">OK</button></div>'
            );
            return;
        }

        // Group by prefix for preview
        var prefixCounts = {};
        toSerialize.forEach(function (r) {
            var prefix = getSerialPrefix(r.country);
            prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
        });
        var prefixList = Object.keys(prefixCounts).sort();

        var previewRows = prefixList.map(function (p) {
            var isXX = p === 'XX';
            return '<tr><td class="preview-code">' + escHtml(p) + '</td>' +
                '<td class="preview-count">' + prefixCounts[p] + ' records' + (isXX ? ' <span class="text-dim">(no country data)</span>' : '') + '</td></tr>';
        }).join('');

        var html = '<h2 class="modal-title">Serialize ' + toSerialize.length + ' Records?</h2>';
        html += '<p class="modal-body">Serial numbers will be assigned by country and sorted by release year. Once assigned they are permanent.</p>';
        html += '<table class="preview-table">' + previewRows + '</table>';
        html += '<div class="modal-actions">';
        html += '<button class="btn" onclick="_closeModal()">Cancel</button>';
        html += '<button class="btn btn-primary" onclick="storeRunSerialize()">Serialize</button>';
        html += '</div>';

        _showModal(html);
    });
}

async function storeRunSerialize() {
    _closeModal();
    showSyncBanner('Serializing collection...');
    var releases = await dbGetAll('releases');
    var storeItems = await dbGetAll('store_items');
    var serializedIds = {};
    storeItems.forEach(function (s) { serializedIds[s.id] = true; });
    var toSerialize = releases
        .filter(function (r) { return !serializedIds[r.id]; })
        .sort(function (a, b) {
            var ya = a.year || 9999;
            var yb = b.year || 9999;
            if (ya !== yb) return ya - yb;
            return (a.artist || '').localeCompare(b.artist || '');
        });

    await runSerialization(toSerialize);
    hideSyncBanner();
    renderStore();
}

// ---- Inline serial edit ----

function storeBeginEditSerial(releaseId, currentSerial) {
    var cell = document.getElementById('serial-cell-' + releaseId);
    if (!cell) return;
    cell.innerHTML =
        '<div class="serial-edit-wrap">' +
        '<input id="serial-input-' + releaseId + '" class="serial-edit-input" ' +
        'value="' + escHtml(currentSerial) + '" ' +
        'oninput="storeValidateSerial(' + releaseId + ')" ' +
        'onkeydown="if(event.key===\'Enter\')storeSaveSerial(' + releaseId + ',\'' + escJs(currentSerial) + '\');if(event.key===\'Escape\')storeCancelEditSerial(' + releaseId + ',\'' + escJs(currentSerial) + '\')">' +
        '<span id="serial-error-' + releaseId + '" class="serial-error"></span>' +
        '<div class="serial-edit-btns">' +
        '<button class="btn btn-sm btn-primary" id="serial-save-' + releaseId + '" onclick="storeSaveSerial(' + releaseId + ',\'' + escJs(currentSerial) + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="storeCancelEditSerial(' + releaseId + ',\'' + escJs(currentSerial) + '\')">Cancel</button>' +
        '</div></div>';
    var input = document.getElementById('serial-input-' + releaseId);
    input.focus();
    input.select();
}

function storeValidateSerial(releaseId) {
    var input = document.getElementById('serial-input-' + releaseId);
    var error = document.getElementById('serial-error-' + releaseId);
    var saveBtn = document.getElementById('serial-save-' + releaseId);
    if (!input || !error || !saveBtn) return;

    var val = input.value.trim().toUpperCase();
    if (!val) {
        error.textContent = 'Serial cannot be empty.';
        input.classList.add('invalid');
        saveBtn.disabled = true;
        return;
    }
    if (isSerialTaken(val, _storeItemsCache, releaseId)) {
        var owner = _storeItemsCache.find(function (i) {
            return (i.serial || '').toUpperCase().trim() === val && i.id !== releaseId;
        });
        error.textContent = val + ' is already used' + (owner ? ' by ID ' + owner.id : '') + '.';
        input.classList.add('invalid');
        saveBtn.disabled = true;
        return;
    }
    error.textContent = '';
    input.classList.remove('invalid');
    saveBtn.disabled = false;
}

async function storeSaveSerial(releaseId, originalSerial) {
    var input = document.getElementById('serial-input-' + releaseId);
    if (!input) return;
    var val = input.value.trim().toUpperCase();
    if (!val || isSerialTaken(val, _storeItemsCache, releaseId)) return;

    var item = await dbGet('store_items', releaseId);
    if (!item) return;
    item.serial = val;
    item.manual_serial = (val !== originalSerial.toUpperCase()) ? true : item.manual_serial;
    await dbPut('store_items', item);

    var cached = _storeItemsCache.find(function (i) { return i.id === releaseId; });
    if (cached) { cached.serial = val; cached.manual_serial = item.manual_serial; }

    renderStore();
}

function storeCancelEditSerial(releaseId, originalSerial) {
    var manualFlag = (_storeItemsCache.find(function (i) { return i.id === releaseId; }) || {}).manual_serial;
    var cell = document.getElementById('serial-cell-' + releaseId);
    if (!cell) return;
    cell.innerHTML =
        '<span class="serial-number' + (manualFlag ? ' serial-manual' : '') + '">' + escHtml(originalSerial) + '</span>' +
        '<button class="btn-icon" title="Edit serial" onclick="storeBeginEditSerial(' + releaseId + ',\'' + escJs(originalSerial) + '\')">✎</button>';
}

// ---- Median price refresh ----

async function storeRefreshPrice(releaseId) {
    var cell = document.getElementById('median-cell-' + releaseId);
    if (cell) cell.innerHTML = '<span class="text-dim">...</span>';
    try {
        var data = await discogsGetPublic('/marketplace/stats/' + releaseId);
        var price = data && data.median_price ? data.median_price.value : null;
        var currency = data && data.median_price ? data.median_price.currency : null;
        var item = await dbGet('store_items', releaseId);
        if (item) {
            item.median_price = price;
            item.median_price_currency = currency;
            item.median_price_updated_at = new Date().toISOString();
            await dbPut('store_items', item);
            var cached = _storeItemsCache.find(function (i) { return i.id === releaseId; });
            if (cached) { cached.median_price = price; cached.median_price_currency = currency; }
        }
        if (cell) {
            cell.innerHTML = price
                ? escHtml((currency || '') + ' ' + Number(price).toFixed(2))
                : '<span class="text-dim">—</span>';
        }
    } catch (e) {
        if (cell) cell.innerHTML = '<span class="text-dim">Error</span>';
    }
}

// ---- Mark as sold ----

function storeMarkSoldModal(releaseId) {
    var item = _storeItemsCache.find(function (i) { return i.id === releaseId; });
    if (!item) return;
    var today = new Date().toISOString().slice(0, 10);
    var html =
        '<h2 class="modal-title">Mark as Sold</h2>' +
        '<p class="modal-body"><strong>' + escHtml(item.serial) + '</strong></p>' +
        '<div class="modal-form">' +
        '<label class="form-label">Sold date</label>' +
        '<input id="sold-date-input" class="form-input" type="date" value="' + today + '">' +
        '<label class="form-label" style="margin-top:12px;">Price (optional)</label>' +
        '<input id="sold-price-input" class="form-input" type="text" placeholder="e.g. USD 25.00">' +
        '</div>' +
        '<div class="modal-actions">' +
        '<button class="btn" onclick="_closeModal()">Cancel</button>' +
        '<button class="btn btn-primary" onclick="storeConfirmSold(' + releaseId + ')">Mark as Sold</button>' +
        '</div>';
    _showModal(html);
}

async function storeConfirmSold(releaseId) {
    var dateInput = document.getElementById('sold-date-input');
    var priceInput = document.getElementById('sold-price-input');
    var soldDate = dateInput ? dateInput.value : new Date().toISOString().slice(0, 10);
    var soldPrice = priceInput ? priceInput.value.trim() : '';
    _closeModal();

    var item = await dbGet('store_items', releaseId);
    if (!item) return;
    item.store_status = 'sold';
    item.sold_date = soldDate;
    item.sold_price = soldPrice || null;
    await dbPut('store_items', item);
    renderStore();
}

// ---- Remove from store + collection ----

function storeRemoveConfirm(releaseId, serial, artist, title) {
    var html =
        '<h2 class="modal-title modal-title-danger">Remove Record</h2>' +
        '<p class="modal-body">' +
        'Removing <strong>' + escHtml(serial) + '</strong> (' + escHtml(artist) + ' — ' + escHtml(title) + ') ' +
        'will permanently delete it from your store <strong>and</strong> your collection. This cannot be undone.' +
        '</p>' +
        '<p class="modal-note">Note: Your Discogs account is not affected. A re-sync will restore the record to this app.</p>' +
        '<div class="modal-actions">' +
        '<button class="btn" onclick="_closeModal()">Cancel</button>' +
        '<button class="btn btn-danger" onclick="storeConfirmRemove(' + releaseId + ')">Delete Permanently</button>' +
        '</div>';
    _showModal(html);
}

async function storeConfirmRemove(releaseId) {
    _closeModal();

    await dbDelete('store_items', releaseId);

    var videos = await dbGetByIndex('videos', 'release_id', releaseId);
    for (var i = 0; i < videos.length; i++) await dbDelete('videos', videos[i].id);

    var tracks = await dbGetByIndex('tracklist', 'release_id', releaseId);
    for (var j = 0; j < tracks.length; j++) await dbDelete('tracklist', tracks[j].id);

    var meta = await dbGetByIndex('track_meta', 'release_id', releaseId);
    for (var k = 0; k < meta.length; k++) await dbDelete('track_meta', meta[k].id);

    await dbDelete('releases', releaseId);
    renderStore();
}

// ---- Batches ----

function storeNewBatchPrompt() {
    var html =
        '<h2 class="modal-title">New Batch</h2>' +
        '<div class="modal-form">' +
        '<label class="form-label">Batch name</label>' +
        '<input id="new-batch-name" class="form-input" type="text" placeholder="e.g. NYC Flea Market May 2026" ' +
        'onkeydown="if(event.key===\'Enter\')storeCreateBatch()">' +
        '</div>' +
        '<div class="modal-actions">' +
        '<button class="btn" onclick="_closeModal()">Cancel</button>' +
        '<button class="btn btn-primary" onclick="storeCreateBatch()">Create</button>' +
        '</div>';
    _showModal(html);
    setTimeout(function () {
        var input = document.getElementById('new-batch-name');
        if (input) input.focus();
    }, 50);
}

async function storeCreateBatch() {
    var input = document.getElementById('new-batch-name');
    if (!input) return;
    var name = input.value.trim();
    if (!name) return;
    _closeModal();
    await dbPut('store_batches', { name: name, created_at: new Date().toISOString() });
    renderStore();
}

function storeDeleteBatchConfirm(batchId, batchName) {
    var html =
        '<h2 class="modal-title modal-title-danger">Delete Batch</h2>' +
        '<p class="modal-body">Delete batch "<strong>' + escHtml(batchName) + '</strong>"? ' +
        'Records in this batch will be unassigned but not deleted from your store.</p>' +
        '<div class="modal-actions">' +
        '<button class="btn" onclick="_closeModal()">Cancel</button>' +
        '<button class="btn btn-danger" onclick="storeConfirmDeleteBatch(' + batchId + ')">Delete Batch</button>' +
        '</div>';
    _showModal(html);
}

async function storeConfirmDeleteBatch(batchId) {
    _closeModal();
    // Unassign all records in this batch
    var items = await dbGetAll('store_items');
    for (var i = 0; i < items.length; i++) {
        if (items[i].batch_id === batchId) {
            items[i].batch_id = null;
            await dbPut('store_items', items[i]);
        }
    }
    await dbDelete('store_batches', batchId);
    if (_storeFilters.batchId === batchId) _storeFilters.batchId = null;
    renderStore();
}

function storeAssignBatchModal(releaseId, currentBatchId) {
    dbGetAll('store_batches').then(function (batches) {
        if (batches.length === 0) {
            _showModal(
                '<h2 class="modal-title">No Batches</h2>' +
                '<p class="modal-body">Create a batch first using the "+ New Batch" button.</p>' +
                '<div class="modal-actions"><button class="btn btn-primary" onclick="_closeModal()">OK</button></div>'
            );
            return;
        }
        var opts = '<option value="">— No batch —</option>';
        batches.forEach(function (b) {
            opts += '<option value="' + b.id + '"' + (currentBatchId === b.id ? ' selected' : '') + '>' + escHtml(b.name) + '</option>';
        });
        var html =
            '<h2 class="modal-title">Assign to Batch</h2>' +
            '<div class="modal-form">' +
            '<label class="form-label">Select batch</label>' +
            '<select id="batch-select" class="form-input">' + opts + '</select>' +
            '</div>' +
            '<div class="modal-actions">' +
            '<button class="btn" onclick="_closeModal()">Cancel</button>' +
            '<button class="btn btn-primary" onclick="storeConfirmAssignBatch(' + releaseId + ')">Assign</button>' +
            '</div>';
        _showModal(html);
    });
}

async function storeConfirmAssignBatch(releaseId) {
    var sel = document.getElementById('batch-select');
    var batchId = sel ? (sel.value ? parseInt(sel.value, 10) : null) : null;
    _closeModal();
    var item = await dbGet('store_items', releaseId);
    if (!item) return;
    item.batch_id = batchId;
    await dbPut('store_items', item);
    renderStore();
}

// ---- Print ----

function storePrintAll() {
    Promise.all([dbGetAll('store_items'), dbGetAll('releases'), dbGetAll('store_batches')]).then(function (res) {
        _openPrintWindow(res[0], res[1], res[2], 'Full Inventory');
    });
}

function storePrintBatch(batchId, batchName) {
    Promise.all([dbGetAll('store_items'), dbGetAll('releases'), dbGetAll('store_batches')]).then(function (res) {
        var batchItems = res[0].filter(function (i) { return i.batch_id === batchId; });
        _openPrintWindow(batchItems, res[1], res[2], 'Batch: ' + batchName);
    });
}

function _openPrintWindow(storeItems, releases, batches, title) {
    var releaseMap = {};
    releases.forEach(function (r) { releaseMap[r.id] = r; });

    var rows = storeItems
        .map(function (item) {
            var rel = releaseMap[item.id] || {};
            return {
                serial: item.serial || '',
                artist: rel.artist || '',
                title: rel.title || '',
                year: rel.year || '',
                format: rel.format || '',
                median_price: item.median_price,
                median_price_currency: item.median_price_currency,
                store_status: item.store_status || 'active'
            };
        })
        .sort(function (a, b) { return a.serial.localeCompare(b.serial); });

    var totalMedian = rows.reduce(function (sum, r) { return sum + (r.median_price || 0); }, 0);
    var today = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });

    var tableRows = rows.map(function (r) {
        var price = r.median_price ? (r.median_price_currency || '') + ' ' + Number(r.median_price).toFixed(2) : '—';
        var sold = r.store_status === 'sold' ? ' [SOLD]' : '';
        return '<tr>' +
            '<td>' + esc(r.serial) + '</td>' +
            '<td>' + esc(r.artist) + '</td>' +
            '<td>' + esc(r.title) + '</td>' +
            '<td>' + esc(String(r.year || '')) + '</td>' +
            '<td>' + esc(r.format) + '</td>' +
            '<td>' + esc(price) + '</td>' +
            '<td>' + esc(sold.trim()) + '</td>' +
            '</tr>';
    }).join('');

    function esc(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<title>' + esc(title) + '</title>' +
        '<style>' +
        'body{font-family:monospace;font-size:12px;color:#000;padding:20px;}' +
        'h1{font-size:16px;margin-bottom:4px;}' +
        '.sub{font-size:11px;color:#555;margin-bottom:16px;}' +
        'table{width:100%;border-collapse:collapse;}' +
        'th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #ccc;}' +
        'th{border-bottom:2px solid #000;font-weight:bold;}' +
        'tr:last-child td{border-bottom:none;}' +
        '.footer{margin-top:16px;border-top:2px solid #000;padding-top:8px;font-size:11px;}' +
        '@media print{body{padding:0;}}' +
        '</style></head><body>' +
        '<h1>' + esc(title) + '</h1>' +
        '<div class="sub">' + esc(today) + ' &nbsp;·&nbsp; ' + rows.length + ' records</div>' +
        '<table><thead><tr>' +
        '<th>Serial</th><th>Artist</th><th>Title</th><th>Year</th><th>Format</th><th>Median $</th><th>Status</th>' +
        '</tr></thead><tbody>' + tableRows + '</tbody></table>' +
        '<div class="footer">Total records: ' + rows.length +
        (totalMedian > 0 ? ' &nbsp;·&nbsp; Total median value: ' + Number(totalMedian).toFixed(2) : '') +
        '</div>' +
        '<script>window.onload=function(){window.print();};<\/script>' +
        '</body></html>';

    var w = window.open('', '_blank');
    if (w) {
        w.document.write(html);
        w.document.close();
    }
}
