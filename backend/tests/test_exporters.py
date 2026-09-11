"""Checks for the JSON / CSV / ICS exports required by the track's must-have list."""
import csv
import io
import json
import pathlib
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from engine import exporters  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    print(f"[{'PASS' if condition else 'FAIL'}] {name}" + (f"  -> {detail}" if detail else ""))
    if not condition:
        FAILURES.append(name)


# --- Fixture: a meeting row shaped exactly like the database produces --------
summary = {
    "executive_summary": "Обсудили бюджет на Q4 и сроки запуска.",
    "topics": [
        {
            "topic": "Бюджет",
            "discussion": "Рассмотрели перерасход.",
            "key_arguments": ["Перерасход 12%"],
            "assignments": [
                {"assignee": "Айдана", "task": "Пересчитать смету", "deadline": "до 15.10.2026", "priority": "высокий"},
                {"assignee": "Мурат", "task": "Собрать счета", "deadline": "завтра", "priority": "низкий"},
            ],
        }
    ],
    "decisions": [{"decision": "Утвердить смету после пересчёта"}],
    "issues_and_risks": [
        {"type": "риск", "issue": "Подрядчик может сорвать срок", "impact": "Сдвиг запуска"}
    ],
    "action_items": [
        {"task": "Подготовить презентацию", "assignee": "Аз", "deadline": "2026-10-20", "priority": "средний"},
        {"task": "Пересчитать смету", "assignee": "Айдана", "deadline": "до 15.10.2026", "priority": "высокий"},
    ],
}

protocol = {
    "participants": [{"name": "Айдана", "position": "Финдиректор"}],
    "agenda_items": [{"topic": "Бюджет", "decisions": ["Утвердить смету после пересчёта", "Заморозить найм"]}],
}

segments = [
    {"index": 0, "speaker": "Айдана", "text": "Начнём.", "timestamp_start": 0.0, "timestamp_end": 2.0, "timestamp_str": "[00:00:00]"},
    {"index": 1, "speaker": "Спикер 2", "text": "Бюджет превышен.", "timestamp_start": 3.0, "timestamp_end": 6.0, "timestamp_str": "[00:00:03]"},
]

db = pathlib.Path(tempfile.mkdtemp()) / "t.db"
conn = sqlite3.connect(db)
conn.row_factory = sqlite3.Row
conn.execute("""CREATE TABLE meetings (id TEXT, title TEXT, created_at TEXT, status TEXT,
    duration_seconds REAL, source_language TEXT, agenda TEXT, participants TEXT,
    transcript_text TEXT, transcript_segments TEXT, protocol_ru TEXT, protocol_kz TEXT,
    summary_ru TEXT, summary_kz TEXT, speaker_source TEXT)""")
conn.execute("INSERT INTO meetings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
    "abc12345-0000", "Планёрка Q4", "2026-09-11T10:00:00", "completed", 125.4, "multi",
    "Бюджет и сроки", json.dumps(protocol["participants"], ensure_ascii=False),
    "текст", json.dumps(segments, ensure_ascii=False),
    json.dumps(protocol, ensure_ascii=False), "{}",
    json.dumps(summary, ensure_ascii=False), "{}", "pause+llm",
))
conn.commit()
row = conn.execute("SELECT * FROM meetings").fetchone()

payload = exporters.build_payload(row)

# --- Payload ----------------------------------------------------------------
check("title carried", payload["meeting"]["title"] == "Планёрка Q4")
check("executive summary present", payload["executive_summary"].startswith("Обсудили"))
check("speakers detected listed", payload["meeting"]["speakers_detected"] == ["Айдана", "Спикер 2"],
      str(payload["meeting"]["speakers_detected"]))
check("speaker_source carried", payload["meeting"]["speaker_source"] == "pause+llm")

tasks = [i["task"] for i in payload["action_items"]]
check("merges action_items and topic assignments", "Собрать счета" in tasks and "Подготовить презентацию" in tasks, str(tasks))
check("deduplicates repeated task", tasks.count("Пересчитать смету") == 1, str(tasks))
check("sorted by priority", payload["action_items"][0]["priority"] == "высокий", str(payload["action_items"][0]))
check("lowest priority last", payload["action_items"][-1]["priority"] == "низкий", str(payload["action_items"][-1]))

