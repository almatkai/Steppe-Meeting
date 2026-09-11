"""Export a finished meeting into the machine readable formats.

The app previously exported only DOCX. That is a fine document for a person to
read, but it is not a format another system can consume, and the track's
must-have list names .csv, .json and .pdf specifically.

Everything here is pure stdlib, so nothing new can fail to install and nothing
reaches the network.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("steppe.exporters")

PRIORITY_ORDER = {"высокий": 0, "средний": 1, "низкий": 2, "": 3}


def _load(raw: Any, fallback: Any) -> Any:
    if isinstance(raw, (dict, list)):
        return raw
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return fallback


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("decision", "task", "text", "issue", "topic", "name"):
            if value.get(key):
                return str(value[key]).strip()
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def collect_action_items(summary: Dict[str, Any]) -> List[Dict[str, str]]:
    """Gather action items from every place the generator may have put them.

    The summary schema carries both a top level ``action_items`` list and
    per-topic ``assignments``. Reading only the first silently dropped tasks
    that the model attached to a topic instead.
    """
    items: List[Dict[str, str]] = []
    seen = set()

    def add(raw: Any, topic: str = "") -> None:
        if isinstance(raw, str):
            raw = {"task": raw}
        if not isinstance(raw, dict):
            return

        task = _as_text(raw.get("task") or raw.get("decision"))
        if not task:
            return

        key = task.lower()
        if key in seen:
            return
        seen.add(key)

        items.append({
            "task": task,
            "assignee": _as_text(raw.get("assignee") or raw.get("responsible")),
            "deadline": _as_text(raw.get("deadline")),
            "priority": _as_text(raw.get("priority")).lower(),
            "topic": _as_text(raw.get("related_to") or raw.get("topic") or topic),
        })

    for entry in summary.get("action_items") or []:
        add(entry)

    for topic in summary.get("topics") or []:
        if not isinstance(topic, dict):
            continue
        topic_name = _as_text(topic.get("topic"))
        for entry in topic.get("assignments") or []:
            add(entry, topic_name)

    items.sort(key=lambda item: PRIORITY_ORDER.get(item["priority"], 3))
    return items


def collect_decisions(protocol: Dict[str, Any], summary: Dict[str, Any]) -> List[str]:
    decisions: List[str] = []
    seen = set()

    def add(value: Any) -> None:
        text = _as_text(value)
        if text and text.lower() not in seen:
            seen.add(text.lower())
            decisions.append(text)

    for entry in summary.get("decisions") or []:
        add(entry)

    for topic in (protocol.get("agenda_items") or protocol.get("topics") or []):
        if isinstance(topic, dict):
            for entry in topic.get("decisions") or []:
                add(entry)

    return decisions


def build_payload(row: Any) -> Dict[str, Any]:
    """Assemble the canonical export structure for one meeting."""
    summary = _load(row["summary_ru"], {})
    protocol = _load(row["protocol_ru"], {})
    segments = _load(row["transcript_segments"], [])
    participants = _load(row["participants"], [])

    action_items = collect_action_items(summary)

    speakers = []
    for segment in segments:
        speaker = segment.get("speaker")
        if speaker and speaker not in speakers:
            speakers.append(speaker)

    return {
        "meeting": {
            "id": row["id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "duration_seconds": round(float(row["duration_seconds"] or 0), 1),
            "source_language": row["source_language"],
            "agenda": row["agenda"] or "",
            "participants": participants,
            "speakers_detected": speakers,
            "speaker_source": (row["speaker_source"] if "speaker_source" in row.keys() else "") or "",
        },
        "executive_summary": _as_text(summary.get("executive_summary")),
        "decisions": collect_decisions(protocol, summary),
        "action_items": action_items,
        "issues_and_risks": [
            {
                "type": _as_text(entry.get("type")),
                "issue": _as_text(entry.get("issue")),
                "impact": _as_text(entry.get("impact")),
            }
            for entry in (summary.get("issues_and_risks") or [])
            if isinstance(entry, dict)
        ],
        "topics": [
            {
                "topic": _as_text(topic.get("topic")),
                "discussion": _as_text(topic.get("discussion")),
                "key_arguments": [_as_text(a) for a in (topic.get("key_arguments") or [])],
            }
            for topic in (summary.get("topics") or [])
            if isinstance(topic, dict)
        ],
        "protocol_ru": protocol,
        "protocol_kz": _load(row["protocol_kz"], {}),
        "summary_ru": summary,
        "summary_kz": _load(row["summary_kz"], {}),
        "transcript": {
            "text": row["transcript_text"] or "",
            "segments": segments,
        },
        "generated_by": "Steppe Meeting (полностью локальная обработка)",
    }


def to_json(payload: Dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")


def to_csv(payload: Dict[str, Any]) -> bytes:
    """Action items as a spreadsheet, which is what a CSV export is actually for."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";", quoting=csv.QUOTE_MINIMAL)

    writer.writerow(["Совещание", payload["meeting"]["title"]])
    writer.writerow(["Дата", payload["meeting"]["created_at"][:10]])
    writer.writerow([])
    writer.writerow(["Задача", "Ответственный", "Срок", "Приоритет", "Тема"])

    for item in payload["action_items"]:
        writer.writerow([
            item["task"],
            item["assignee"] or "не назначен",
            item["deadline"] or "не указан",
            item["priority"] or "средний",
            item["topic"],
        ])

    if payload["decisions"]:
        writer.writerow([])
        writer.writerow(["Принятые решения"])
        for decision in payload["decisions"]:
            writer.writerow([decision])

    if payload["issues_and_risks"]:
        writer.writerow([])
        writer.writerow(["Тип", "Проблема / риск", "Влияние"])
        for entry in payload["issues_and_risks"]:
            writer.writerow([entry["type"], entry["issue"], entry["impact"]])

    # BOM so Excel on Windows opens Cyrillic correctly instead of showing mojibake.
    return b"\xef\xbb\xbf" + buffer.getvalue().encode("utf-8")


