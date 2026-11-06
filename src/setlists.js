function createSetlist(name) {
    var now = new Date().toISOString();
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('setlists', 'readwrite');
            var req = tx.objectStore('setlists').add({
                name: name || 'Untitled setlist',
                created_at: now,
                updated_at: now,
                tracks: [],
                notes: ''
            });
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    });
}

function addTrackToSetlist(setlistId, track) {
    return dbGet('setlists', setlistId).then(function (sl) {
        if (!sl) return;
        sl.tracks = sl.tracks || [];
        sl.tracks.push({
            youtubeId: track.youtubeId,
            title: track.title,
            artist: track.artist || '',
            cover: track.cover || '',
            releaseId: track.releaseId || null,
            // Filled from release + video when the caller had none (F18).
            metaId: itemMetaId(track)
        });
        sl.updated_at = new Date().toISOString();
        return dbPut('setlists', sl).then(function () {
            showToast('Added to "' + sl.name + '"', 'success');
        });
    });
}

function removeTrackFromSetlist(id, idx) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl) return;
        sl.tracks.splice(idx, 1);
        sl.updated_at = new Date().toISOString();
        dbPut('setlists', sl).then(function () { renderSetlist(id); });
    });
}

function moveSetlistTrack(id, fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    dbGet('setlists', id).then(function (sl) {
        if (!sl) return;
        var track = sl.tracks.splice(fromIdx, 1)[0];
        sl.tracks.splice(toIdx, 0, track);
        sl.updated_at = new Date().toISOString();
        dbPut('setlists', sl).then(function () { renderSetlist(id); });
    });
}

function initSetlistDragDrop(setlistId) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('.setlist-tracklist .setlist-row'));
    var dragSrcIdx = null;

    function clearDragOver() {
        rows.forEach(function (r) { r.classList.remove('drag-over-above', 'drag-over-below'); });
    }

    rows.forEach(function (row, idx) {
        row.addEventListener('dragstart', function (e) {
            dragSrcIdx = idx;
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(function () { row.classList.add('dragging'); }, 0);
        });

        row.addEventListener('dragend', function () {
            row.classList.remove('dragging');
            clearDragOver();
        });

        row.addEventListener('dragover', function (e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            clearDragOver();
            var rect = row.getBoundingClientRect();
            if (e.clientY < rect.top + rect.height / 2) {
                row.classList.add('drag-over-above');
            } else {
                row.classList.add('drag-over-below');
            }
        });

        row.addEventListener('dragleave', function (e) {
            if (!row.contains(e.relatedTarget)) {
                row.classList.remove('drag-over-above', 'drag-over-below');
            }
        });

        row.addEventListener('drop', function (e) {
            e.preventDefault();
            clearDragOver();
            if (dragSrcIdx === null || dragSrcIdx === idx) return;
            var rect = row.getBoundingClientRect();
            var toIdx = (e.clientY < rect.top + rect.height / 2) ? idx : idx + 1;
            if (dragSrcIdx < toIdx) toIdx--;
            moveSetlistTrack(setlistId, dragSrcIdx, toIdx);
        });
    });
}

function renameSetlist(id, name) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl) return;
        var trimmed = (name || '').trim();
        if (!trimmed) return;
        sl.name = trimmed;
        sl.updated_at = new Date().toISOString();
        dbPut('setlists', sl);
    });
}

function saveSetlistNotes(id, notes) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl) return;
        sl.notes = notes || '';
        sl.updated_at = new Date().toISOString();
        dbPut('setlists', sl);
    });
}

function deleteSetlist(id) {
    if (!confirm('Delete this setlist? This cannot be undone.')) return;
    dbDelete('setlists', id).then(function () { navigate('setlists'); });
}

function promptNewSetlist() {
    var name = prompt('Name for new setlist:');
    if (!name) return;
    createSetlist(name.trim()).then(function (newId) {
        navigate('setlist', { setlistId: newId });
    });
}

// ------ Add-to-setlist popover ------

