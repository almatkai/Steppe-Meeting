"""Verify the schema migration, WAL setup and job recovery SQL against a real
database created with the OLD schema, which is what an existing user has."""
import json
import sqlite3
import sys
import tempfile
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from engine import stt  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    print(f"[{'PASS' if condition else 'FAIL'}] {name}" + (f"  -> {detail}" if detail else ""))
    if not condition:
        FAILURES.append(name)


db_path = pathlib.Path(tempfile.mkdtemp()) / "meetings.db"

# --- Build a database with the pre-upgrade schema ---------------------------
old = sqlite3.connect(db_path)
old.execute("""
    CREATE TABLE meetings (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
        status TEXT NOT NULL, duration_seconds REAL DEFAULT 0,
        source_language TEXT DEFAULT 'multi', agenda TEXT DEFAULT '',
        participants TEXT DEFAULT '[]', audio_filename TEXT DEFAULT '',
        audio_path TEXT DEFAULT '', transcript_text TEXT DEFAULT '',
        transcript_segments TEXT DEFAULT '[]', protocol_ru TEXT DEFAULT '{}',
        protocol_kz TEXT DEFAULT '{}', summary_ru TEXT DEFAULT '{}',
        summary_kz TEXT DEFAULT '{}', error_message TEXT DEFAULT ''
    )
""")
segments = [
    {"index": 0, "speaker": "Спикер 1", "text": "Открываю совещание.",
     "timestamp_start": 0.0, "timestamp_end": 3.0, "timestamp_str": "[00:00:00]", "turn": 1},
    {"index": 1, "speaker": "Спикер 2", "text": "Бюджет согласован.",
     "timestamp_start": 5.0, "timestamp_end": 8.0, "timestamp_str": "[00:00:05]", "turn": 2},
    {"index": 2, "speaker": "Спикер 1", "text": "Принято.",
     "timestamp_start": 10.0, "timestamp_end": 12.0, "timestamp_str": "[00:00:10]", "turn": 3},
]
old.execute(
    "INSERT INTO meetings (id, title, created_at, status, transcript_segments) VALUES (?,?,?,?,?)",
    ("m-done", "Старое совещание", "2026-09-01", "completed", json.dumps(segments, ensure_ascii=False)),
)
old.execute(
    "INSERT INTO meetings (id, title, created_at, status) VALUES (?,?,?,?)",
    ("m-stuck", "Прерванное", "2026-09-01", "transcribing"),
)
old.execute(
    "INSERT INTO meetings (id, title, created_at, status) VALUES (?,?,?,?)",
    ("m-gen", "Прерванная генерация", "2026-09-01", "generating"),
)
old.commit()
old.close()

# --- Apply the new startup path ---------------------------------------------
conn = sqlite3.connect(db_path, check_same_thread=False, timeout=30.0)
conn.row_factory = sqlite3.Row
mode = conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
conn.execute("PRAGMA synchronous=NORMAL")
conn.execute("PRAGMA busy_timeout=30000")
check("WAL enabled", mode == "wal", mode)


def ensure_columns(conn, table, columns):
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    added = []
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
            added.append(name)
    return added


added = ensure_columns(conn, "meetings", {
    "progress": "REAL DEFAULT 0",
    "progress_label": "TEXT DEFAULT ''",
    "speaker_source": "TEXT DEFAULT ''",
})
check("migration adds 3 columns", sorted(added) == ["progress", "progress_label", "speaker_source"], str(added))

again = ensure_columns(conn, "meetings", {
    "progress": "REAL DEFAULT 0", "progress_label": "TEXT DEFAULT ''", "speaker_source": "TEXT DEFAULT ''",
})
check("migration is idempotent", again == [], str(again))

row = conn.execute("SELECT * FROM meetings WHERE id = 'm-done'").fetchone()
check("existing row survives migration", row["title"] == "Старое совещание")
check("new column defaults to 0", row["progress"] == 0, str(row["progress"]))
check("old data intact", len(json.loads(row["transcript_segments"])) == 3)

# --- Job recovery ------------------------------------------------------------
stuck_before = conn.execute(
    "SELECT COUNT(*) c FROM meetings WHERE status IN ('transcribing','generating')"
).fetchone()["c"]
check("two stuck jobs present", stuck_before == 2, str(stuck_before))

conn.execute("""
    UPDATE meetings SET status='error', progress=0, progress_label='',
        error_message='Обработка была прервана при перезапуске сервера. Запустите её заново.'
    WHERE status IN ('transcribing','generating')
""")
conn.commit()

stuck_after = conn.execute(
    "SELECT COUNT(*) c FROM meetings WHERE status IN ('transcribing','generating')"
).fetchone()["c"]
check("stuck jobs cleared", stuck_after == 0, str(stuck_after))

recovered = conn.execute("SELECT * FROM meetings WHERE id='m-stuck'").fetchone()
check("recovered job explains itself", "прервана" in recovered["error_message"])
check("completed job untouched", conn.execute(
    "SELECT status FROM meetings WHERE id='m-done'").fetchone()["status"] == "completed")

# --- Progress writes ---------------------------------------------------------
for pct, label in [(-5, "clamp low"), (37.5, "часть 1 из 3"), (150, "clamp high")]:
    conn.execute("UPDATE meetings SET progress=?, progress_label=? WHERE id='m-done'",
                 (max(0.0, min(100.0, float(pct))), label))
conn.commit()
final = conn.execute("SELECT progress, progress_label FROM meetings WHERE id='m-done'").fetchone()
check("progress clamped to 100", final["progress"] == 100.0, str(final["progress"]))

# --- Speaker rename round trip ----------------------------------------------
row = conn.execute("SELECT transcript_segments FROM meetings WHERE id='m-done'").fetchone()
segs = json.loads(row["transcript_segments"])
segs = stt.rename_speaker(segs, "Спикер 1", "Айдана Ермекова")
text = stt.rebuild_transcript_text(segs)
conn.execute("UPDATE meetings SET transcript_segments=?, transcript_text=? WHERE id='m-done'",
             (json.dumps(segs, ensure_ascii=False), text))
conn.commit()

updated = conn.execute("SELECT transcript_segments, transcript_text FROM meetings WHERE id='m-done'").fetchone()
new_segs = json.loads(updated["transcript_segments"])
labels = [s["speaker"] for s in new_segs]
check("both occurrences renamed", labels == ["Айдана Ермекова", "Спикер 2", "Айдана Ермекова"], str(labels))
check("flat text rebuilt", updated["transcript_text"].count("[Айдана Ермекова]") == 2)
check("other speaker preserved", "[Спикер 2]" in updated["transcript_text"])
check("timestamps preserved in text", "[00:00:10]" in updated["transcript_text"])

# --- Concurrent read while writing (the WAL case) ----------------------------
writer = sqlite3.connect(db_path, timeout=30.0)
writer.execute("PRAGMA journal_mode=WAL")
writer.execute("BEGIN")
writer.execute("UPDATE meetings SET progress=55 WHERE id='m-done'")

reader = sqlite3.connect(db_path, timeout=2.0)
try:
    value = reader.execute("SELECT progress FROM meetings WHERE id='m-done'").fetchone()[0]
    check("read not blocked by open write", True, f"saw pre-commit value {value}")
except sqlite3.OperationalError as e:
    check("read not blocked by open write", False, str(e))
finally:
    writer.rollback()
    writer.close()
    reader.close()

conn.close()

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("All checks passed.")
