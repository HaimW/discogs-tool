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

// Redraws the queue panel if it is open (L10). Everything that changes
// currentQueue or currentIndex ends here: loadFromQueue (src/player.js) calls
// it for every track change, and the edits that keep the current track (add,
// remove, reorder) call it themselves.
//   opts.reveal - as for _renderQueuePanel; default 'ifHidden' (a new current
//                 track is shown if it is out of view). false leaves the list
//                 exactly where it was.
//   opts.open   - draw the panel even if it is closed (a new shuffle).
function refreshQueuePanel(opts) {
    opts = opts || {};
    if (!opts.open && !document.getElementById('queue-panel')) return;
    if (currentQueue.length === 0) { closeQueue(); return; }
    _renderQueuePanel({ reveal: 'reveal' in opts ? opts.reveal : 'ifHidden' });
}

// Bumped on every draw; a BPM/key read that finishes after a newer draw (or
// after the panel closed) is dropped.
var _queueDrawSeq = 0;
// Whether the last filled draw had any BPM/key. A redraw reserves the column
// from the start, so filling it in does not shift the titles every time.
var _queueShowsMeta = false;

// The row buttons whose focus a redraw puts back (by row and class).
var QUEUE_ROW_BUTTONS = ['queue-play-btn', 'queue-up-btn', 'queue-down-btn', 'queue-remove-btn'];
// Set by moveQueueItem just before it redraws: rows moved, so focus goes to
// the focused track's new place instead of its old index (F17).
var _queueFocusNext = null;

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
        var cls = QUEUE_ROW_BUTTONS.filter(function (c) { return active.classList.contains(c); })[0];
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
//                a row's play / remove / move button, a suggestion queued.
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
        var last = i === currentQueue.length - 1;
        html += '<div class="queue-row' + (isCurrent ? ' queue-current' : '') + '" data-index="' + i + '">';
        // Only the handle starts a row drag (F17), so a press elsewhere on the
        // row, or on the header (which moves the panel), never does. Hidden
        // from screen readers: the move buttons do the same from the keyboard.
        html += '<span class="queue-drag-handle" draggable="true" title="Drag to reorder" aria-hidden="true">&#8942;&#8942;</span>';
        html += '<span class="queue-num">' + (i + 1) + '</span>';
        // BPM and key (F16), filled in once track_meta has been read.
        html += '<span class="queue-meta"></span>';
        if (item.cover) {
            html += '<img class="track-thumb" src="' + escHtml(item.cover) + '" alt="" loading="lazy" draggable="false">';
        } else {
            html += '<div class="track-thumb no-thumb">&#9898;</div>';
        }
        html += '<div class="track-info">' +
            '<div class="track-title-line">' + escHtml(item.title) + '</div>' +
            '<div class="track-sub-line">' + escHtml(item.artist) + '</div>' +
            '</div>';
        // Move up / down (F17): the keyboard and touch way to reorder. At the
        // ends they stay focusable (aria-disabled, not disabled), so focus is
        // not lost when a track reaches the top or bottom.
        html += '<div class="queue-actions">' +
            '<button class="btn queue-play-btn"' + act('click', 'playFromQueuePanel', [i]) + ' title="Play from here">&#9654;</button>' +
            '<span class="queue-move">' +
            '<button class="btn queue-up-btn"' + act('click', 'moveQueueItem', [i, i - 1]) + (i === 0 ? ' aria-disabled="true"' : '') +
                ' title="Move up (Alt+Up)" aria-label="Move ' + escHtml(item.title) + ' up">&#9650;</button>' +
            '<button class="btn queue-down-btn"' + act('click', 'moveQueueItem', [i, i + 1]) + (last ? ' aria-disabled="true"' : '') +
                ' title="Move down (Alt+Down)" aria-label="Move ' + escHtml(item.title) + ' down">&#9660;</button>' +
            '</span>' +
            '<button class="btn queue-remove-btn"' + act('click', 'removeFromQueuePanel', [i]) + ' title="Remove">&times;</button>' +
            '</div>';
        html += '</div>';
    });
    html += '</div>';

    panel.innerHTML = html;
    document.body.appendChild(panel);
    makeDraggable(panel, prev && prev.drag);
    var focus = prev ? (_queueFocusNext || prev.focus) : null;
    _queueFocusNext = null;

    var npBtn = document.getElementById('np-queue');
    if (npBtn) npBtn.classList.add('active');

    // Done straight away rather than on a timer, so nothing moves after the
    // user has seen the list.
    var list = panel.querySelector('.queue-list');
    if (list) {
        if (prev && reveal !== 'open') list.scrollTop = prev.scrollTop;
        var cur = reveal ? list.querySelector('.queue-current') : null;
        if (cur) _revealQueueRow(list, cur, reveal === 'open');
        if (focus) _restoreQueueFocus(panel, list, focus);
        _initQueueReorder(list);
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
    // The row was just clicked, so it is in view: leave the list alone.
    loadFromQueue(currentIndex, { reveal: false });
}