function openAddToSetlistPopover(btn) {
    closeAllPopovers();
    var row = btn.closest('.video-item');
    if (!row) return;
    var track = {
        youtubeId: row.dataset.youtubeId,
        title: row.dataset.title,
        artist: row.dataset.artist,
        cover: row.dataset.cover,
        releaseId: parseInt(row.dataset.releaseId, 10) || null,
        metaId: row.dataset.metaId || null
    };
    _openSetlistPopoverForTrack(btn, track);
}

// Opens the add-to-setlist popover for an arbitrary track object (not bound to a DOM row).
// Used both by openAddToSetlistPopover (from track list rows) and by the now-playing + button.
function _openSetlistPopoverForTrack(btn, track) {
    dbGetAll('setlists').then(function (setlists) {
        setlists.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
        var pop = document.createElement('div');
        pop.className = 'popover add-to-setlist-popover';
        var html = '<div class="popover-title">Add to setlist</div>';
        if (setlists.length === 0) {
            html += '<div class="popover-empty">No setlists yet</div>';
        } else {
            setlists.forEach(function (sl) {
                html += '<div class="popover-item" data-id="' + sl.id + '">' +
                    '<span class="popover-item-name">' + escHtml(sl.name) + '</span>' +
                    '<span class="popover-item-count">' + ((sl.tracks || []).length) + '</span>' +
                    '</div>';
            });
        }
        html += '<div class="popover-divider"></div>';
        html += '<div class="popover-item popover-new">+ New setlist...</div>';
        pop.innerHTML = html;
        document.body.appendChild(pop);

        // Position near button — above if the button is in the lower half of the viewport
        var rect = btn.getBoundingClientRect();
        pop.style.position = 'fixed';
        if (rect.top > window.innerHeight / 2) {
            pop.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
            pop.style.top = 'auto';
        } else {
            pop.style.top = (rect.bottom + 6) + 'px';
            pop.style.bottom = 'auto';
        }
        var left = rect.right - 240;
        if (left < 8) left = 8;
        if (left + 248 > window.innerWidth - 8) left = window.innerWidth - 256;
        pop.style.left = left + 'px';

        // Wire clicks
        pop.querySelectorAll('.popover-item[data-id]').forEach(function (el) {
            el.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = parseInt(el.getAttribute('data-id'), 10);
                addTrackToSetlist(id, track).then(closeAllPopovers);
            });
        });
        var newBtn = pop.querySelector('.popover-new');
        newBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var name = prompt('Name for new setlist:');
            if (!name) { closeAllPopovers(); return; }
            createSetlist(name.trim()).then(function (newId) {
                addTrackToSetlist(newId, track).then(closeAllPopovers);
            });
        });

        setTimeout(function () {
            document.addEventListener('click', _popoverOutsideHandler);
        }, 0);
    });
}

// + button on the now-playing bar: looks up releaseId/metaId via videos index then opens the setlist popover.
function openNowPlayingAddToSetlist(btn) {
    if (currentIndex < 0 || !currentQueue[currentIndex]) return;
    closeAllPopovers();
    var cur = currentQueue[currentIndex];
    dbGetByIndex('videos', 'youtube_id', cur.youtubeId).then(function (vids) {
        var vid = vids[0] || null;
        var track = {
            youtubeId: cur.youtubeId,
            title: cur.title,
            artist: cur.artist,
            cover: cur.cover,
            releaseId: vid ? vid.release_id : (cur.releaseId || null),
            metaId: vid ? trackMetaId(vid.release_id, vid.youtube_id) : (cur.metaId || null)
        };
        _openSetlistPopoverForTrack(btn, track);
    });
}

// ↗ button on the now-playing bar: navigates to the release for the current track.
function gotoNowPlayingRelease() {
    if (currentIndex < 0 || !currentQueue[currentIndex]) return;
    var cur = currentQueue[currentIndex];
    if (cur.releaseId) {
        navigate('release', { releaseId: cur.releaseId });
        return;
    }
    // Fallback for queue items persisted before releaseId was stored.
    dbGetByIndex('videos', 'youtube_id', cur.youtubeId).then(function (vids) {
        if (vids.length > 0) navigate('release', { releaseId: vids[0].release_id });
    });
}

function _popoverOutsideHandler(e) {
    var pop = document.querySelector('.popover');
    if (pop && !pop.contains(e.target)) closeAllPopovers();
}

