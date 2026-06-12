// ============ YouTube Player ============

var player = null;
var playerReady = false;
var currentQueue = [];
var currentIndex = -1;
var isPlaying = false;
var _saveInterval = null;

// ---- Crossfade state ----
var player2 = null;
var player2Ready = false;
var cfEnabled = false;
var cfSeconds = 5;
var _cfState = 'idle';        // 'idle' | 'preloaded' | 'fading' | 'switching'
var _cfPreloadedIndex = -1;
var _cfFadeInterval = null;
var _cfCheckInterval = null;

// Load YouTube IFrame API
var ytTag = document.createElement('script');
ytTag.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(ytTag);

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player-container', {
        height: '270',
        width: '480',
        playerVars: { autoplay: 0, controls: 1, rel: 0, enablejsapi: 1, origin: window.location.origin, playsinline: 1, cc_load_policy: 0 },
        events: {
            onReady: function () {
                playerReady = true;
                _restorePlayerState();
            },
            onStateChange: onPlayerStateChange,
            onError: onPlayerError,
        },
    });
    player2 = new YT.Player('player2-container', {
        height: '1',
        width: '1',
        playerVars: { autoplay: 0, controls: 0, rel: 0, enablejsapi: 1, origin: window.location.origin, playsinline: 1, cc_load_policy: 0 },
        events: {
            onReady: function () { player2Ready = true; },
            onStateChange: onPlayer2StateChange,
            onError: function () { _abortCrossfade(); },
        },
    });
}

function onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.ENDED) {
        // Ignore ENDED while crossfade is actively fading or switching players
        if (_cfState === 'fading' || _cfState === 'switching') return;
        // Clean up unused preload if track ended before crossfade could start
        if (_cfState === 'preloaded') _abortCrossfade();
        if (currentIndex < currentQueue.length - 1) {
            currentIndex++;
            loadFromQueue(currentIndex);
            if (document.getElementById('queue-panel')) _renderQueuePanel();
        } else {
            isPlaying = false;
            stopViz();
            _stopProgressUpdate();
            updatePlayPauseBtn();
        }
    } else if (event.data === YT.PlayerState.PLAYING) {
        // Complete crossfade handoff: player1 is now playing the new track
        if (_cfState === 'switching') {
            player.setVolume(100);
            try { player2.pauseVideo(); player2.setVolume(0); } catch (e) {}
            _cfState = 'idle';
            _cfPreloadedIndex = -1;
            isPlaying = true;
            updatePlayPauseBtn();
            _savePlayerState();
            if (cfEnabled) setTimeout(_preloadNextTrack, 800);
            if (document.getElementById('queue-panel')) _renderQueuePanel();
            return;
        }
        isPlaying = true;
        startViz();
        _startProgressUpdate();
        updatePlayPauseBtn();
        _savePlayerState();
    } else if (event.data === YT.PlayerState.PAUSED) {
        isPlaying = false;
        stopViz();
        _stopProgressUpdate();
        updatePlayPauseBtn();
        _savePlayerState();
    }
}

function onPlayerError(event) {
    // error codes 100/101/150 = video removed or not embeddable; 2 = bad ID
    console.warn('YouTube player error', event.data, 'on track index', currentIndex);
    if (_cfState === 'fading' || _cfState === 'switching') _abortCrossfade();
    if (currentIndex < currentQueue.length - 1) {
        currentIndex++;
        loadFromQueue(currentIndex);
        if (document.getElementById('queue-panel')) _renderQueuePanel();
    } else {
        isPlaying = false;
        stopViz();
        updatePlayPauseBtn();
    }
}

function updatePlayPauseBtn() {
    var btn = document.getElementById('np-play-pause');
    if (btn) btn.innerHTML = isPlaying ? '&#10074;&#10074;' : '&#9654;';
}

function showNowPlaying(title, artist, coverUrl) {
    var bar = document.getElementById('now-playing');
    document.getElementById('np-title').textContent = title;
    document.getElementById('np-artist').textContent = artist || '';
    var cover = document.getElementById('np-cover');
    if (coverUrl) { cover.src = coverUrl; cover.style.display = 'block'; }
    else { cover.style.display = 'none'; }
    bar.style.display = 'flex';
    document.body.style.paddingBottom = '116px';
    _resetProgress();
    highlightActiveTrack();
}

function hideNowPlaying() {
    // Abort any in-flight crossfade first: player2 may be audibly playing,
    // and a pending _completeCrossfade() would read from the cleared queue.
    if (_cfState !== 'idle') _abortCrossfade();
    stopViz();
    document.getElementById('now-playing').style.display = 'none';
    document.body.style.paddingBottom = '0';
    if (player && playerReady) player.stopVideo();
    isPlaying = false;
    currentQueue = [];
    currentIndex = -1;
    sessionStorage.removeItem('playerState');
    highlightActiveTrack();
    closeSuggestions();
    closeQueue();
}

function highlightActiveTrack() {
    document.querySelectorAll('.video-item').forEach(function (el) { el.classList.remove('playing'); });
    if (currentIndex >= 0 && currentQueue[currentIndex]) {
        var ytId = currentQueue[currentIndex].youtubeId;
        document.querySelectorAll('.video-item').forEach(function (el) {
            if (el.dataset.youtubeId === ytId) el.classList.add('playing');
        });
    }
}

function loadFromQueue(index) {
    var item = currentQueue[index];
    if (!item || !playerReady) return;
    if (_cfState !== 'idle') _abortCrossfade();
    player.setVolume(100);
    player.loadVideoById(item.youtubeId);
    showNowPlaying(item.title, item.artist, item.cover);
    isPlaying = true;
    updatePlayPauseBtn();
    _savePlayerState();
    if (cfEnabled) {
        _cfState = 'idle';
        _cfPreloadedIndex = -1;
        setTimeout(_preloadNextTrack, 800);
    }
}

