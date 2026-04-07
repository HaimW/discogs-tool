import threading

from flask import Flask, render_template, request, redirect, url_for, flash, jsonify

import config
from db import (init_db, get_releases, get_release, get_all_genres,
                get_all_folders, get_random_videos, search_releases_json)
from discogs_sync import sync_collection

app = Flask(__name__)
app.secret_key = config.SECRET_KEY

init_db()

# Track sync state
_sync_lock = threading.Lock()
_sync_status = {'running': False, 'message': ''}


@app.before_request
def require_setup():
    if config.is_configured():
        return
    allowed = ('setup', 'static')
    if request.endpoint in allowed:
        return
    return redirect(url_for('setup'))


@app.route('/setup', methods=['GET', 'POST'])
def setup():
    if request.method == 'POST':
        token = request.form.get('token', '').strip()
        username = request.form.get('username', '').strip()
        if not token or not username:
            flash('Both fields are required.', 'error')
            return render_template('setup.html', token=token, username=username)
        config.save_config(token, username)
        flash('Configuration saved! You can now sync your collection.', 'info')
        return redirect(url_for('index'))
    return render_template('setup.html',
                           token=config.DISCOGS_TOKEN,
                           username=config.DISCOGS_USERNAME)


@app.route('/')
def index():
    q = request.args.get('q', '').strip()
    genre = request.args.get('genre', '').strip()
    folder = request.args.get('folder', '').strip()
    sort = request.args.get('sort', 'artist')
    page = request.args.get('page', 1, type=int)

    releases, total_count, total_pages = get_releases(
        q=q or None, genre=genre or None, folder=folder or None,
        sort=sort, page=page
    )
    genres = get_all_genres()
    folders = get_all_folders()

    return render_template('index.html',
        releases=releases,
        total_count=total_count,
        total_pages=total_pages,
        current_page=page,
        q=q, genre=genre, folder=folder, sort=sort,
        genres=genres,
        folders=folders,
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


@app.route('/api/random-playlist')
def api_random_playlist():
    q = request.args.get('q', '').strip() or None
    genre = request.args.get('genre', '').strip() or None
    folder = request.args.get('folder', '').strip() or None
    limit = request.args.get('limit', 50, type=int)
    videos = get_random_videos(q=q, genre=genre, folder=folder, limit=limit)
    return jsonify(videos)


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
