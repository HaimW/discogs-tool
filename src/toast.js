// ============ Toasts (P6) ============
//
// Short, non-blocking messages in place of alert() and of the sync banner
// borrowed for one-off notices ("Added to …", "Removed from want list"), which
// also overwrote a running sync's progress. The sync banner is for syncs only.
//
//   showToast('Saved')                      // info, 3 s
//   showToast('Restored 12 releases', 'success')
//   showToast('Restore failed: …', 'error') // 7 s, announced assertively
//
// Click a toast to dismiss it early.

var TOAST_MAX = 4;
var TOAST_MS = { info: 3000, success: 3000, error: 7000 };

function _toastRegion() {
    var region = document.getElementById('toast-region');
    if (!region) {
        region = document.createElement('div');
        region.id = 'toast-region';
        region.className = 'toast-region';
        document.body.appendChild(region);
    }
    return region;
}

function showToast(message, kind, durationMs) {
    kind = TOAST_MS[kind] ? kind : 'info';
    var region = _toastRegion();
    var t = document.createElement('div');
    t.className = 'toast toast-' + kind;
    // Errors interrupt a screen reader; the rest wait their turn.
    t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    t.textContent = String(message);
    t.addEventListener('click', function () { _dismissToast(t); });
    region.appendChild(t);
    while (region.children.length > TOAST_MAX) region.removeChild(region.firstChild);
    setTimeout(function () { _dismissToast(t); }, durationMs || TOAST_MS[kind]);
    return t;
}

function _dismissToast(t) {
    if (!t.parentNode || t.classList.contains('toast-leaving')) return;
    t.classList.add('toast-leaving');
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 200);
}
