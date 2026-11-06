// A fake YouTube IFrame API for the browser tests. The real one is blocked
// (fixtures.js aborts every off-origin request), so this is installed with
// page.addInitScript(installFakeYT) before the app loads. Its players record
// every volume they are set to and are exposed as window.__ytPlayers
// ([0] = player 1, [1] = the crossfade's player 2). Tests drive playback state
// and the playhead through them: player.fire(state) reports a state change the
// way YouTube does; player.events.onError({ data: 150 }) an unplayable video.
function installFakeYT() {
    const players = [];
    window.__ytPlayers = players;
    function FakePlayer(elementId, opts) {
        const self = this;
        self.elementId = elementId;
        self.volume = 100;
        // A remembered YouTube-level mute, as the real embed can restore one:
        // the app has to clear it on ready.
        self.muted = true;
        self.volumes = [];
        self.state = -1;
        self.videoId = null;
        self.duration = 300;
        self.time = 0;
        self.events = (opts && opts.events) || {};
        players.push(self);
        setTimeout(function () { if (self.events.onReady) self.events.onReady({ target: self }); }, 0);
    }
    FakePlayer.prototype = {
        setVolume(v) { this.volume = v; this.volumes.push(v); },
        getVolume() { return this.volume; },
        mute() { this.muted = true; },
        unMute() { this.muted = false; },
        isMuted() { return this.muted; },
        loadVideoById(arg) {
            this.videoId = typeof arg === 'string' ? arg : arg.videoId;
            this.time = (arg && arg.startSeconds) || 0;
            this.state = 3;
        },
        cueVideoById(arg) {
            this.videoId = typeof arg === 'string' ? arg : arg.videoId;
            this.time = (arg && arg.startSeconds) || 0;
            this.state = 5;
        },
        playVideo() { this.state = 1; },
        pauseVideo() { this.state = 2; },
        stopVideo() { this.state = 0; },
        seekTo(t) { this.time = t; },
        getDuration() { return this.duration; },
        getCurrentTime() { return this.time; },
        getPlayerState() { return this.state; },
        // Test hook: report a state change the way YouTube does.
        fire(state) {
            this.state = state;
            if (this.events.onStateChange) this.events.onStateChange({ target: this, data: state });
        },
    };
    window.YT = {
        Player: FakePlayer,
        PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    };
    // The real API calls this once its script has loaded; that script is
    // blocked here, so call it once the app has defined it.
    document.addEventListener('DOMContentLoaded', function () {
        if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
    });
}

module.exports = { installFakeYT };
