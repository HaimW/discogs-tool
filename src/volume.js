// ============ Volume (F15) ============
//
// One master volume (0-100) and a mute flag, remembered in the `config` store
// as `player_volume` / `player_muted`. _setPlayerVolume() is the only place
// that calls setVolume() on either YouTube player: everything else (the
// crossfade, a new track, a player becoming ready) says what share of the
// master volume a player should have, and _applyVolumeNow() works the shares
// out from the crossfade state, so a change mid-fade rescales both players at
// the current fade position instead of jumping.
//
// YouTube volume behaviour (from the IFrame API docs and how the embed is
// known to behave; not verifiable from the test suite, which uses a fake YT):
// - A new player starts at the volume / mute state the embed remembers for
//   this browser (it keeps its own copy in youtube.com's storage), not at 100.
// - The volume set on a player normally carries over loadVideoById() /
//   cueVideoById() within that player, but this is not guaranteed.
// - setVolume() does not clear a mute: a muted player stays silent at any
//   volume. So on ready each player is unMute()d if it reports isMuted(),
//   mute here is done by volume 0 (never YT mute()), and the master volume is
//   applied again on ready, on every new track and whenever player 1 starts
//   PLAYING.

var masterVolume = 100;      // int 0-100
var masterMuted = false;
var _cfFadeRatio = null;     // 0..1 while a crossfade is fading, else null
var _volumeTouched = false;  // the slider moved before the saved volume loaded
var _mutedTouched = false;   // mute was toggled (or the slider unmuted) before the saved mute loaded
var _volumeLoading = false;  // _loadVolumeSettings() has not resolved yet
var _volumeSavePending = false; // a save was asked for while loading

var VOLUME_CONFIG_KEY = 'player_volume';
var MUTED_CONFIG_KEY = 'player_muted';

// A volume from a slider, the store or a backup: an int 0-100, or `fallback`
// for anything that is not a finite number.
function _clampVolume(v, fallback) {
    var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
}

function _effectiveVolume() {
    return masterMuted ? 0 : masterVolume;
}

// `share`: 0..1 of the effective master volume.
function _setPlayerVolume(p, share) {
    if (!p) return;
    var s = share > 0 ? Math.min(1, share) : 0;
    try { p.setVolume(Math.round(_effectiveVolume() * s)); } catch (e) {}
}

// Sets both players for the current crossfade state:
// - fading: player 1 at (1 - ratio), player 2 at ratio;
// - switching: player 1 is loading the next track silently while player 2,
//   which plays it, carries the full volume until the hand-over;
// - otherwise: player 1 alone.
function _applyVolumeNow() {
    var p1 = 1;
    var p2 = 0;
    if (_cfState === 'fading' && _cfFadeRatio !== null) {
        p1 = 1 - _cfFadeRatio;
        p2 = _cfFadeRatio;
    } else if (_cfState === 'switching') {
        p1 = 0;
        p2 = 1;
    }
    _setPlayerVolume(player, p1);
    _setPlayerVolume(player2, p2);
}

// A player that has just become ready: clear any mute the embed remembered
// (see above), then the master volume applies.
function _initPlayerVolume(p) {
    try { if (p && p.isMuted && p.isMuted()) p.unMute(); } catch (e) {}
    _applyVolumeNow();
}

function setMasterVolume(v) {
    var n = _clampVolume(v, null);
    if (n === null) return;
    masterVolume = n;
    _applyVolumeNow();
    _updateVolumeUI();
}

function setMasterMuted(muted) {
    masterMuted = muted === true;
    _applyVolumeNow();
    _updateVolumeUI();
}

function _loadVolumeSettings() {
    _volumeLoading = true;
    return Promise.all([
        dbGet('config', VOLUME_CONFIG_KEY),
        dbGet('config', MUTED_CONFIG_KEY)
    ]).then(function (results) {
        // A change made while this was loading wins over the stored one;
        // volume and mute are judged separately.
        if (!_volumeTouched) masterVolume = _clampVolume(results[0] && results[0].value, 100);
        if (!_mutedTouched) masterMuted = !!(results[1] && results[1].value === true);
        _applyVolumeNow();
        _updateVolumeUI();
    }).catch(function () {}).then(function () {
        _volumeLoading = false;
        // A save asked for while loading waits until now, so it cannot write
        // the defaults over a stored value the person did not change.
        if (_volumeSavePending) {
            _volumeSavePending = false;
            _saveVolumeSettings();
        }
    });
}

function _saveVolumeSettings() {
    if (_volumeLoading) { _volumeSavePending = true; return; }
    dbPut('config', { key: VOLUME_CONFIG_KEY, value: masterVolume });
    dbPut('config', { key: MUTED_CONFIG_KEY, value: masterMuted });
}

function _updateVolumeUI() {
    if (typeof document === 'undefined') return;
    var btn = document.getElementById('np-mute');
    var slider = document.getElementById('np-volume');
    if (btn) {
        btn.setAttribute('aria-pressed', masterMuted ? 'true' : 'false');
        btn.setAttribute('aria-label', masterMuted ? 'Unmute' : 'Mute');
        btn.title = masterMuted ? 'Unmute' : 'Mute';
        if (btn.classList) btn.classList.toggle('active', masterMuted);
    }
    if (slider) {
        // Muting leaves the slider where it is; unmuting returns to it.
        slider.value = String(masterVolume);
        slider.setAttribute('aria-valuetext', masterMuted ? 'Muted (' + masterVolume + '%)' : masterVolume + '%');
    }
}

// Slider moved: applied at once. Moving it while muted unmutes.
function onVolumeInput(value) {
    if (_clampVolume(value, null) === null) return;
    _volumeTouched = true;
    _mutedTouched = true;
    masterMuted = false;
    setMasterVolume(value);
}

function toggleMute() {
    _mutedTouched = true;
    setMasterMuted(!masterMuted);
    _saveVolumeSettings();
}