// One export menu entry: export, then close the menu.
function exportSetlistAs(id, format) {
    if (format === 'm3u') exportSetlistM3U(id);
    else if (format === 'txt') exportSetlistTxt(id);
    else if (format === 'csv') exportSetlistCsv(id);
    toggleExportMenu(id);
}

function closeAllPopovers() {
    document.querySelectorAll('.popover').forEach(function (p) { p.remove(); });
    document.removeEventListener('click', _popoverOutsideHandler);
}

// ------ Setlists index view ------

function renderSetlists() {
    var tok = startViewRender('setlists');
    return endViewRender(tok, dbGetAll('setlists').then(function (setlists) {
        if (!viewRenderIsCurrent(tok)) return;
        setlists.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
        var html = '<div class="collection-header"><div class="collection-stats">' +
            '<h1>Setlists</h1>' +
            '<span class="stat-count">' + setlists.length + ' setlist' + (setlists.length === 1 ? '' : 's') + '</span>' +
            '<button class="btn btn-primary"' + act('click', 'promptNewSetlist') + '>+ New Setlist</button>' +
            '</div></div>';
        if (setlists.length === 0) {
            html += '<div class="empty-state"><p class="empty-title">No setlists yet</p>' +
                '<p class="empty-subtitle">Create a setlist to prep your next gig</p>' +
                '<button class="btn btn-primary btn-large"' + act('click', 'promptNewSetlist') + '>+ New Setlist</button></div>';
        } else {
            html += '<div class="setlist-index">';
            setlists.forEach(function (sl) {
                var count = (sl.tracks || []).length;
                var updated = (sl.updated_at || '').substring(0, 10);
                html += '<div class="setlist-card"' + act('click', 'navigate', ['setlist', { setlistId: sl.id }]) + '>' +
                    '<div class="setlist-card-name">' + escHtml(sl.name) + '</div>' +
                    '<div class="setlist-card-meta">' + count + ' track' + (count === 1 ? '' : 's') + ' &middot; updated ' + updated + '</div>' +
                    '</div>';
            });
            html += '</div>';
        }
        document.getElementById('app').innerHTML = html;
    }));
}

// ------ Setlist detail view ------

// The track list is a table (F18): every row shares one column template
// (style.css, .setlist-tracklist), so BPM, key, energy and rating line up down
// the list, and a value that is missing keeps its cell. ARIA table roles make
// a screen reader announce each value with its column name.

// An empty metadata cell: a dim dash to the eye, "none" to a screen reader.
var SETLIST_NONE = '<span class="sl-none" aria-hidden="true">&ndash;</span><span class="sr-only">none</span>';

// The tempo as stored, to one decimal place at most ("124", "122.5").
function setlistBpmText(meta) {
    if (!meta || meta.bpm == null || meta.bpm === '') return '';
    var n = Number(meta.bpm);
    if (!isFinite(n) || n <= 0) return '';
    return String(Math.round(n * 10) / 10);
}

// The four metadata cells of a row: BPM, key, energy, rating. The estimate
// markers (dashed border, "~") are the same as on the release page.
function setlistMetaCellsHtml(meta) {
    meta = meta || {};
    var html = '';
    var bpm = setlistBpmText(meta);
    html += '<span class="sl-cell sl-c-bpm" role="cell">';
    if (bpm) {
        var estBpm = meta.bpm_source === 'analysis' && !meta.bpm_verified;
        html += '<span class="track-badge badge-bpm' + (estBpm ? ' badge-estimated' : '') + '"' +
            ' title="' + (estBpm ? 'Estimated by analysis' : 'BPM') + '">' + escHtml(bpm) +
            // Always there, so estimated and confirmed figures end at the same x.
            '<span class="badge-est" aria-hidden="true">' + (estBpm ? '~' : '') + '</span>' +
            (estBpm ? '<span class="sr-only"> (estimated)</span>' : '') +
            '</span>';
    } else {
        html += SETLIST_NONE;
    }
    html += '</span>';

    var key = camelotCode(meta.key) || camelotCode(meta.key_musical);
    html += '<span class="sl-cell sl-c-key" role="cell">';
    // Name and relative key ride along as elsewhere; narrow screens hide both
    // (style.css), leaving the code.
    html += key ? camelotChip(key, {
        estimated: meta.key_source === 'analysis' && !meta.bpm_verified,
        musical: meta.key_musical || true
    }) : SETLIST_NONE;
    html += '</span>';

    html += '<span class="sl-cell sl-c-energy" role="cell">' + (energyBadge(meta) || SETLIST_NONE) + '</span>';

    var rating = Math.max(0, Math.min(5, parseInt(meta.rating, 10) || 0));
    html += '<span class="sl-cell sl-c-rating" role="cell">';
    html += rating
        ? '<span class="track-badge badge-rating" title="Rating ' + rating + ' of 5">' +
            '<span aria-hidden="true">' + ratingStars(rating) + '</span>' +
            '<span class="sr-only">' + rating + ' of 5</span></span>'
        : SETLIST_NONE;
    html += '</span>';
    return html;
}

