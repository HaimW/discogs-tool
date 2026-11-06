// ============ Queue Panel ============

// `carry` continues a drag that was under way on the panel this one replaces,
// so a redraw mid-drag (the track ended) does not drop the panel.
function makeDraggable(panel, carry) {
    var header = panel.querySelector('.queue-header');
    if (!header) return;
    var isDragging = !!(carry && carry.dragging), ox = carry ? carry.ox : 0, oy = carry ? carry.oy : 0;
    header.style.cursor = 'move';
    header.addEventListener('mousedown', function (e) {
        if (e.target.closest('button')) return;
        isDragging = true;
        var rect = panel.getBoundingClientRect();
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        ox = e.clientX - rect.left;
        oy = e.clientY - rect.top;
        e.preventDefault();
    });
    function onMove(e) {
        if (!isDragging) return;
        var l = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - ox));
        var t = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
        panel.style.left = l + 'px';
        panel.style.top = t + 'px';
    }
    function onUp() { isDragging = false; }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    panel._dragState = function () { return { dragging: isDragging, ox: ox, oy: oy }; };
    panel._cleanup = function () {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };
}

function openQueue() {
    var existing = document.getElementById('queue-panel');
    if (existing) { closeQueue(); return; }
    if (currentQueue.length === 0) return;
    _renderQueuePanel();
}

function closeQueue() {
    var panel = document.getElementById('queue-panel');
    if (panel) {
        if (panel._cleanup) panel._cleanup();
        panel.remove();
    }
    var btn = document.getElementById('np-queue');
    if (btn) btn.classList.remove('active');
}

// Bumped on every draw; a BPM/key read that finishes after a newer draw (or
// after the panel closed) is dropped.
var _queueDrawSeq = 0;
// Whether the last filled draw had any BPM/key. A redraw reserves the column
// from the start, so filling it in does not shift the titles every time.
var _queueShowsMeta = false;

// What a redraw carries over from the panel it replaces (L9): where the user
// dragged it, how far the list was scrolled, a drag under way, and which
// button had focus.
function _queuePanelState(panel) {
    var list = panel.querySelector('.queue-list');
    var st = {
        left: panel.style.left, top: panel.style.top,
        right: panel.style.right, bottom: panel.style.bottom,
        scrollTop: list ? list.scrollTop : 0,
        drag: panel._dragState ? panel._dragState() : null,
        focus: null
    };
    var active = document.activeElement;
    if (active && typeof panel.contains === 'function' && panel.contains(active) && active !== panel) {
        var row = active.closest ? active.closest('.queue-row') : null;
        var cls = ['queue-play-btn', 'queue-remove-btn'].filter(function (c) { return active.classList.contains(c); })[0];
        if (row && cls && list) {
            st.focus = { row: Array.prototype.indexOf.call(list.children, row), cls: cls };
        } else {
            var btns = panel.querySelectorAll('.queue-header button');
            var hi = Array.prototype.indexOf.call(btns, active);
            if (hi >= 0) st.focus = { header: hi };
        }
    }
    return st;
}

function _restoreQueueFocus(panel, list, f) {
    var el = null;
    if (f.header != null) {
        el = panel.querySelectorAll('.queue-header button')[f.header];
    } else if (list.children.length) {
        var row = list.children[Math.min(f.row, list.children.length - 1)];
        el = row.querySelector('.' + f.cls);
    }
    if (el) el.focus({ preventScroll: true });
}

// Scroll the list, never the page, just far enough to show `row`; with
// `centre`, put a hidden row in the middle instead. A row already in full view
// leaves the list alone.
function _revealQueueRow(list, row, centre) {
    var lb = list.getBoundingClientRect();
    var rb = row.getBoundingClientRect();
    if (rb.top >= lb.top && rb.bottom <= lb.bottom) return;
    if (centre) {
        list.scrollTop += (rb.top + rb.height / 2) - (lb.top + lb.height / 2);
    } else if (rb.top < lb.top) {
        list.scrollTop -= lb.top - rb.top;
    } else {
        list.scrollTop += rb.bottom - lb.bottom;
    }
}