// Drops player 2's cued track and cues the new next one shortly after. One
// pending timer for the page: a burst of removes or moves (Alt+Down held
// down) cues once, after the last of them, not once per step.
var _queueRecueTimer = null;
function _queueRecue() {
    _abortCrossfade();
    clearTimeout(_queueRecueTimer);
    _queueRecueTimer = setTimeout(function () {
        _queueRecueTimer = null;
        _preloadNextTrack();
    }, 200);
}

function removeFromQueuePanel(idx) {
    if (idx < 0 || idx >= currentQueue.length) return;
    currentQueue.splice(idx, 1);
    if (currentIndex > idx) currentIndex--;
    else if (currentIndex === idx && currentIndex >= currentQueue.length) currentIndex = Math.max(0, currentQueue.length - 1);
    _savePlayerState();
    if (cfEnabled && _cfState === 'preloaded') _queueRecue();
    if (currentQueue.length === 0) { closeQueue(); return; }
    refreshQueuePanel({ reveal: false });
}

// ---- Reordering (F17) ----

// The row being dragged: its index when the drag began and the entry itself,
// so a redraw during the drag (a track ended) cannot make it move the wrong
// one. Module-wide rather than per list for the same reason.
var _queueDrag = null;
var QUEUE_DRAG_TYPE = 'application/x-vcp-queue-row';

// Drag and drop by the handle (the pattern of initSetlistDragDrop in
// src/setlists.js: a line above or below the row under the pointer shows where
// it will land), and Alt+Up / Alt+Down on any focused row button. Listeners
// sit on the list, so they go when a redraw replaces it.
function _initQueueReorder(list) {
    function rowOf(e) {
        var r = e.target && e.target.closest ? e.target.closest('.queue-row') : null;
        return r && list.contains(r) ? r : null;
    }
    function clearOver() {
        list.querySelectorAll('.drag-over-above, .drag-over-below').forEach(function (r) {
            r.classList.remove('drag-over-above', 'drag-over-below');
        });
    }
    function below(row, e) {
        var rect = row.getBoundingClientRect();
        return e.clientY >= rect.top + rect.height / 2;
    }
    // Whether this is our own row drag. _queueDrag alone is not enough: if a
    // redraw removes the dragged row, the browser may never send dragend, and
    // a later file or text dragged over the list would then move the stale
    // entry. A row drag always carries the private type; nothing else does.
    function ours(e) {
        return !!_queueDrag && !!e.dataTransfer &&
            Array.prototype.indexOf.call(e.dataTransfer.types || [], QUEUE_DRAG_TYPE) >= 0;
    }

    list.addEventListener('dragstart', function (e) {
        _queueDrag = null; // whatever a lost dragend left behind
        var handle = e.target && e.target.closest ? e.target.closest('.queue-drag-handle') : null;
        var row = handle ? rowOf(e) : null;
        if (!row) return;
        var from = parseInt(row.dataset.index, 10);
        _queueDrag = { from: from, item: currentQueue[from] };
        e.dataTransfer.effectAllowed = 'move';
        // Firefox starts a drag only with some data; a private type means
        // dropping it on a text field elsewhere inserts nothing.
        try { e.dataTransfer.setData(QUEUE_DRAG_TYPE, String(from)); } catch (err) {}
        if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2);
        setTimeout(function () { row.classList.add('dragging'); }, 0);
    });
    list.addEventListener('dragover', function (e) {
        if (!ours(e)) return;
        var row = rowOf(e);
        if (!row) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearOver();
        row.classList.add(below(row, e) ? 'drag-over-below' : 'drag-over-above');
    });
    list.addEventListener('dragleave', function (e) {
        var row = rowOf(e);
        if (row && !row.contains(e.relatedTarget)) row.classList.remove('drag-over-above', 'drag-over-below');
    });
    list.addEventListener('drop', function (e) {
        if (!ours(e)) return;
        var drag = _queueDrag;
        e.preventDefault();
        clearOver();
        _queueDrag = null;
        var row = rowOf(e);
        if (!row) return;
        var from = currentQueue[drag.from] === drag.item ? drag.from : currentQueue.indexOf(drag.item);
        if (from < 0) return;
        var to = parseInt(row.dataset.index, 10) + (below(row, e) ? 1 : 0);
        if (from < to) to--;
        moveQueueItem(from, to);
    });
    list.addEventListener('dragend', function () {
        _queueDrag = null;
        clearOver();
        list.querySelectorAll('.dragging').forEach(function (r) { r.classList.remove('dragging'); });
    });
    list.addEventListener('keydown', function (e) {
        if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        var row = rowOf(e);
        if (!row) return;
        e.preventDefault();
        var i = parseInt(row.dataset.index, 10);
        moveQueueItem(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
    });
}

