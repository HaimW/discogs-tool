// ============ Queue Panel ============

function makeDraggable(panel) {
    var header = panel.querySelector('.queue-header');
    if (!header) return;
    var isDragging = false, ox = 0, oy = 0;
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

function _renderQueuePanel() {
    var existing = document.getElementById('queue-panel');
    if (existing) existing.remove();

    var panel = document.createElement('div');
    panel.id = 'queue-panel';
    panel.className = 'queue-panel';

    var html = '<div class="queue-header">' +
        '<span class="queue-title">&#9776; Queue &mdash; ' + currentQueue.length + ' track' + (currentQueue.length === 1 ? '' : 's') + '</span>' +
        '<div class="queue-header-actions">' +
        '<button class="btn" onclick="saveQueueAsSetlist()">Save as setlist</button>' +
        '<button class="meta-btn" onclick="closeQueue()" title="Close">&times;</button>' +
        '</div></div>';

    html += '<div class="queue-list">';
    currentQueue.forEach(function (item, i) {
        var isCurrent = (i === currentIndex);
        html += '<div class="queue-row' + (isCurrent ? ' queue-current' : '') + '">';
        html += '<span class="queue-num">' + (i + 1) + '</span>';
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
            '<button class="btn queue-play-btn" onclick="playFromQueuePanel(' + i + ')" title="Play from here">&#9654;</button>' +
            '<button class="btn queue-remove-btn" onclick="removeFromQueuePanel(' + i + ')" title="Remove">&times;</button>' +
            '</div>';
        html += '</div>';
    });
    html += '</div>';

    panel.innerHTML = html;
    document.body.appendChild(panel);
    makeDraggable(panel);

    var npBtn = document.getElementById('np-queue');
    if (npBtn) npBtn.classList.add('active');

    // Scroll current track into view
    setTimeout(function () {
        var cur = panel.querySelector('.queue-current');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
    }, 50);
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
        showSyncBanner('Saved \u201c' + name.trim() + '\u201d \u2014 ' + tracks.length + ' track' + (tracks.length === 1 ? '' : 's'));
        setTimeout(hideSyncBanner, 2000);
    });
}