// Draws (or redraws) the queue panel.
//
// opts.reveal says whether to bring the current track into view:
//   'open'     - the panel is opening, or shows a brand-new queue (shuffle):
//                centre the current row if it is out of view. Implied when no
//                panel was open.
//   'ifHidden' - playback moved on by itself or by Next/Prev: scroll the list
//                just enough to show the new current row, only if it is hidden.
//   false      - (default for a redraw) the list stays exactly where it was:
//                a row's play / remove button, a suggestion queued.
// A redraw always keeps the panel where it was dragged to (L9).
function _renderQueuePanel(opts) {
    var reveal = opts && opts.reveal ? opts.reveal : false;
    var existing = document.getElementById('queue-panel');
    var prev = null;
    if (existing) {
        prev = _queuePanelState(existing);
        // Its drag listeners live on document: remove them with it (L2).
        if (existing._cleanup) existing._cleanup();
        existing.remove();
    } else {
        reveal = 'open';
    }

    var panel = document.createElement('div');
    panel.id = 'queue-panel';
    panel.className = 'queue-panel';
    if (prev) {
        ['left', 'top', 'right', 'bottom'].forEach(function (k) { if (prev[k]) panel.style[k] = prev[k]; });
    }

    var html = '<div class="queue-header">' +
        '<span class="queue-title">&#9776; Queue &mdash; ' + currentQueue.length + ' track' + (currentQueue.length === 1 ? '' : 's') + '</span>' +
        '<div class="queue-header-actions">' +
        '<button class="btn"' + act('click', 'saveQueueAsSetlist') + '>Save as setlist</button>' +
        '<button class="meta-btn"' + act('click', 'closeQueue') + ' title="Close">&times;</button>' +
        '</div></div>';

    html += '<div class="queue-list' + (_queueShowsMeta ? ' queue-has-meta' : '') + '">';
    currentQueue.forEach(function (item, i) {
        var isCurrent = (i === currentIndex);
        html += '<div class="queue-row' + (isCurrent ? ' queue-current' : '') + '">';
        html += '<span class="queue-num">' + (i + 1) + '</span>';
        // BPM and key (F16), filled in once track_meta has been read.
        html += '<span class="queue-meta"></span>';
        if (item.cover) {
            html += '<img class="track-thumb" src="' + escHtml(item.cover) + '" alt="" loading="lazy">';
        } else {
            html += '<div class="track-thumb no-thumb">&#9898;</div>';
        }
        html += '<div class="track-info">' +
            '<div class="track-title-line">' + escHtml(item.title) + '</div>' +
            '<div class="track-sub-line">' + escHtml(item.artist) + '</div>' +
            '</div>';
        html += '<div class="queue-actions">' +
            '<button class="btn queue-play-btn"' + act('click', 'playFromQueuePanel', [i]) + ' title="Play from here">&#9654;</button>' +
            '<button class="btn queue-remove-btn"' + act('click', 'removeFromQueuePanel', [i]) + ' title="Remove">&times;</button>' +
            '</div>';
        html += '</div>';
    });
    html += '</div>';

    panel.innerHTML = html;
    document.body.appendChild(panel);
    makeDraggable(panel, prev && prev.drag);

    var npBtn = document.getElementById('np-queue');
    if (npBtn) npBtn.classList.add('active');

    // Done straight away rather than on a timer, so nothing moves after the
    // user has seen the list.
    var list = panel.querySelector('.queue-list');
    if (list) {
        if (prev && reveal !== 'open') list.scrollTop = prev.scrollTop;
        var cur = reveal ? list.querySelector('.queue-current') : null;
        if (cur) _revealQueueRow(list, cur, reveal === 'open');
        if (prev && prev.focus) _restoreQueueFocus(panel, list, prev.focus);
    }

    _fillQueueMeta(panel, ++_queueDrawSeq, currentQueue.slice());
}

// Fills each row's BPM / key from one read of track_meta: one index, one pass
// over the rows, no read per row, so a whole-collection shuffle stays quick.
// The panel is already on screen; if it has been redrawn or closed by the time
// the read comes back, the result is dropped. The cells have a fixed size, so
// filling them never changes a row's height or the list's scroll position.
function _fillQueueMeta(panel, seq, items) {
    Promise.resolve().then(function () {
        return dbGetAll('track_meta');
    }).then(function (metas) {
        if (seq !== _queueDrawSeq || !panel.isConnected) return;
        var index = queueMetaIndex(metas);
        var cells = panel.querySelectorAll('.queue-meta');
        var any = false;
        for (var i = 0; i < cells.length && i < items.length; i++) {
            var html = queueMetaHtml(queueItemMeta(items[i], index));
            if (html) { cells[i].innerHTML = html; any = true; }
        }
        _queueShowsMeta = any;
        var list = panel.querySelector('.queue-list');
        if (list) list.classList.toggle('queue-has-meta', any);
    }).catch(function (err) {
        console.warn('Queue: BPM/key not loaded', err);
    });
}

function playFromQueuePanel(idx) {
    if (idx < 0 || idx >= currentQueue.length) return;
    currentIndex = idx;
    loadFromQueue(currentIndex);
    _renderQueuePanel();
}

function removeFromQueuePanel(idx) {
    if (idx < 0 || idx >= currentQueue.length) return;
    currentQueue.splice(idx, 1);
    if (currentIndex > idx) currentIndex--;
    else if (currentIndex === idx && currentIndex >= currentQueue.length) currentIndex = Math.max(0, currentQueue.length - 1);
    _savePlayerState();
    if (cfEnabled && _cfState === 'preloaded') {
        _abortCrossfade();
        setTimeout(_preloadNextTrack, 200);
    }
    if (currentQueue.length === 0) { closeQueue(); return; }
    _renderQueuePanel();
}

function saveQueueAsSetlist() {
    if (currentQueue.length === 0) return;
    var name = prompt('Name for new setlist:');
    if (!name || !name.trim()) return;
    var now = new Date().toISOString();
    var tracks = currentQueue.map(function (item) {
        return {
            youtubeId: item.youtubeId,
            title: item.title,
            artist: item.artist || '',
            cover: item.cover || '',
            releaseId: item.releaseId || null,
            metaId: item.metaId || null
        };
    });
    openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('setlists', 'readwrite');
            var req = tx.objectStore('setlists').add({
                name: name.trim(),
                created_at: now,
                updated_at: now,
                tracks: tracks,
                notes: ''
            });
            req.onsuccess = function () { resolve(); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    }).then(function () {
        closeQueue();
        showToast('Saved \u201c' + name.trim() + '\u201d \u2014 ' + tracks.length + ' track' + (tracks.length === 1 ? '' : 's'), 'success');
    });
}

