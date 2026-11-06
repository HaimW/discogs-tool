// ============ View loading and error states (P6) ============
//
// Every view reads IndexedDB and then draws #app. The router runs each render
// through runViewRender(), which adds what used to be missing around it:
//
// - Loading: nothing is shown for the first VIEW_LOADING_DELAY_MS, so a fast
//   view never flashes a spinner. After that, #app is marked aria-busy and
//   "Loading …" is put in #view-status (a polite role=status region outside
//   #app, since a busy region's own changes are not announced). A move to
//   another view also replaces #app with a loading block; a refresh of the
//   view already on screen keeps its content (only dimmed), so the page does
//   not collapse and lose its scroll position.
// - Errors: a render that throws or rejects is logged with console.error and
//   replaced by a message with a "Try again" button (re-runs the router).
//   Nothing is swallowed.
// - Races: only the newest run may show loading or error UI, and each view
//   takes a token from startViewRender(view) and draws only if it is still the
//   newest render and its view is still the one routed to, so a slow older
//   render (or a background refresh of a view the user has left) cannot
//   overwrite a newer one.
// - Direct re-renders: a view called outside the router (a filter click, a
//   sync or poll refresh) gets no loading delay, but it passes its promise
//   through endViewRender(), which gives it the same error screen and, if it
//   superseded a router run that was still loading, clears that loading state
//   once it settles. The router run then leaves the loading state alone.
//   One for a view the user has already left (or for another release or
//   setlist than the one now routed to) gets a dead token: it draws
//   nothing and does not disturb the render of the view now routed to.

var VIEW_LOADING_DELAY_MS = 250;

var _viewRun = 0;          // router runs (runViewRender)
var _viewRenderSeq = 0;    // view renders, router-driven or direct
// About the newest view render only (the only one allowed to draw):
var _viewRenderRun = 0;    // router run it belongs to; 0 = a direct re-render
var _viewRenderView = null; // the view it draws (null: no route check)
var _viewRenderKey = null;  // the release / setlist id it draws, as a string (null: any)
var _viewRenderDone = true; // settled (a direct render that is still reading: false)
var _claimingRun = 0;      // set while the router calls its view (claim() in runViewRender)
var _loadingUp = false;    // a loading state is on screen (whichever run put it there)

// Called by a view before it starts reading; returns its token. `view` is the
// route name it draws ('tracks'), and `key` the one item it draws, if any (a
// release or setlist id; see currentRouteKey in src/router.js); both are
// checked again before it draws. A direct re-render for a view the user has
// already left (a setlist's save landing after a move to the store, or to
// another setlist) gets a dead token: it must not supersede the render of the
// view now routed to, which would then never draw.
var DEAD_VIEW_TOKEN = -1;
function startViewRender(view, key) {
    if (!_claimingRun && view && !_isRoutedTo(view, key)) {
        return DEAD_VIEW_TOKEN;
    }
    _viewRenderRun = _claimingRun;
    _claimingRun = 0;   // only the router's own view, not anything it calls
    _viewRenderView = view || null;
    _viewRenderKey = view && key != null ? String(key) : null;
    _viewRenderDone = true;
    return ++_viewRenderSeq;
}

// Is the route on `view` (and, given a key, on that item)? Ids compare as
// strings: a release id may be a number here and a string in the route.
function _isRoutedTo(view, key) {
    if (typeof currentRouteView !== 'function') return true;
    if (currentRouteView() !== view) return false;
    if (key == null || typeof currentRouteKey !== 'function') return true;
    return String(key) === currentRouteKey();
}

// May the render holding `token` draw? Only if no render started since, and
// the user is still on its view.
function viewRenderIsCurrent(token) {
    if (token !== _viewRenderSeq) return false;
    if (!_viewRenderView) return true;
    return _isRoutedTo(_viewRenderView, _viewRenderKey);
}

// Wraps what a view returns. Under the router this is the promise itself (the
// router shows loading and errors). Called directly, the newest render ends
// any loading state a navigation it superseded left up, and a failure ends on
// the error screen; the result never rejects, so callers need not catch.
function endViewRender(token, promise) {
    // Superseded already (or a dead token): it may not touch the loading or
    // error state, but its failure is still logged and never rejects.
    if (token !== _viewRenderSeq) {
        return Promise.resolve(promise).then(function () { return false; }, function (err) {
            // _viewRenderView is the newer render's, not this one's: no name.
            console.error('Could not show a view that is no longer on screen:', err);
            return false;
        });
    }
    if (_viewRenderRun) return promise;   // the router's own: it catches
    _viewRenderDone = false;
    function settle() {
        if (token !== _viewRenderSeq) return false;
        _viewRenderDone = true;
        _clearViewLoading(document.getElementById('app'), document.getElementById('view-status'));
        return true;
    }
    return Promise.resolve(promise).then(function () {
        settle();
        return true;
    }, function (err) {
        console.error('Could not show the ' + (_viewLabel(_viewRenderView)) + ' view:', err);
        if (settle()) showViewError(document.getElementById('app'), err);
        return false;
    });
}

