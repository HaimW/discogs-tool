// YouTube IFrame Player API integration
// Persistent bottom player bar with queue support

let player = null;
let playerReady = false;
let currentQueue = [];
let currentIndex = -1;
let isPlaying = false;

// Load YouTube IFrame API
const tag = document.createElement('script');
tag.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(tag);

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player-container', {
        height: '80',
        width: '142',
        playerVars: {
            autoplay: 0,
            controls: 1,
            modestbranding: 1,
            rel: 0,
        },
        events: {
            onReady: function () { playerReady = true; },
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
    } else if (event.data === YT.PlayerState.PAUSED) {
        isPlaying = false;
        updatePlayPauseBtn();
    }
}

function updatePlayPauseBtn() {
    const btn = document.getElementById('np-play-pause');
    if (btn) {
        btn.innerHTML = isPlaying ? '&#10074;&#10074;' : '&#9654;';
    }
}

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
    // Add padding to body so content isn't hidden behind player
    document.body.style.paddingBottom = '100px';

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

// Control buttons
document.addEventListener('DOMContentLoaded', function () {
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
