import os

def _load_dotenv():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if not os.path.exists(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, val = line.split('=', 1)
            os.environ.setdefault(key.strip(), val.strip())

_load_dotenv()

DISCOGS_TOKEN = os.environ.get('DISCOGS_TOKEN', '')
DISCOGS_USERNAME = os.environ.get('DISCOGS_USERNAME', '')
SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-change-me')
DATABASE_PATH = os.environ.get('DATABASE_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'collection.db'))
USER_AGENT = 'VinylCollectionPlayer/1.0'
