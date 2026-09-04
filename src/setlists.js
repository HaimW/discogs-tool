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
            metaId: track.metaId || null
        });
        sl.updated_at = new Date().toISOString();
        return dbPut('setlists', sl).then(function () {
            showSyncBanner('Added to "' + sl.name + '"');
            setTimeout(hideSyncBanner, 1200);
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
            releaseId: vid ? vid.release_id : null,
            metaId: vid ? (vid.release_id + '_' + vid.youtube_id) : null
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

function closeAllPopovers() {
    document.querySelectorAll('.popover').forEach(function (p) { p.remove(); });
    document.removeEventListener('click', _popoverOutsideHandler);
}

// ------ Setlists index view ------

function renderSetlists() {
    dbGetAll('setlists').then(function (setlists) {
        setlists.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
        var html = '<div class="collection-header"><div class="collection-stats">' +
            '<h1>Setlists</h1>' +
            '<span class="stat-count">' + setlists.length + ' setlist' + (setlists.length === 1 ? '' : 's') + '</span>' +
            '<button class="btn btn-primary" onclick="promptNewSetlist()">+ New Setlist</button>' +
            '</div></div>';
        if (setlists.length === 0) {
            html += '<div class="empty-state"><p class="empty-title">No setlists yet</p>' +
                '<p class="empty-subtitle">Create a setlist to prep your next gig</p>' +
                '<button class="btn btn-primary btn-large" onclick="promptNewSetlist()">+ New Setlist</button></div>';
        } else {
            html += '<div class="setlist-index">';
            setlists.forEach(function (sl) {
                var count = (sl.tracks || []).length;
                var updated = (sl.updated_at || '').substring(0, 10);
                html += '<div class="setlist-card" onclick="navigate(\'setlist\',{setlistId:' + sl.id + '})">' +
                    '<div class="setlist-card-name">' + escHtml(sl.name) + '</div>' +
                    '<div class="setlist-card-meta">' + count + ' track' + (count === 1 ? '' : 's') + ' &middot; updated ' + updated + '</div>' +
                    '</div>';
            });
            html += '</div>';
        }
        document.getElementById('app').innerHTML = html;
    });
}

// ------ Setlist detail view ------

function renderSetlist(setlistId) {
    if (!setlistId) { navigate('setlists'); return; }
    Promise.all([dbGet('setlists', setlistId), dbGetAll('track_meta')]).then(function (results) {
        var sl = results[0];
        if (!sl) { navigate('setlists'); return; }
        var metaById = {};
        results[1].forEach(function (m) { metaById[m.id] = m; });
        var tracks = sl.tracks || [];

        var html = '<span class="back-link" onclick="navigate(\'setlists\')">&larr; Back to setlists</span>';
        html += '<div class="setlist-detail">';
        html += '<div class="setlist-header">' +
            '<input type="text" class="setlist-name-input" value="' + escHtml(sl.name) + '" onchange="renameSetlist(' + sl.id + ', this.value)">' +
            '<div class="setlist-actions">' +
                '<button class="btn btn-play-all"' + (tracks.length === 0 ? ' disabled' : '') + ' onclick="playSetlist(' + sl.id + ')">&#9654; Play all</button>' +
                '<div class="setlist-export">' +
                    '<button class="btn"' + (tracks.length === 0 ? ' disabled' : '') + ' onclick="toggleExportMenu(' + sl.id + ')">Export &#9662;</button>' +
                    '<div class="export-menu popover" id="export-menu-' + sl.id + '" style="display:none;">' +
                        '<div class="popover-item" onclick="exportSetlistM3U(' + sl.id + ');toggleExportMenu(' + sl.id + ')">M3U playlist</div>' +
                        '<div class="popover-item" onclick="exportSetlistTxt(' + sl.id + ');toggleExportMenu(' + sl.id + ')">Plain text (.txt)</div>' +
                        '<div class="popover-item" onclick="exportSetlistCsv(' + sl.id + ');toggleExportMenu(' + sl.id + ')">CSV with BPM/key</div>' +
                    '</div>' +
                '</div>' +
                '<button class="btn btn-danger" onclick="deleteSetlist(' + sl.id + ')">Delete</button>' +
            '</div>' +
        '</div>';
        html += '<textarea class="setlist-notes" placeholder="Setlist notes (venue, vibe, intro track idea...)" onchange="saveSetlistNotes(' + sl.id + ', this.value)">' + escHtml(sl.notes || '') + '</textarea>';

        if (tracks.length === 0) {
            html += '<div class="empty-state"><p class="empty-title">Empty setlist</p>' +
                '<p class="empty-subtitle">Add tracks from Collection or All Tracks view using the + button</p></div>';
        } else {
            html += '<div class="video-list setlist-tracklist">';
            tracks.forEach(function (t, i) {
                var meta = metaById[t.metaId] || {};
                html += '<div class="video-item setlist-row" draggable="true" data-index="' + i + '" data-youtube-id="' + escHtml(t.youtubeId) + '" data-title="' + escHtml(t.title) + '" data-artist="' + escHtml(t.artist || '') + '" data-cover="' + escHtml(t.cover || '') + '" data-release-id="' + (t.releaseId || '') + '" data-meta-id="' + escHtml(t.metaId || '') + '">' +
                    '<span class="drag-handle" title="Drag to reorder">&#8942;</span>' +
                    '<span class="setlist-num">' + (i + 1) + '</span>' +
                    '<button class="play-btn" onclick="playFromSetlist(' + sl.id + ',' + i + ')"><span class="play-icon">&#9654;</span></button>';
                if (t.cover) {
                    html += '<img class="track-thumb" src="' + escHtml(t.cover) + '" alt="" loading="lazy">';
                } else {
                    html += '<div class="track-thumb no-thumb">&#9898;</div>';
                }
                html += '<div class="track-info">' +
                    '<div class="track-title-line">' + escHtml(t.title) + '</div>' +
                    '<div class="track-sub-line">' + escHtml(t.artist || '') + '</div>' +
                    '</div>';
                html += '<span class="track-badges">';
                if (meta.bpm != null) html += '<span class="track-badge badge-bpm">' + meta.bpm + '</span>';
                if (meta.key) html += camelotChip(meta.key, { estimated: meta.key_source === 'analysis' && !meta.bpm_verified });
                if (meta.rating) html += '<span class="track-badge badge-rating">' + ratingStars(meta.rating) + '</span>';
                html += '</span>';
                html += '<button class="meta-btn" onclick="removeTrackFromSetlist(' + sl.id + ',' + i + ')" title="Remove">&times;</button>';
                html += '</div>';
            });
            html += '</div>';
        }
        html += '</div>';
        document.getElementById('app').innerHTML = html;
        if (tracks.length > 0) initSetlistDragDrop(sl.id);
    });
}

function playSetlist(id) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl || !sl.tracks || sl.tracks.length === 0) return;
        currentQueue = sl.tracks.map(function (t) {
            return { youtubeId: t.youtubeId, releaseId: t.releaseId || null, title: t.title, artist: t.artist || '', cover: t.cover || '' };
        });
        currentIndex = 0;
        loadFromQueue(0);
    });
}

function playFromSetlist(id, idx) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl || !sl.tracks || sl.tracks.length === 0) return;
        currentQueue = sl.tracks.map(function (t) {
            return { youtubeId: t.youtubeId, releaseId: t.releaseId || null, title: t.title, artist: t.artist || '', cover: t.cover || '' };
        });
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
