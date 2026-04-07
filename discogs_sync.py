"""Two-phase Discogs collection sync.

Phase 1: Fetch collection list (basic info, cover art, metadata)
Phase 2: Fetch individual releases for YouTube video links

Handles deduplication (same release owned multiple times) and rate limiting.
Can be run standalone: python discogs_sync.py
"""

import time
import sqlite3
from collections import Counter
from urllib.parse import urlparse, parse_qs

import requests

import config
from db import get_db, init_db


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
    """Run full two-phase sync. Returns (releases_count, videos_count)."""
    session = _make_session()

    if progress_callback:
        progress_callback('Starting collection sync...')

    # Phase 1: Fetch collection list
    releases_data = _fetch_collection_list(session, progress_callback)

    # Deduplicate and count quantities
    release_counts = Counter(r['id'] for r in releases_data)
    unique_releases = {}
    for r in releases_data:
        if r['id'] not in unique_releases:
            unique_releases[r['id']] = r

    # Store in DB
    conn = get_db()
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
    conn.commit()

    if progress_callback:
        progress_callback(f'Phase 1 done: {len(unique_releases)} unique releases '
                          f'({len(releases_data)} total items)')

    # Phase 2: Fetch videos for un-synced releases
    unsynced = conn.execute(
        'SELECT id, artist, title FROM releases WHERE synced_at IS NULL'
    ).fetchall()

    videos_count = 0
    for i, row in enumerate(unsynced, 1):
        if progress_callback:
            progress_callback(f'Fetching videos: {i}/{len(unsynced)} - '
                              f'{row["artist"]} - {row["title"]}')

        vids = _fetch_release_videos(session, row['id'])
        for pos, vid in enumerate(vids, 1):
            try:
                conn.execute('''
                    INSERT INTO videos (release_id, title, uri, youtube_id, duration, position)
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', (row['id'], vid['title'], vid['uri'], vid['youtube_id'],
                      vid['duration'], pos))
                videos_count += 1
            except sqlite3.IntegrityError:
                pass  # duplicate video URI for this release

        conn.execute(
            "UPDATE releases SET synced_at = datetime('now') WHERE id = ?",
            (row['id'],)
        )
        conn.commit()

    conn.close()

    if progress_callback:
        progress_callback(f'Sync complete: {len(unique_releases)} releases, '
                          f'{videos_count} new videos')

    return len(unique_releases), videos_count


def _fetch_collection_list(session, progress_callback=None):
    """Phase 1: Paginate through collection and extract basic info."""
    releases = []
    page = 1
    url = (f'https://api.discogs.com/users/{config.DISCOGS_USERNAME}'
           f'/collection/folders/0/releases')

    while True:
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
            progress_callback(f'Fetching collection: page {page}/{total_pages}')

        if page >= total_pages:
            break
        page += 1
        time.sleep(1)

    return releases


def _fetch_release_videos(session, release_id):
    """Phase 2: Fetch a single release and extract YouTube videos."""
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

    time.sleep(1)  # respect rate limits between release fetches
    return videos


if __name__ == '__main__':
    init_db()
    print('Starting Discogs collection sync...')
    releases, videos = sync_collection(progress_callback=print)
    print(f'\nDone! {releases} releases, {videos} videos synced.')
