import threading

from flask import Flask, render_template, request, redirect, url_for, flash, jsonify

import config
from db import init_db, get_releases, get_release, get_all_genres, search_releases_json
from discogs_sync import sync_collection

app = Flask(__name__)
app.secret_key = config.SECRET_KEY

init_db()

# Track sync state
_sync_lock = threading.Lock()
_sync_status = {'running': False, 'message': ''}


@app.route('/')
def index():
    q = request.args.get('q', '').strip()
    genre = request.args.get('genre', '').strip()
    sort = request.args.get('sort', 'artist')
    page = request.args.get('page', 1, type=int)

    releases, total_count, total_pages = get_releases(
        q=q or None, genre=genre or None, sort=sort, page=page
    )
    genres = get_all_genres()

    return render_template('index.html',
        releases=releases,
        total_count=total_count,
        total_pages=total_pages,
        current_page=page,
        q=q, genre=genre, sort=sort,
        genres=genres,
        sync_running=_sync_status['running'],
    )


@app.route('/release/<int:release_id>')
def release_detail(release_id):
    release, videos = get_release(release_id)
    if not release:
        flash('Release not found.', 'error')
        return redirect(url_for('index'))
    return render_template('release.html', release=release, videos=videos)


@app.route('/sync', methods=['POST'])
def sync():
    if _sync_status['running']:
        flash('Sync already in progress...', 'warning')
        return redirect(url_for('index'))

    def run_sync():
        _sync_status['running'] = True
        try:
            def cb(msg):
                _sync_status['message'] = msg
                print(f'[sync] {msg}')
            sync_collection(progress_callback=cb)
            _sync_status['message'] = 'Sync complete!'
        except Exception as e:
            _sync_status['message'] = f'Sync failed: {e}'
            print(f'[sync] ERROR: {e}')
        finally:
            _sync_status['running'] = False

    thread = threading.Thread(target=run_sync, daemon=True)
    thread.start()
    flash('Collection sync started! This may take a few minutes for large collections.', 'info')
    return redirect(url_for('index'))


@app.route('/sync/status')
def sync_status():
    return jsonify({
        'running': _sync_status['running'],
        'message': _sync_status['message'],
    })


@app.route('/api/search')
def api_search():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify([])
    return jsonify(search_releases_json(q))


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
