// ============ Crossfade ============

function _loadCrossfadeSettings() {
    Promise.all([
        dbGet('config', 'crossfade_enabled'),
        dbGet('config', 'crossfade_seconds')
    ]).then(function (results) {
        cfEnabled = results[0] ? results[0].value === true : false;
        cfSeconds = results[1] ? (parseInt(results[1].value, 10) || 5) : 5;
        _updateCfUI();
        if (cfEnabled) _startCfCheckInterval();
    });
}

function _saveCrossfadeSettings() {
    dbPut('config', { key: 'crossfade_enabled', value: cfEnabled });
    dbPut('config', { key: 'crossfade_seconds', value: cfSeconds });
}

function _updateCfUI() {
    var btn = document.getElementById('np-cf-toggle');
    var inp = document.getElementById('np-cf-seconds');
    if (!btn || !inp) return;
    btn.textContent = cfEnabled ? 'CF: ON' : 'CF: OFF';
    if (cfEnabled) {
        btn.classList.add('active');
        inp.style.display = '';
    } else {
        btn.classList.remove('active');
        inp.style.display = 'none';
    }
    inp.value = cfSeconds;
}

function _startCfCheckInterval() {
    if (_cfCheckInterval) return;
    _cfCheckInterval = setInterval(_checkCrossfade, 500);
}

function _stopCfCheckInterval() {
    clearInterval(_cfCheckInterval);
    _cfCheckInterval = null;
}

function _checkCrossfade() {
    if (!cfEnabled || _cfState !== 'preloaded') return;
    if (!playerReady || !player2Ready) return;
    try {
        var duration = player.getDuration();
        var currentTime = player.getCurrentTime();
        if (duration <= 0) return;
        if (duration < cfSeconds + 2) return;
        var timeLeft = duration - currentTime;
        if (timeLeft > 0 && timeLeft <= cfSeconds) {
            _startCrossfade();
        }
    } catch (e) {}
}

function _preloadNextTrack() {
    var nextIndex = currentIndex + 1;
    if (nextIndex >= currentQueue.length) {
        _cfState = 'idle';
        _cfPreloadedIndex = -1;
        return;
    }
    if (!player2Ready) return;
    var nextItem = currentQueue[nextIndex];
    try {
        player2.cueVideoById(nextItem.youtubeId);
        _cfPreloadedIndex = nextIndex;
        _cfState = 'preloaded';
    } catch (e) {}
}

function _startCrossfade() {
    _cfState = 'fading';
    var startVol = 100;
    try { startVol = player.getVolume(); } catch (e) {}
    try {
        player2.setVolume(0);
        player2.playVideo();
    } catch (e) { _abortCrossfade(); return; }
    var steps = Math.ceil(cfSeconds * 1000 / 50);
    var tick = 0;
    _cfFadeInterval = setInterval(function () {
        tick++;
        var ratio = tick / steps;
        var vol1 = Math.round(startVol * (1 - ratio));
        var vol2 = Math.round(100 * ratio);
        try { player.setVolume(vol1); } catch (e) {}
        try { player2.setVolume(vol2); } catch (e) {}
        if (tick >= steps) {
            clearInterval(_cfFadeInterval);
            _cfFadeInterval = null;
            _completeCrossfade();
        }
    }, 50);
}

function _completeCrossfade() {
    _cfState = 'switching';
    var p2Time = 0;
    try { p2Time = player2.getCurrentTime() || 0; } catch (e) {}
    currentIndex = _cfPreloadedIndex;
    var item = currentQueue[currentIndex];
    showNowPlaying(item.title, item.artist, item.cover);
    try {
        player.setVolume(0);
        player.loadVideoById({ videoId: item.youtubeId, startSeconds: p2Time });
    } catch (e) {}
    // Volume restore + player2 stop happen in onPlayerStateChange when player1 fires PLAYING
}

function _abortCrossfade() {
    if (_cfFadeInterval) { clearInterval(_cfFadeInterval); _cfFadeInterval = null; }
    try { player2.pauseVideo(); player2.setVolume(0); } catch (e) {}
    try { player.setVolume(100); } catch (e) {}
    _cfState = 'idle';
    _cfPreloadedIndex = -1;
}

function onPlayer2StateChange(event) {
    if (event.data === YT.PlayerState.ENDED && _cfState === 'fading') {
        _abortCrossfade();
    }
}