function _viewLabel(view) {
    return (typeof VIEW_LABELS !== 'undefined' && VIEW_LABELS[view]) || 'page';
}

//   render(isCurrent, claim)  draws the view; may return a promise.
//                      `isCurrent()` says whether this run is still the
//                      newest; `claim(fn)` calls fn (which calls the view) so
//                      the view's render is known to belong to this run.
//   opts.label         what is loading, for the status text ("tracks")
//   opts.replace       true: show the loading block in place of #app's content
//                      (a move to another view); false: keep it (a refresh)
//   opts.root/status   the elements (default #app and #view-status)
//   opts.delay         ms before the loading state shows
// Resolves to true when the view drew, false when it failed; never rejects.
function runViewRender(render, opts) {
    opts = opts || {};
    var run = ++_viewRun;
    // Drops the write of any view render still in flight.
    startViewRender();
    _viewRenderRun = run;
    var root = opts.root || document.getElementById('app');
    var status = opts.status || document.getElementById('view-status');
    var settled = false;
    var shown = false;
    function isCurrent() { return run === _viewRun; }
    function claim(fn) {
        if (!isCurrent()) return fn();
        _claimingRun = run;
        try { return fn(); } finally { _claimingRun = 0; }
    }
    // Does this run still own the screen? Not once a newer run started, nor
    // once a direct re-render superseded its view (that render takes over the
    // loading state; see endViewRender).
    function ownsScreen() { return isCurrent() && _viewRenderRun === run; }

    var timer = setTimeout(function () {
        if (settled || !isCurrent()) return;
        // A direct re-render that already drew needs no loading state.
        if (!ownsScreen() && _viewRenderDone) return;
        shown = true;
        _showViewLoading(root, status, opts.label, !!opts.replace);
    }, opts.delay != null ? opts.delay : VIEW_LOADING_DELAY_MS);

    function finish() {
        settled = true;
        clearTimeout(timer);
        // A newer run, or a direct re-render still reading, owns the loading
        // state now; leave it alone. An older run's loading state still up
        // (it showed it, then this faster run overtook it) is this run's to clear.
        if ((shown || _loadingUp) && isCurrent() && (ownsScreen() || _viewRenderDone)) {
            _clearViewLoading(root, status);
        }
    }

    return new Promise(function (resolve) { resolve(render(isCurrent, claim)); }).then(function () {
        finish();
        return true;
    }, function (err) {
        finish();
        console.error('Could not show the ' + (opts.label || 'page') + ' view:', err);
        if (ownsScreen()) {
            _clearViewLoading(root, status);
            showViewError(root, err);
        }
        return false;
    });
}

function _showViewLoading(root, status, label, replace) {
    if (!root) return;
    var text = 'Loading ' + (label || 'page') + '…';
    _loadingUp = true;
    root.setAttribute('aria-busy', 'true');
    if (replace) {
        root.innerHTML = '<div class="view-loading">' +
            '<span class="view-loading-spinner" aria-hidden="true"></span>' +
            '<span class="view-loading-text">' + escHtml(text) + '</span></div>';
    } else {
        root.classList.add('view-refreshing');
    }
    if (status) status.textContent = text;
}

function _clearViewLoading(root, status) {
    _loadingUp = false;
    if (root) {
        root.removeAttribute('aria-busy');
        root.classList.remove('view-refreshing');
        // Only there if nothing drew over it (a view that bailed, e.g.
        // because the user moved on).
        var block = root.querySelector ? root.querySelector('.view-loading') : null;
        if (block && block.parentNode) block.parentNode.removeChild(block);
    }
    if (status) status.textContent = '';
}

// The message shown in place of a view that failed. A database that could not
// be opened (see dbOpenError in src/db.js) says why and what to do; anything
// else names the error and points at the console for the rest.
function viewErrorHtml(err) {
    var isDb = err && err.name === 'DbOpenError';
    var title = isDb ? 'Your saved data could not be opened' : 'This page could not be shown';
    var detail = isDb
        ? escHtml(err.message)
        : 'Something went wrong while loading it. Try again; if it keeps happening, reload the page.';
    var html = '<div class="empty-state view-error" role="alert">' +
        '<p class="empty-title">' + title + '</p>' +
        '<p class="empty-subtitle">' + detail + '</p>';
    if (!isDb && err && err.message) {
        html += '<p class="view-error-detail">' + escHtml(String(err.message)) + ' (details in the browser console)</p>';
    }
    return html + '<button class="btn btn-primary" id="view-retry-btn"' + act('click', 'retryCurrentView') + '>Try again</button></div>';
}

function showViewError(root, err) {
    if (root) root.innerHTML = viewErrorHtml(err);
}

function retryCurrentView() {
    // An error message is not the view: drawing it again counts as a move.
    if (typeof _shownRoute !== 'undefined') _shownRoute = null;
    renderCurrentView();
}

