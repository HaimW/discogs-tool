// ============ Player State Persistence ============

function _savePlayerState() {
    if (currentQueue.length === 0) return;
    var currentTime = 0;
    try { currentTime = player.getCurrentTime() || 0; } catch (e) {}
    sessionStorage.setItem('playerState', JSON.stringify({
        queue: currentQueue,
        currentIndex: currentIndex,
        currentTime: currentTime,
        isPlaying: isPlaying,
    }));
}

function _restorePlayerState() {
    var raw = sessionStorage.getItem('playerState');
    if (!raw) return;
    try {
        var state = JSON.parse(raw);
        if (!state.queue || state.queue.length === 0) return;
        currentQueue = state.queue;
        currentIndex = state.currentIndex || 0;
        var item = currentQueue[currentIndex];
        if (!item) return;
        showNowPlaying(item.title, item.artist, item.cover);
        if (state.isPlaying) {
            player.loadVideoById({ videoId: item.youtubeId, startSeconds: state.currentTime || 0 });
            isPlaying = true;
        } else {
            player.cueVideoById({ videoId: item.youtubeId, startSeconds: state.currentTime || 0 });
            isPlaying = false;
        }
        updatePlayPauseBtn();
        if (cfEnabled && state.isPlaying) setTimeout(_preloadNextTrack, 1200);
    } catch (e) { console.warn('Failed to restore player state:', e); }
}

// ============ Music Visualizer ============