decisions = payload["decisions"]
check("decisions from both sources", "Заморозить найм" in decisions, str(decisions))
check("decision dict unwrapped", "Утвердить смету после пересчёта" in decisions, str(decisions))
check("decisions deduplicated", len(decisions) == len(set(decisions)), str(decisions))
check("risks carried", payload["issues_and_risks"][0]["type"] == "риск")

# --- JSON -------------------------------------------------------------------
raw = exporters.to_json(payload)
parsed = json.loads(raw.decode("utf-8"))
check("json is valid utf-8 json", parsed["meeting"]["id"] == "abc12345-0000")
check("json keeps cyrillic readable", "Планёрка" in raw.decode("utf-8"))
check("json includes transcript", parsed["transcript"]["segments"][0]["speaker"] == "Айдана")

# --- CSV --------------------------------------------------------------------
raw_csv = exporters.to_csv(payload)
check("csv has excel BOM", raw_csv.startswith(b"\xef\xbb\xbf"))
text = raw_csv.decode("utf-8-sig")
rows = list(csv.reader(io.StringIO(text), delimiter=";"))
header_idx = next(i for i, r in enumerate(rows) if r and r[0] == "Задача")
check("csv header correct",
      rows[header_idx] == ["Задача", "Ответственный", "Срок", "Приоритет", "Тема"], str(rows[header_idx]))
first = rows[header_idx + 1]
check("csv first row is highest priority", first[3] == "высокий", str(first))
check("csv escapes separator safely", all(len(r) <= 5 for r in rows[header_idx + 1:header_idx + 3]), str(rows[header_idx + 1:header_idx + 3]))
check("csv contains risks section", "Подрядчик может сорвать срок" in text)

# --- Deadline parsing -------------------------------------------------------
ref = datetime(2026, 9, 11, 12, 0, tzinfo=timezone.utc)
cases = [
    ("2026-10-20", (2026, 10, 20)),
    ("до 15.10.2026", (2026, 10, 15)),
    ("завтра", (2026, 9, 12)),
    ("через неделю", (2026, 9, 18)),
    ("20 октября", (2026, 10, 20)),
]
for text_in, expected in cases:
    got = exporters.parse_deadline(text_in, ref)
    actual = (got.year, got.month, got.day) if got else None
    check(f"deadline '{text_in}'", actual == expected, str(actual))

check("unparseable deadline returns None", exporters.parse_deadline("как получится", ref) is None)
check("empty deadline returns None", exporters.parse_deadline("", ref) is None)

# --- ICS --------------------------------------------------------------------
raw_ics = exporters.to_ics(payload)
ics = raw_ics.decode("utf-8")
check("ics well formed", ics.startswith("BEGIN:VCALENDAR") and ics.rstrip().endswith("END:VCALENDAR"))
check("ics uses CRLF", "\r\n" in ics)
check("ics has events", ics.count("BEGIN:VEVENT") == ics.count("END:VEVENT") == 3,
      f"{ics.count('BEGIN:VEVENT')} events")
check("ics includes assignee", "Айдана" in ics)
check("ics includes priority", "Приоритет" in ics)
check("ics has reminder", "BEGIN:VALARM" in ics)
check("ics lines within 75 octets",
      all(len(line.encode("utf-8")) <= 75 for line in ics.split("\r\n")),
      str(max((len(l.encode()) for l in ics.split("\r\n")), default=0)))

# Item with no parseable deadline must be omitted, not dated today.
only_vague = dict(payload, action_items=[{"task": "Когда-нибудь", "assignee": "", "deadline": "потом", "priority": "", "topic": ""}])
check("vague deadlines excluded from calendar", exporters.to_ics(only_vague).decode().count("BEGIN:VEVENT") == 0)

# --- Empty meeting must not crash the exporters -----------------------------
conn.execute("INSERT INTO meetings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
    "empty-0000", "Пустая", "2026-09-11T10:00:00", "draft", 0, "multi", "", "[]", "", "[]", "{}", "{}", "{}", "{}", "",
))
conn.commit()
empty = conn.execute("SELECT * FROM meetings WHERE id='empty-0000'").fetchone()
try:
    empty_payload = exporters.build_payload(empty)
    exporters.to_json(empty_payload)
    exporters.to_csv(empty_payload)
    exporters.to_ics(empty_payload)
    check("empty meeting exports without crashing", True)
except Exception as error:
    check("empty meeting exports without crashing", False, str(error))

conn.close()

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("All checks passed.")