// The whole track table: a header row, then one row per track. Only the
// track rows are .setlist-row (initSetlistDragDrop counts those).
function setlistTableHtml(sl, index) {
    var tracks = sl.tracks || [];
    var html = '<div class="setlist-tracklist" role="table" aria-label="Tracks in ' + escHtml(sl.name) + '">';
    html += '<div class="setlist-head" role="row">' +
        '<span class="sl-cell sl-c-handle" role="columnheader"><span class="sr-only">Drag</span></span>' +
        '<span class="sl-cell sl-c-num" role="columnheader">#</span>' +
        '<span class="sl-cell sl-c-play" role="columnheader"><span class="sr-only">Play</span></span>' +
        '<span class="sl-cell sl-c-cover" role="columnheader"><span class="sr-only">Cover</span></span>' +
        '<span class="sl-cell sl-c-title" role="columnheader">Track</span>' +
        '<span class="sl-cell sl-c-bpm" role="columnheader">BPM</span>' +
        '<span class="sl-cell sl-c-key" role="columnheader">Key</span>' +
        '<span class="sl-cell sl-c-energy" role="columnheader">Energy</span>' +
        '<span class="sl-cell sl-c-rating" role="columnheader">Rating</span>' +
        '<span class="sl-cell sl-c-remove" role="columnheader"><span class="sr-only">Remove</span></span>' +
        '</div>';
    tracks.forEach(function (t, i) {
        var meta = queueItemMeta(t, index);
        html += '<div class="video-item setlist-row" role="row" draggable="true" data-index="' + i + '" data-youtube-id="' + escHtml(t.youtubeId) + '" data-title="' + escHtml(t.title) + '" data-artist="' + escHtml(t.artist || '') + '" data-cover="' + escHtml(t.cover || '') + '" data-release-id="' + escHtml(t.releaseId == null ? '' : t.releaseId) + '" data-meta-id="' + escHtml(t.metaId || '') + '">' +
            '<span class="sl-cell sl-c-handle" role="cell"><span class="drag-handle" title="Drag to reorder" aria-hidden="true">&#8942;</span></span>' +
            '<span class="sl-cell sl-c-num setlist-num" role="cell">' + (i + 1) + '</span>' +
            '<span class="sl-cell sl-c-play" role="cell"><button class="play-btn"' + act('click', 'playFromSetlist', [sl.id, i]) +
                ' aria-label="Play ' + escHtml(t.title) + '"><span class="play-icon" aria-hidden="true">&#9654;</span></button></span>';
        html += '<span class="sl-cell sl-c-cover" role="cell">' + (t.cover
            ? '<img class="track-thumb" src="' + escHtml(t.cover) + '" alt="" loading="lazy" draggable="false">'
            : '<span class="track-thumb no-thumb" aria-hidden="true">&#9898;</span>') + '</span>';
        html += '<span class="sl-cell sl-c-title track-info" role="cell">' +
            '<span class="track-title-line" title="' + escHtml(t.title) + '">' + escHtml(t.title) + '</span>' +
            '<span class="track-sub-line">' + escHtml(t.artist || '') + '</span>' +
            '</span>';
        html += setlistMetaCellsHtml(meta);
        html += '<span class="sl-cell sl-c-remove" role="cell"><button class="meta-btn"' + act('click', 'removeTrackFromSetlist', [sl.id, i]) +
            ' title="Remove" aria-label="Remove ' + escHtml(t.title) + '">&times;</button></span>';
        html += '</div>';
    });
    html += '</div>';
    return html;
}

