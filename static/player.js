// YouTube IFrame Player API integration
// Persistent bottom player bar with queue support
// State persisted via sessionStorage across page navigations

let player = null;
let playerReady = false;
let currentQueue = [];
let currentIndex = -1;
let isPlaying = false;
let _saveInterval = null;

// Load YouTube IFrame API
const tag = document.createElement('script');
tag.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(tag);

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player-container', {
        height: '200',
        width: '356',
        playerVars: {
            autoplay: 0,
            controls: 1,
            modestbranding: 1,
            rel: 0,
        },
        events: {
            onReady: function () {
                playerReady = true;
                _restoreState();
            },
            onStateChange: onPlayerStateChange,
        },
    });
}

function onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.ENDED) {
        // Auto-advance to next track
        if (currentIndex < currentQueue.length - 1) {
            currentIndex++;
            loadFromQueue(currentIndex);
        } else {
            isPlaying = false;
            updatePlayPauseBtn();
        }
    } else if (event.data === YT.PlayerState.PLAYING) {
        isPlaying = true;
        updatePlayPauseBtn();
        _saveState();
    } else if (event.data === YT.PlayerState.PAUSED) {
        isPlaying = false;
        updatePlayPauseBtn();
        _saveState();
    }
}

function updatePlayPauseBtn() {
    const btn = document.getElementById('np-play-pause');
    if (btn) {
        btn.innerHTML = isPlaying ? '&#10074;&#10074;' : '&#9654;';
    }
}

// --- State persistence via sessionStorage ---

function _saveState() {
    if (currentQueue.length === 0) return;
    var currentTime = 0;
    try { currentTime = player.getCurrentTime() || 0; } catch (e) {}
    var state = {
        queue: currentQueue.map(function (item) {
            return {
                youtubeId: item.youtubeId,
                title: item.title,
                artist: item.artist,
                cover: item.cover,
            };
        }),
        currentIndex: currentIndex,
        currentTime: currentTime,
        isPlaying: isPlaying,
    };
    sessionStorage.setItem('playerState', JSON.stringify(state));
}

function _restoreState() {
    var raw = sessionStorage.getItem('playerState');
    if (!raw) return;
    try {
        var state = JSON.parse(raw);
        if (!state.queue || state.queue.length === 0) return;

        currentQueue = state.queue.map(function (item) {
            return {
                youtubeId: item.youtubeId,
                title: item.title,
                artist: item.artist,
                cover: item.cover,
                element: null,
            };
        });
        currentIndex = state.currentIndex || 0;

        var item = currentQueue[currentIndex];
        if (!item) return;

        // Show the bar and load the video
        showNowPlaying(item.title, item.artist, item.cover);

        if (state.isPlaying) {
            player.loadVideoById({
                videoId: item.youtubeId,
                startSeconds: state.currentTime || 0,
            });
            isPlaying = true;
        } else {
            player.cueVideoById({
                videoId: item.youtubeId,
                startSeconds: state.currentTime || 0,
            });
            isPlaying = false;
        }
        updatePlayPauseBtn();
    } catch (e) {
        console.warn('Failed to restore player state:', e);
    }
}

function _startSaveInterval() {
    if (_saveInterval) return;
    _saveInterval = setInterval(function () {
        if (isPlaying) _saveState();
    }, 2000);
}

// --- Now Playing UI ---

function showNowPlaying(title, artist, coverUrl) {
    const bar = document.getElementById('now-playing');
    document.getElementById('np-title').textContent = title;
    document.getElementById('np-artist').textContent = artist || '';
    const cover = document.getElementById('np-cover');
    if (coverUrl) {
        cover.src = coverUrl;
        cover.style.display = 'block';
    } else {
        cover.style.display = 'none';
    }
    bar.style.display = 'flex';
    document.body.style.paddingBottom = '220px';

    // Highlight active track in list
    document.querySelectorAll('.video-item').forEach(function (el) {
        el.classList.remove('playing');
    });
    if (currentIndex >= 0 && currentQueue[currentIndex]) {
        const activeEl = currentQueue[currentIndex].element;
        if (activeEl) activeEl.classList.add('playing');
    }
}

function hideNowPlaying() {
    const bar = document.getElementById('now-playing');
    bar.style.display = 'none';
    document.body.style.paddingBottom = '0';
    if (player && playerReady) {
        player.stopVideo();
    }
    isPlaying = false;
    currentQueue = [];
    currentIndex = -1;
    sessionStorage.removeItem('playerState');
    document.querySelectorAll('.video-item').forEach(function (el) {
        el.classList.remove('playing');
    });
}

