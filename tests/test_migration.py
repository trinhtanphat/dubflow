import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'migrations' / '0001_initial.sql'


def test_initial_migration_creates_phase1_tables():
    sql = MIGRATION.read_text(encoding='utf-8')
    db = sqlite3.connect(':memory:')
    db.executescript(sql)
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {'users', 'projects', 'speakers', 'segments', 'jobs', 'usage_events'} <= tables
