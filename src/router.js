// ============ SPA Router ============

var _currentView = '';
var _filters = {
    q: '', genre: '', folder: '', country: '', sort: 'artist', page: 1,
    tracks: { q: '', bpmMin: '', bpmMax: '', key: '', minRating: 0, tag: '', sort: 'artist', page: 1, showAlts: false },
    setlistId: null,
    wantlist: { q: '', genre: '', format: '', decade: '', country: '', sort: 'artist', page: 1 }
};
var _navHistory = [];
var _navFromPop = false;

function navigate(view, params) {
    if (_currentView && !_navFromPop) {
        _navHistory.push({ view: _currentView, filters: JSON.parse(JSON.stringify(_filters)) });
        history.pushState(null, '');
    }
    _currentView = view;
    if (params) {
        for (var k in params) _filters[k] = params[k];
    }
    renderCurrentView();
    window.scrollTo(0, 0);
}

// What each view is called in its loading message.
var VIEW_LABELS = {
    setup: 'setup', collection: 'your collection', release: 'the release', tracks: 'tracks',
    wantlist: 'your want list', setlists: 'setlists', setlist: 'the setlist', store: 'the store',
    stats: 'stats', backup: 'backup', analyzer: 'the analyzer'
};

// The route on screen (or being drawn), so a refresh of it can be told
// apart from a move to another one (see runViewRender in src/view_state.js).
var _shownRoute = null;

// The view the router draws for _currentView ('' and unknown names: the
// collection). Views check it before drawing (see viewRenderIsCurrent).
function currentRouteView() {
    return Object.prototype.hasOwnProperty.call(VIEW_LABELS, _currentView) ? _currentView : 'collection';
}

// Which release / setlist the route is on (as a string: ids arrive as numbers
// or strings), or null for a view that shows no one item. A view drawing one
// item checks it too, so a late re-render of release A cannot draw over B.
function currentRouteKey() {
    var view = currentRouteView();
    var id = view === 'release' ? _filters.releaseId : view === 'setlist' ? _filters.setlistId : null;
    return id == null ? null : String(id);
}

function _routeKey(view) {
    if (view === 'release') return 'release:' + _filters.releaseId;
    if (view === 'setlist') return 'setlist:' + _filters.setlistId;
    return view || 'collection';
}

// Draws the current view. Each view returns its promise, so a slow one gets
// the shared loading state and a failing one (including the database not
// opening in isConfigured) the shared error message with "Try again".
function renderCurrentView() {
    var key = _routeKey(_currentView);
    var replace = key !== _shownRoute;
    _shownRoute = key;
    return runViewRender(function (isCurrent, claim) {
        return isConfigured().then(function (configured) {
            if (!isCurrent()) return;
            if (!configured && _currentView !== 'setup') {
                _currentView = 'setup';
                _shownRoute = 'setup';
            }
            return claim(function () {
                switch (_currentView) {
                    case 'setup': return renderSetup();
                    case 'release': return renderRelease(_filters.releaseId);
                    case 'tracks': return renderTracks();
                    case 'wantlist': return renderWantList();
                    case 'setlists': return renderSetlists();
                    case 'setlist': return renderSetlist(_filters.setlistId);
                    case 'store': return renderStore();
                    case 'backup': return renderBackup();
                    case 'analyzer': return renderAnalyzer();
                    case 'stats': return renderStats();
                    default: return renderCollection();
                }
            });
        });
    }, { label: VIEW_LABELS[_currentView] || 'page', replace: replace }).then(function (ok) {
        // An error message is not the view: "Try again" counts as a move.
        if (!ok && _shownRoute === key) _shownRoute = null;
        return ok;
    });
}
