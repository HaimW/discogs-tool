import sqlite3
import config

def get_db():
    conn = sqlite3.connect(config.DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn

def init_db():
    conn = get_db()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS releases (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            artist TEXT NOT NULL,
            year INTEGER,
            genres TEXT,
            styles TEXT,
            thumb_url TEXT,
            cover_url TEXT,
            format TEXT,
            quantity INTEGER DEFAULT 1,
            date_added TEXT,
            synced_at TEXT
        );

        CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            release_id INTEGER NOT NULL REFERENCES releases(id),
            title TEXT NOT NULL,
            uri TEXT NOT NULL,
            youtube_id TEXT,
            duration INTEGER,
            position INTEGER,
            UNIQUE(release_id, uri)
        );

        CREATE INDEX IF NOT EXISTS idx_videos_release ON videos(release_id);

        CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS release_folders (
            release_id INTEGER NOT NULL REFERENCES releases(id),
            folder_id INTEGER NOT NULL REFERENCES folders(id),
            UNIQUE(release_id, folder_id)
        );

        CREATE INDEX IF NOT EXISTS idx_rf_folder ON release_folders(folder_id);
    ''')
    conn.commit()
    conn.close()

def get_releases(q=None, genre=None, folder=None, sort='artist', page=1, per_page=48):
    conn = get_db()
    joins = ''
    where_clauses = []
    params = []

    if q:
        where_clauses.append('(r.artist LIKE ? OR r.title LIKE ?)')
        params.extend([f'%{q}%', f'%{q}%'])
    if genre:
        where_clauses.append('r.genres LIKE ?')
        params.append(f'%{genre}%')
    if folder:
        joins = 'JOIN release_folders rf ON rf.release_id = r.id'
        where_clauses.append('rf.folder_id = ?')
        params.append(int(folder))

    where_sql = ('WHERE ' + ' AND '.join(where_clauses)) if where_clauses else ''

    sort_map = {
        'artist': 'r.artist ASC, r.year DESC',
        'title': 'r.title ASC',
        'year': 'r.year DESC, r.artist ASC',
        'date_added': 'r.date_added DESC',
    }
    order_sql = sort_map.get(sort, sort_map['artist'])

    count = conn.execute(
        f'SELECT COUNT(DISTINCT r.id) FROM releases r {joins} {where_sql}', params
    ).fetchone()[0]

    offset = (page - 1) * per_page
    rows = conn.execute(f'''
        SELECT r.*, COUNT(v.id) as video_count
        FROM releases r
        LEFT JOIN videos v ON v.release_id = r.id
        {joins}
        {where_sql}
        GROUP BY r.id
        ORDER BY {order_sql}
        LIMIT ? OFFSET ?
    ''', params + [per_page, offset]).fetchall()

    conn.close()
    total_pages = max(1, (count + per_page - 1) // per_page)
    return rows, count, total_pages

def get_release(release_id):
    conn = get_db()
    release = conn.execute(
        'SELECT * FROM releases WHERE id = ?', (release_id,)
    ).fetchone()
    videos = conn.execute(
        'SELECT * FROM videos WHERE release_id = ? ORDER BY position, id',
        (release_id,)
    ).fetchall()
    conn.close()
    return release, videos

def get_all_genres():
    conn = get_db()
    rows = conn.execute('SELECT DISTINCT genres FROM releases WHERE genres IS NOT NULL').fetchall()
    conn.close()
    genres = set()
    for row in rows:
        for g in row['genres'].split(', '):
            g = g.strip()
            if g:
                genres.add(g)
    return sorted(genres)

def get_all_folders():
    conn = get_db()
    rows = conn.execute('SELECT id, name FROM folders ORDER BY name').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_random_videos(q=None, genre=None, folder=None, limit=50):
    conn = get_db()
    joins = 'JOIN releases r ON r.id = v.release_id'
    where_clauses = ['v.youtube_id IS NOT NULL']
    params = []

    if q:
        where_clauses.append('(r.artist LIKE ? OR r.title LIKE ?)')
        params.extend([f'%{q}%', f'%{q}%'])
    if genre:
        where_clauses.append('r.genres LIKE ?')
        params.append(f'%{genre}%')
    if folder:
        joins += ' JOIN release_folders rf ON rf.release_id = r.id'
        where_clauses.append('rf.folder_id = ?')
        params.append(int(folder))

    where_sql = 'WHERE ' + ' AND '.join(where_clauses)

    rows = conn.execute(f'''
        SELECT v.youtube_id, v.title, r.artist, r.thumb_url as cover,
               r.id as release_id
        FROM videos v
        {joins}
        {where_sql}
        ORDER BY RANDOM()
        LIMIT ?
    ''', params + [limit]).fetchall()

    conn.close()
    return [dict(r) for r in rows]


def search_releases_json(q, limit=20):
    conn = get_db()
    rows = conn.execute('''
        SELECT id, title, artist, thumb_url, year
        FROM releases
        WHERE artist LIKE ? OR title LIKE ?
        ORDER BY artist ASC
        LIMIT ?
    ''', (f'%{q}%', f'%{q}%', limit)).fetchall()
    conn.close()
    return [dict(r) for r in rows]