function loadFromQueue(index) {
    const item = currentQueue[index];
    if (!item || !playerReady) return;

    player.loadVideoById(item.youtubeId);
    showNowPlaying(item.title, item.artist, item.cover);
    isPlaying = true;
    updatePlayPauseBtn();
    _saveState();
}

// Called when clicking a single track's play button
function playTrack(element) {
    if (!playerReady) {
        console.warn('YouTube player not ready yet');
        return;
    }

    const youtubeId = element.dataset.youtubeId;
    const title = element.dataset.title;
    const artist = element.dataset.artist || '';
    const cover = element.dataset.cover || '';

    // Build queue from all tracks on the page, starting from clicked one
    const allItems = document.querySelectorAll('.video-item');
    currentQueue = [];
    let startIndex = 0;

    allItems.forEach(function (el, i) {
        currentQueue.push({
            youtubeId: el.dataset.youtubeId,
            title: el.dataset.title,
            artist: el.dataset.artist || '',
            cover: el.dataset.cover || '',
            element: el,
        });
        if (el === element) startIndex = i;
    });

    currentIndex = startIndex;
    loadFromQueue(currentIndex);
}

// Called when clicking "Play All"
function playAll() {
    const allItems = document.querySelectorAll('.video-item');
    if (allItems.length === 0) return;

    currentQueue = [];
    allItems.forEach(function (el) {
        currentQueue.push({
            youtubeId: el.dataset.youtubeId,
            title: el.dataset.title,
            artist: el.dataset.artist || '',
            cover: el.dataset.cover || '',
            element: el,
        });
    });

    currentIndex = 0;
    loadFromQueue(0);
}

// Called when clicking "Shuffle Play" on the collection page
function shufflePlay() {
    if (!playerReady) {
        console.warn('YouTube player not ready yet');
        return;
    }

    // Read current filter params from the URL
    var params = new URLSearchParams(window.location.search);
    var url = '/api/random-playlist?limit=50';
    if (params.get('q')) url += '&q=' + encodeURIComponent(params.get('q'));
    if (params.get('genre')) url += '&genre=' + encodeURIComponent(params.get('genre'));
    if (params.get('folder')) url += '&folder=' + encodeURIComponent(params.get('folder'));

    fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (videos) {
            if (!videos || videos.length === 0) {
                alert('No videos found for the current filters.');
                return;
            }

            currentQueue = videos.map(function (v) {
                return {
                    youtubeId: v.youtube_id,
                    title: v.title,
                    artist: v.artist,
                    cover: v.cover || '',
                    element: null,
                };
            });

            currentIndex = 0;
            loadFromQueue(0);
        })
        .catch(function (err) {
            console.error('Shuffle failed:', err);
        });
}

// Control buttons
document.addEventListener('DOMContentLoaded', function () {
    _startSaveInterval();

    document.getElementById('np-close').addEventListener('click', hideNowPlaying);

    document.getElementById('np-play-pause').addEventListener('click', function () {
        if (!player || !playerReady) return;
        if (isPlaying) {
            player.pauseVideo();
        } else {
            player.playVideo();
        }
    });

    document.getElementById('np-next').addEventListener('click', function () {
        if (currentIndex < currentQueue.length - 1) {
            currentIndex++;
            loadFromQueue(currentIndex);
        }
    });

    document.getElementById('np-prev').addEventListener('click', function () {
        if (currentIndex > 0) {
            currentIndex--;
            loadFromQueue(currentIndex);
        }
    });

    // Sync status polling
    pollSyncStatus();
});

// Poll sync status when sync is running
function pollSyncStatus() {
    const banner = document.getElementById('sync-banner');
    const msgEl = document.getElementById('sync-message');
    const syncBtn = document.getElementById('sync-btn');

    function check() {
        fetch('/sync/status')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.running) {
                    banner.style.display = 'flex';
                    msgEl.textContent = data.message || 'Syncing...';
                    if (syncBtn) syncBtn.disabled = true;
                    setTimeout(check, 2000);
                } else {
                    if (banner.style.display === 'flex' && data.message) {
                        // Sync just finished, reload to show new data
                        msgEl.textContent = data.message;
                        setTimeout(function () { window.location.reload(); }, 1500);
                    } else {
                        banner.style.display = 'none';
                    }
                    if (syncBtn) syncBtn.disabled = false;
                }
            })
            .catch(function () {
                setTimeout(check, 5000);
            });
    }

    check();
}