// Screen-reader announcements for moves. One live region for the page, not
// part of the panel, so a redraw does not replace it mid-announcement.
function _queueAnnounce(msg) {
    var el = document.getElementById('queue-live');
    if (!el) {
        el = document.createElement('div');
        el.id = 'queue-live';
        el.className = 'sr-only';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    el.textContent = msg;
}

// Moves queue entry `from` so it ends up at index `to` (F17). The playing
// track keeps playing and stays highlighted: currentIndex follows it, as does
// the crossfade's cued next track; if a different track now comes next, the
// cue is redone (as removeFromQueuePanel does). During a fade the move is
// refused if it would change which track fades in, or what plays after the
// one fading out (queueMovePlayback, src/queue_order.js): the fade lasts
// seconds, a broken one is audible. The list and the panel stay where they
// are; focus stays on the focused track's button.
function moveQueueItem(from, to) {
    var n = currentQueue.length;
    var item = currentQueue[from];
    if (!item) return;
    if (!queueMoveIsValid(n, from, to)) {
        if (to < 0) _queueAnnounce(item.title + ' is already first');
        else if (to >= n) _queueAnnounce(item.title + ' is already last');
        return;
    }
    var res = queueMovePlayback({ cfState: _cfState, currentIndex: currentIndex, preloadedIndex: _cfPreloadedIndex }, from, to);
    if (!res.ok) {
        showToast('Crossfading — move it again once the next track has taken over.');
        return;
    }

    var panel = document.getElementById('queue-panel');
    var active = document.activeElement;
    var focusRow = panel && active && panel.contains(active) && active.closest ? active.closest('.queue-row') : null;
    var cls = focusRow ? QUEUE_ROW_BUTTONS.filter(function (c) { return active.classList.contains(c); })[0] : null;
    // Focus stays on the same track, wherever the move puts it: the moved one
    // for a keyboard or button move, or (after a mouse drag, which focuses
    // nothing) the track that already had focus, not whatever row lands at
    // its old index.
    var focusFrom = focusRow && cls ? parseInt(focusRow.dataset.index, 10) : -1;
    var follow = focusFrom === from;
    if (focusFrom >= 0) _queueFocusNext = { row: queueIndexAfterMove(focusFrom, from, to), cls: cls };

    currentQueue = queueMoved(currentQueue, from, to);
    currentIndex = res.currentIndex;
    _cfPreloadedIndex = res.preloadedIndex;
    // Gated as in removeFromQueuePanel: with crossfade off nothing is cued.
    if (cfEnabled && res.repreload) _queueRecue();
    _savePlayerState();
    refreshQueuePanel({ reveal: false });

    // A keyboard move can take the row past the edge of the list: follow it
    // there, just far enough (the list only, never the page).
    if (follow) {
        var list = document.querySelector('#queue-panel .queue-list');
        var moved = list ? list.children[to] : null;
        if (moved) _revealQueueRow(list, moved, false);
    }
    _queueAnnounce('Moved ' + item.title + ' to position ' + (to + 1) + ' of ' + n);
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
            // Filled from release + video when the item had none (F18).
            metaId: itemMetaId(item)
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

