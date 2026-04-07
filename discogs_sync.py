"""Three-phase Discogs collection sync.

Phase 0: Fetch folder list
Phase 1: Fetch collection releases per folder (basic info, cover art, metadata)
Phase 2: Fetch individual releases for YouTube video links (parallelized)

Handles deduplication (same release owned multiple times) and rate limiting.
Can be run standalone: python discogs_sync.py
"""

import time
import sqlite3
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, parse_qs

import requests

import config
from db import get_db, init_db


class _RateLimiter:
    """Token-bucket rate limiter: at most 1 request per `interval` seconds."""

    def __init__(self, interval=1.0):
        self._interval = interval
        self._lock = threading.Lock()
        self._last = 0.0

    def acquire(self):
        with self._lock:
            now = time.monotonic()
            wait = self._interval - (now - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()


_rate_limiter = _RateLimiter(interval=1.0)


def _make_session():
    s = requests.Session()
    s.headers.update({
        'Authorization': f'Discogs token={config.DISCOGS_TOKEN}',
        'User-Agent': config.USER_AGENT,
    })
    return s


def _check_rate_limit(response):
    remaining = response.headers.get('X-Discogs-Ratelimit-Remaining')
    if remaining is not None and int(remaining) < 5:
        print(f'  Rate limit low ({remaining} remaining), sleeping 10s...')
        time.sleep(10)


def _extract_youtube_id(uri):
    parsed = urlparse(uri)
    if 'youtube.com' in parsed.hostname:
        return parse_qs(parsed.query).get('v', [None])[0]
    if 'youtu.be' in parsed.hostname:
        return parsed.path.lstrip('/')
    return None


def sync_collection(progress_callback=None):
    """Run full three-phase sync. Returns (releases_count, videos_count)."""
    session = _make_session()

    if progress_callback:
        progress_callback('Starting collection sync...')

    # Phase 0: Fetch folders
    folders = _fetch_folders(session, progress_callback)

    # Phase 1: Fetch collection releases per folder
    releases_data, folder_memberships = _fetch_collection_by_folder(
        session, folders, progress_callback
    )

    # Deduplicate and count quantities
    release_counts = Counter(r['id'] for r in releases_data)
    unique_releases = {}
    for r in releases_data:
        if r['id'] not in unique_releases:
            unique_releases[r['id']] = r

    # Store in DB
    conn = get_db()

    # Save folders
    for folder in folders:
        conn.execute(
            'INSERT OR REPLACE INTO folders (id, name) VALUES (?, ?)',
            (folder['id'], folder['name']),
        )

    # Save releases
    for release_id, data in unique_releases.items():
        conn.execute('''
            INSERT INTO releases (id, title, artist, year, genres, styles,
                                  thumb_url, cover_url, format, quantity, date_added)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title=excluded.title, artist=excluded.artist, year=excluded.year,
                genres=excluded.genres, styles=excluded.styles,
                thumb_url=excluded.thumb_url, cover_url=excluded.cover_url,
                format=excluded.format, quantity=excluded.quantity,
                date_added=excluded.date_added
        ''', (
            data['id'], data['title'], data['artist'], data['year'],
            data['genres'], data['styles'], data['thumb_url'], data['cover_url'],
            data['format'], release_counts[release_id], data['date_added'],
        ))

    # Save folder memberships
    for release_id, folder_id in folder_memberships:
        conn.execute(
            'INSERT OR IGNORE INTO release_folders (release_id, folder_id) '
            'VALUES (?, ?)',
            (release_id, folder_id),
        )

    conn.commit()

    if progress_callback:
        progress_callback(f'Phase 1 done: {len(unique_releases)} unique releases '
                          f'({len(releases_data)} total items)')

    # Phase 2: Fetch videos for un-synced releases (parallel)
    unsynced = conn.execute(
        'SELECT id, artist, title FROM releases WHERE synced_at IS NULL'
    ).fetchall()

    videos_count = _fetch_videos_parallel(session, conn, unsynced, progress_callback)

    conn.close()

    if progress_callback:
        progress_callback(f'Sync complete: {len(unique_releases)} releases, '
                          f'{videos_count} new videos')

    return len(unique_releases), videos_count


def _fetch_folders(session, progress_callback=None):
    """Phase 0: Fetch folder list from Discogs."""
    if progress_callback:
        progress_callback('Fetching folders...')

    _rate_limiter.acquire()
    url = f'https://api.discogs.com/users/{config.DISCOGS_USERNAME}/collection/folders'
    resp = session.get(url)
    resp.raise_for_status()
    _check_rate_limit(resp)

    folders = []
    for f in resp.json().get('folders', []):
        folders.append({'id': f['id'], 'name': f['name'], 'count': f.get('count', 0)})

    if progress_callback:
        progress_callback(f'Found {len(folders)} folders')

    return folders


def _fetch_collection_by_folder(session, folders, progress_callback=None):
    """Phase 1: Fetch releases per folder, recording folder memberships."""
    all_releases = []
    folder_memberships = []  # list of (release_id, folder_id)

    # Fetch from each non-All folder to capture folder membership
    real_folders = [f for f in folders if f['id'] != 0]

    if not real_folders:
        # No custom folders — fall back to folder 0 (All)
        releases = _fetch_folder_releases(session, 0, progress_callback)
        all_releases.extend(releases)
    else:
        for folder in real_folders:
            if progress_callback:
                progress_callback(f'Fetching folder: {folder["name"]}...')
            releases = _fetch_folder_releases(session, folder['id'], progress_callback)
            for r in releases:
                folder_memberships.append((r['id'], folder['id']))
            all_releases.extend(releases)

    return all_releases, folder_memberships


def _fetch_folder_releases(session, folder_id, progress_callback=None):
    """Paginate through a single folder's releases."""
    releases = []
    page = 1
    url = (f'https://api.discogs.com/users/{config.DISCOGS_USERNAME}'
           f'/collection/folders/{folder_id}/releases')

    while True:
        _rate_limiter.acquire()
        resp = session.get(url, params={'per_page': 100, 'page': page})
        resp.raise_for_status()
        _check_rate_limit(resp)

        data = resp.json()
        page_releases = data.get('releases', [])

        for item in page_releases:
            info = item.get('basic_information', {})
            artists = ', '.join(a['name'] for a in info.get('artists', []))
            genres = ', '.join(info.get('genres', []))
            styles = ', '.join(info.get('styles', []))
            formats = ', '.join(
                f.get('name', '') for f in info.get('formats', [])
            )

            releases.append({
                'id': info.get('id'),
                'title': info.get('title', 'Unknown'),
                'artist': artists or 'Unknown',
                'year': info.get('year') or None,
                'genres': genres or None,
                'styles': styles or None,
                'thumb_url': info.get('thumb') or None,
                'cover_url': info.get('cover_image') or None,
                'format': formats or None,
                'date_added': item.get('date_added'),
            })

        pagination = data.get('pagination', {})
        total_pages = pagination.get('pages', 1)

        if progress_callback:
            progress_callback(f'  page {page}/{total_pages}')

        if page >= total_pages:
            break
        page += 1

    return releases


def _fetch_videos_parallel(session, conn, unsynced, progress_callback=None):
    """Phase 2: Fetch videos for unsynced releases using a thread pool."""
    if not unsynced:
        return 0

    total = len(unsynced)
    completed = [0]  # mutable counter for closure
    videos_count = 0
    lock = threading.Lock()

    def fetch_one(row):
        release_id = row['id']
        _rate_limiter.acquire()
        resp = session.get(f'https://api.discogs.com/releases/{release_id}')
        resp.raise_for_status()
        _check_rate_limit(resp)

        videos = []
        for vid in resp.json().get('videos', []):
            uri = vid.get('uri', '')
            if not vid.get('embed', False):
                continue
            if 'youtube.com' not in uri and 'youtu.be' not in uri:
                continue
            youtube_id = _extract_youtube_id(uri)
            if not youtube_id:
                continue
            videos.append({
                'title': vid.get('title', 'Untitled'),
                'uri': uri,
                'youtube_id': youtube_id,
                'duration': vid.get('duration'),
            })

        return release_id, videos

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(fetch_one, row): row for row in unsynced}

        for future in as_completed(futures):
            row = futures[future]
            try:
                release_id, vids = future.result()
            except Exception as e:
                print(f'[sync] Error fetching release {row["id"]}: {e}')
                continue

            for pos, vid in enumerate(vids, 1):
                try:
                    conn.execute('''
                        INSERT INTO videos (release_id, title, uri, youtube_id,
                                            duration, position)
                        VALUES (?, ?, ?, ?, ?, ?)
                    ''', (release_id, vid['title'], vid['uri'],
                          vid['youtube_id'], vid['duration'], pos))
                    videos_count += 1
                except sqlite3.IntegrityError:
                    pass

            conn.execute(
                "UPDATE releases SET synced_at = datetime('now') WHERE id = ?",
                (release_id,)
            )
            conn.commit()

            with lock:
                completed[0] += 1
            if progress_callback:
                progress_callback(
                    f'Fetching videos: {completed[0]}/{total} - '
                    f'{row["artist"]} - {row["title"]}'
                )

    return videos_count


if __name__ == '__main__':
    init_db()
    print('Starting Discogs collection sync...')
    releases, videos = sync_collection(progress_callback=print)
    print(f'\nDone! {releases} releases, {videos} videos synced.')
