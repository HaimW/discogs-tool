import os

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_ENV_PATH = os.path.join(_BASE_DIR, '.env')


def _load_dotenv():
    if not os.path.exists(_ENV_PATH):
        return
    with open(_ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, val = line.split('=', 1)
            os.environ[key.strip()] = val.strip()

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
    with open(_ENV_PATH, 'w') as f:
        f.write('\n'.join(lines) + '\n')
