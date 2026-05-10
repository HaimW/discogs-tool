// ============ SPA Router ============

var _currentView = '';
var _filters = {
    q: '', genre: '', folder: '', country: '', sort: 'artist', page: 1,
    tracks: { q: '', bpmMin: '', bpmMax: '', key: '', minRating: 0, tag: '', sort: 'artist', page: 1 },
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

function renderCurrentView() {
    isConfigured().then(function (configured) {
        if (!configured && _currentView !== 'setup') {
            _currentView = 'setup';
        }
        switch (_currentView) {
            case 'setup': renderSetup(); break;
            case 'release': renderRelease(_filters.releaseId); break;
            case 'tracks': renderTracks(); break;
            case 'wantlist': renderWantList(); break;
            case 'setlists': renderSetlists(); break;
            case 'setlist': renderSetlist(_filters.setlistId); break;
            case 'store': renderStore(); break;
            case 'backup': renderBackup(); break;
            default: renderCollection(); break;
        }
    });
}
