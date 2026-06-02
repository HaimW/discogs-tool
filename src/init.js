// ============ Init ============

document.addEventListener('DOMContentLoaded', function () {
    _saveInterval = setInterval(function () { if (isPlaying) _savePlayerState(); }, 2000);

    document.getElementById('np-close').addEventListener('click', hideNowPlaying);

    document.getElementById('np-progress-track').addEventListener('click', function (e) {
        if (!player || !playerReady) return;
        var rect = this.getBoundingClientRect();
        var pct = (e.clientX - rect.left) / rect.width;
        try { var dur = player.getDuration(); if (dur) player.seekTo(pct * dur, true); } catch (ex) {}
    });

    document.getElementById('np-viz-toggle').addEventListener('click', function () {
        var viz = document.getElementById('np-visualizer');
        var show = viz.style.display === 'none';
        viz.style.display = show ? 'flex' : 'none';
        this.classList.toggle('active', show);
    });
    document.getElementById('np-play-pause').addEventListener('click', function () {
        if (!player || !playerReady) return;
        if (isPlaying) player.pauseVideo(); else player.playVideo();
    });
    document.getElementById('np-next').addEventListener('click', function () {
        if (currentIndex < currentQueue.length - 1) { currentIndex++; loadFromQueue(currentIndex); if (document.getElementById('queue-panel')) _renderQueuePanel(); }
    });
    document.getElementById('np-prev').addEventListener('click', function () {
        if (currentIndex > 0) { currentIndex--; loadFromQueue(currentIndex); if (document.getElementById('queue-panel')) _renderQueuePanel(); }
    });
    document.getElementById('np-suggest').addEventListener('click', openSuggestions);
    document.getElementById('np-queue').addEventListener('click', openQueue);
    document.getElementById('np-add-setlist').addEventListener('click', function () {
        openNowPlayingAddToSetlist(this);
    });
    document.getElementById('np-goto-release').addEventListener('click', gotoNowPlayingRelease);

    document.getElementById('np-cf-toggle').addEventListener('click', function () {
        cfEnabled = !cfEnabled;
        var secInput = document.getElementById('np-cf-seconds');
        var newSec = parseInt(secInput.value, 10);
        if (!isNaN(newSec) && newSec >= 1) cfSeconds = newSec;
        _updateCfUI();
        _saveCrossfadeSettings();
        if (cfEnabled) {
            _startCfCheckInterval();
            if (isPlaying) _preloadNextTrack();
        } else {
            _stopCfCheckInterval();
            if (_cfState !== 'idle') _abortCrossfade();
        }
    });

    document.getElementById('np-cf-seconds').addEventListener('change', function () {
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 1) { this.value = cfSeconds; return; }
        if (v > 30) { this.value = 30; v = 30; }
        cfSeconds = v;
        _saveCrossfadeSettings();
    });

    _loadCrossfadeSettings();

    updateNotifBadge();
    startMarketplacePoll();

    window.addEventListener('popstate', function () {
        if (_navHistory.length === 0) return;
        var prev = _navHistory.pop();
        _navFromPop = true;
        _currentView = prev.view;
        _filters = prev.filters;
        renderCurrentView();
        window.scrollTo(0, 0);
        _navFromPop = false;
    });

    // Static nav links wired via data-nav attribute
    document.querySelectorAll('[data-nav]').forEach(function (el) {
        el.addEventListener('click', function (e) {
            e.preventDefault();
            navigate(el.getAttribute('data-nav'));
        });
    });
    document.getElementById('sync-btn').addEventListener('click', startSync);
    document.getElementById('notif-bell-btn').addEventListener('click', toggleNotifPanel);

    navigate('collection');
});