function renderSetlist(setlistId) {
    var tok = startViewRender('setlist', setlistId);
    if (!setlistId) { navigate('setlists'); return; }
    return endViewRender(tok, Promise.all([dbGet('setlists', setlistId), dbGetAll('track_meta')]).then(function (results) {
        if (!viewRenderIsCurrent(tok)) return;
        var sl = results[0];
        if (!sl) { navigate('setlists'); return; }
        var tracks = sl.tracks || [];

        var html = '<span class="back-link"' + act('click', 'navigate', ['setlists']) + '>&larr; Back to setlists</span>';
        html += '<div class="setlist-detail">';
        html += '<div class="setlist-header">' +
            '<input type="text" class="setlist-name-input" value="' + escHtml(sl.name) + '"' + act('change', 'renameSetlist', [sl.id, ACT_VALUE]) + '>' +
            '<div class="setlist-actions">' +
                '<button class="btn btn-play-all"' + (tracks.length === 0 ? ' disabled' : '') + act('click', 'playSetlist', [sl.id]) + '>&#9654; Play all</button>' +
                '<div class="setlist-export">' +
                    '<button class="btn"' + (tracks.length === 0 ? ' disabled' : '') + act('click', 'toggleExportMenu', [sl.id]) + '>Export &#9662;</button>' +
                    '<div class="export-menu popover" id="export-menu-' + escHtml(sl.id) + '" style="display:none;">' +
                        '<div class="popover-item"' + act('click', 'exportSetlistAs', [sl.id, 'm3u']) + '>M3U playlist</div>' +
                        '<div class="popover-item"' + act('click', 'exportSetlistAs', [sl.id, 'txt']) + '>Plain text (.txt)</div>' +
                        '<div class="popover-item"' + act('click', 'exportSetlistAs', [sl.id, 'csv']) + '>CSV with BPM/key</div>' +
                    '</div>' +
                '</div>' +
                '<button class="btn btn-danger"' + act('click', 'deleteSetlist', [sl.id]) + '>Delete</button>' +
            '</div>' +
        '</div>';
        html += '<textarea class="setlist-notes" placeholder="Setlist notes (venue, vibe, intro track idea...)"' + act('change', 'saveSetlistNotes', [sl.id, ACT_VALUE]) + '>' + escHtml(sl.notes || '') + '</textarea>';

        if (tracks.length === 0) {
            html += '<div class="empty-state"><p class="empty-title">This setlist is empty</p>' +
                '<p class="empty-subtitle">Add tracks with the + button on a release page or in Tracks.</p>' +
                '<button class="btn btn-primary"' + act('click', 'navigate', ['tracks']) + '>Browse tracks</button></div>';
        } else {
            html += setlistTableHtml(sl, setlistMetaIndex(results[1]));
        }
        html += '</div>';
        document.getElementById('app').innerHTML = html;
        if (tracks.length > 0) initSetlistDragDrop(sl.id);
    }));
}

// The queue items for a setlist's tracks. metaId rides along so the queue
// panel finds the same metadata the setlist shows.
function setlistQueueItems(sl) {
    return (sl.tracks || []).map(function (t) {
        return {
            youtubeId: t.youtubeId, releaseId: t.releaseId || null, metaId: t.metaId || null,
            title: t.title, artist: t.artist || '', cover: t.cover || ''
        };
    });
}

function playSetlist(id) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl || !sl.tracks || sl.tracks.length === 0) return;
        currentQueue = setlistQueueItems(sl);
        currentIndex = 0;
        loadFromQueue(0);
    });
}

function playFromSetlist(id, idx) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl || !sl.tracks || sl.tracks.length === 0) return;
        currentQueue = setlistQueueItems(sl);
        currentIndex = idx;
        loadFromQueue(idx);
    });
}

// ------ Export ------

function toggleExportMenu(id) {
    var menu = document.getElementById('export-menu-' + id);
    if (!menu) return;
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function downloadBlob(filename, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 0);
}

function slugifySetlist(s) {
    return (s || 'setlist').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'setlist';
}
