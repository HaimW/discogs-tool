import os

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _env_paths():
    """Return list of .env paths to check, in priority order."""
    paths = [os.path.join(_BASE_DIR, '.env')]
    # When DATABASE_PATH is set to a different dir (e.g. Docker volume),
    # also check that directory for a .env file.
    db_dir = os.path.dirname(os.environ.get('DATABASE_PATH', ''))
    if db_dir and db_dir != _BASE_DIR:
        paths.insert(0, os.path.join(db_dir, '.env'))
    return paths


def _load_dotenv():
    for path in _env_paths():
        if not os.path.exists(path):
            continue
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, val = line.split('=', 1)
                os.environ[key.strip()] = val.strip()
        break  # only load from the first .env found

_load_dotenv()

DISCOGS_TOKEN = os.environ.get('DISCOGS_TOKEN', '')
DISCOGS_USERNAME = os.environ.get('DISCOGS_USERNAME', '')
SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-change-me')
DATABASE_PATH = os.environ.get('DATABASE_PATH',
    os.path.join(_BASE_DIR, 'collection.db'))
USER_AGENT = 'VinylCollectionPlayer/1.0'


def is_configured():
    return bool(DISCOGS_TOKEN and DISCOGS_USERNAME)


def save_config(token, username):
    global DISCOGS_TOKEN, DISCOGS_USERNAME
    DISCOGS_TOKEN = token.strip()
    DISCOGS_USERNAME = username.strip()
    os.environ['DISCOGS_TOKEN'] = DISCOGS_TOKEN
    os.environ['DISCOGS_USERNAME'] = DISCOGS_USERNAME

    lines = [
        f'DISCOGS_TOKEN={DISCOGS_TOKEN}',
        f'DISCOGS_USERNAME={DISCOGS_USERNAME}',
        f'SECRET_KEY={SECRET_KEY}',
    ]
    content = '\n'.join(lines) + '\n'

    # Write to the data directory (Docker volume) if it exists,
    # otherwise fall back to the app directory.
    env_path = _env_paths()[0]
    os.makedirs(os.path.dirname(env_path), exist_ok=True)
    with open(env_path, 'w') as f:
        f.write(content)
