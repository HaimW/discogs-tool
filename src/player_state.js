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
        // Always come back paused at the saved position (M4): a reload, a
        // restored tab, or the reload another tab's DB upgrade forces should
        // never start sound on its own. Play resumes from here.
        player.cueVideoById({ videoId: item.youtubeId, startSeconds: state.currentTime || 0 });
        isPlaying = false;
        updatePlayPauseBtn();
        // Cueing the next track is silent, and keeps the crossfade ready for
        // when play is pressed.
        if (cfEnabled) setTimeout(_preloadNextTrack, 1200);
    } catch (e) { console.warn('Failed to restore player state:', e); }
}

// ============ Music Visualizer ============