# ---------------------------------------------------------------------------
# Calendar export
# ---------------------------------------------------------------------------

_DATE_PATTERNS = [
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), lambda m: (int(m[1]), int(m[2]), int(m[3]))),
    (re.compile(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b"), lambda m: (int(m[3]), int(m[2]), int(m[1]))),
    (re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b"), lambda m: (int(m[3]), int(m[2]), int(m[1]))),
]

_MONTHS = {
    "январ": 1, "феврал": 2, "март": 3, "апрел": 4, "ма": 5, "июн": 6,
    "июл": 7, "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12,
}


def parse_deadline(text: str, reference: Optional[datetime] = None) -> Optional[datetime]:
    """Best-effort parse of a deadline written in free-form Russian."""
    if not text:
        return None

    reference = reference or datetime.now(timezone.utc)
    lowered = text.lower().strip()

    for pattern, extract in _DATE_PATTERNS:
        match = pattern.search(lowered)
        if match:
            try:
                year, month, day = extract(match)
                return datetime(year, month, day, 9, 0, tzinfo=timezone.utc)
            except ValueError:
                continue

    day_month = re.search(r"\b(\d{1,2})\s+([а-яё]+)", lowered)
    if day_month:
        day = int(day_month.group(1))
        word = day_month.group(2)
        for prefix, month in _MONTHS.items():
            if word.startswith(prefix):
                year = reference.year
                try:
                    candidate = datetime(year, month, day, 9, 0, tzinfo=timezone.utc)
                except ValueError:
                    break
                if candidate < reference - timedelta(days=180):
                    candidate = candidate.replace(year=year + 1)
                return candidate

    relative = {
        "сегодня": 0, "завтра": 1, "послезавтра": 2,
        "на следующей неделе": 7, "через неделю": 7,
        "через две недели": 14, "через месяц": 30,
        "до конца недели": 5, "до конца месяца": 30,
    }
    for phrase, days in relative.items():
        if phrase in lowered:
            return (reference + timedelta(days=days)).replace(hour=9, minute=0, second=0, microsecond=0)

    return None


def _ics_escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


def _ics_fold(line: str) -> str:
    """RFC 5545 caps lines at 75 octets; longer ones continue with a leading space."""
    encoded = line.encode("utf-8")
    if len(encoded) <= 73:
        return line

    parts = []
    current = b""
    for char in line:
        chunk = char.encode("utf-8")
        if len(current) + len(chunk) > 73:
            parts.append(current.decode("utf-8"))
            current = b" " + chunk
        else:
            current += chunk
    if current:
        parts.append(current.decode("utf-8"))
    return "\r\n".join(parts)


def to_ics(payload: Dict[str, Any]) -> bytes:
    """Action items with a parseable deadline become calendar events.

    Items whose deadline could not be understood are deliberately left out
    rather than dumped on today's date, which would be worse than absent.
    """
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    meeting_id = payload["meeting"]["id"]
    title = payload["meeting"]["title"]

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Steppe Meeting//Local//RU",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
    ]

    exported = 0
    for index, item in enumerate(payload["action_items"]):
        due = parse_deadline(item["deadline"], now)
        if not due:
            continue

        exported += 1
        description_parts = [f"Из протокола: {title}"]
        if item["assignee"]:
            description_parts.append(f"Ответственный: {item['assignee']}")
        if item["priority"]:
            description_parts.append(f"Приоритет: {item['priority']}")
        if item["topic"]:
            description_parts.append(f"Тема: {item['topic']}")

        lines.extend([
            "BEGIN:VEVENT",
            f"UID:{meeting_id}-task-{index}@steppe.meeting",
            f"DTSTAMP:{stamp}",
            f"DTSTART:{due.strftime('%Y%m%dT%H%M%SZ')}",
            f"DTEND:{(due + timedelta(hours=1)).strftime('%Y%m%dT%H%M%SZ')}",
            _ics_fold(f"SUMMARY:{_ics_escape(item['task'][:200])}"),
            _ics_fold(f"DESCRIPTION:{_ics_escape(' | '.join(description_parts))}"),
            "BEGIN:VALARM",
            "TRIGGER:-P1D",
            "ACTION:DISPLAY",
            "DESCRIPTION:Напоминание о поручении",
            "END:VALARM",
            "END:VEVENT",
        ])

    lines.append("END:VCALENDAR")
    logger.info("ICS export: %d of %d action items had a usable deadline",
                exported, len(payload["action_items"]))
    return ("\r\n".join(lines) + "\r\n").encode("utf-8")