function playTrack(element) {
    if (!playerReady) return;
    var allItems = document.querySelectorAll('.video-item');
    currentQueue = [];
    var startIndex = 0;
    allItems.forEach(function (el, i) {
        currentQueue.push({
            youtubeId: el.dataset.youtubeId,
            releaseId: el.dataset.releaseId || null,
            title: el.dataset.title,
            artist: el.dataset.artist || '',
            cover: el.dataset.cover || '',
        });
        if (el === element) startIndex = i;
    });
    currentIndex = startIndex;
    loadFromQueue(currentIndex);
}

function playAll() {
    var allItems = document.querySelectorAll('.video-item');
    if (allItems.length === 0) return;
    currentQueue = [];
    allItems.forEach(function (el) {
        currentQueue.push({
            youtubeId: el.dataset.youtubeId,
            releaseId: el.dataset.releaseId || null,
            title: el.dataset.title,
            artist: el.dataset.artist || '',
            cover: el.dataset.cover || '',
        });
    });
    currentIndex = 0;
    loadFromQueue(0);
}

function playAllFromRelease(releaseId) {
    dbGetByIndex('videos', 'release_id', releaseId).then(function (videos) {
        if (videos.length === 0) return;
        return dbGet('releases', releaseId).then(function (r) {
            videos.sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
            currentQueue = videos.map(function (v) {
                return {
                    youtubeId: v.youtube_id,
                    title: v.title,
                    artist: r ? r.artist : '',
                    cover: r ? (r.thumb_url || '') : '',
                };
            });
            currentIndex = 0;
            loadFromQueue(0);
        });
    });
}

function shufflePlay(limitOverride) {
    if (!playerReady) return;
    dbGetAll('releases').then(function (allReleases) {
        // Apply current filters
        var filtered = allReleases;
        var q = (_filters.q || '').toLowerCase();
        if (q) filtered = filtered.filter(function (r) {
            return r.artist.toLowerCase().indexOf(q) !== -1 || r.title.toLowerCase().indexOf(q) !== -1;
        });
        if (_filters.genre) filtered = filtered.filter(function (r) {
            return r.genres && r.genres.indexOf(_filters.genre) !== -1;
        });
        if (_filters.folder) {
            var fid = parseInt(_filters.folder);
            filtered = filtered.filter(function (r) {
                return r.folder_ids && r.folder_ids.indexOf(fid) !== -1;
            });
        }
        if (_filters.country) {
            filtered = filtered.filter(function (r) {
                return r.country === _filters.country;
            });
        }

        var ids = filtered.map(function (r) { return r.id; });
        if (ids.length === 0) { alert('No releases match the current filters.'); return; }

        // Fetch all videos for these releases
        dbGetAll('videos').then(function (allVideos) {
            var matchingVideos = allVideos.filter(function (v) {
                return v.youtube_id && ids.indexOf(v.release_id) !== -1;
            });
            if (matchingVideos.length === 0) { alert('No videos found. Try syncing first.'); return; }

            // Build release lookup
            var relMap = {};
            filtered.forEach(function (r) { relMap[r.id] = r; });

            // Shuffle (Fisher-Yates)
            for (var i = matchingVideos.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = matchingVideos[i];
                matchingVideos[i] = matchingVideos[j];
                matchingVideos[j] = tmp;
            }

            // Determine limit
            var limit;
            if (typeof limitOverride === 'number') {
                limit = limitOverride;
            } else {
                var inputEl = document.getElementById('shuffle-count');
                var parsed = inputEl ? parseInt(inputEl.value, 10) : NaN;
                limit = (!isNaN(parsed) && parsed >= 1) ? parsed : 50;
            }
            var selected = (limit === Infinity || limit >= matchingVideos.length)
                ? matchingVideos
                : matchingVideos.slice(0, limit);
            currentQueue = selected.map(function (v) {
                var r = relMap[v.release_id] || {};
                return {
                    youtubeId: v.youtube_id,
                    title: v.title,
                    artist: r.artist || '',
                    cover: r.thumb_url || '',
                };
            });
            currentIndex = 0;
            loadFromQueue(0);
            _renderQueuePanel();  // Auto-open queue so the shuffled list is immediately visible
        });
    });
}

function shufflePlayAll() {
    shufflePlay(Infinity);
}

// ---- Progress bar ----

var _progressInterval = null;

function _fmtTime(s) {
    s = Math.floor(s || 0);
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function _startProgressUpdate() {
    if (_progressInterval) return;
    _progressInterval = setInterval(function () {
        if (!player || !playerReady) return;
        try {
            var dur = player.getDuration();
            var cur = player.getCurrentTime();
            if (!dur) return;
            var fill = document.getElementById('np-progress-fill');
            if (fill) fill.style.width = ((cur / dur) * 100) + '%';
            var timeEl = document.getElementById('np-time');
            if (timeEl) timeEl.textContent = _fmtTime(cur) + ' / ' + _fmtTime(dur);
        } catch (e) {}
    }, 500);
}

function _stopProgressUpdate() {
    if (_progressInterval) { clearInterval(_progressInterval); _progressInterval = null; }
}

function _resetProgress() {
    _stopProgressUpdate();
    var fill = document.getElementById('np-progress-fill');
    if (fill) { fill.style.transition = 'none'; fill.style.width = '0%'; }
    var timeEl = document.getElementById('np-time');
    if (timeEl) timeEl.textContent = '0:00 / 0:00';
    setTimeout(function () {
        if (fill) fill.style.transition = '';
    }, 50);
}

