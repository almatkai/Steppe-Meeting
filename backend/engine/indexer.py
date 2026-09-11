"""
Search Indexer for Steppe Meeting Desktop.
Chunks protocols, summaries, and transcripts into semantic retrieval units,
generates local vector embeddings, and stores them in SQLite.
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional

from . import embeddings, vector_store

logger = logging.getLogger("steppe.indexer")


def chunk_text(text: str, max_words: int = 250, overlap_words: int = 30) -> List[str]:
    """
    Splits text into chunks of roughly max_words words, respecting
    paragraph breaks and sentences.
    """
    if not text or not text.strip():
        return []

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks = []
    current_words: List[str] = []

    for para in paragraphs:
        para_words = para.split()
        if not para_words:
            continue

        # If a single paragraph exceeds max_words, chunk it by sentences
        if len(para_words) > max_words:
            sentences = re.split(r"(?<=[.!?])\s+", para)
            for sentence in sentences:
                sent_words = sentence.split()
                if len(current_words) + len(sent_words) > max_words and current_words:
                    chunks.append(" ".join(current_words))
                    # Keep overlap
                    current_words = current_words[-overlap_words:] if overlap_words < len(current_words) else []
                current_words.extend(sent_words)
        else:
            if len(current_words) + len(para_words) > max_words and current_words:
                chunks.append(" ".join(current_words))
                current_words = current_words[-overlap_words:] if overlap_words < len(current_words) else []
            current_words.extend(para_words)

    if current_words:
        chunks.append(" ".join(current_words))

    return chunks


def _extract_protocol_text(protocol_raw: Any) -> str:
    """Extracts searchable plain text from structured protocol JSON or string."""
    if not protocol_raw:
        return ""

    data = protocol_raw
    if isinstance(protocol_raw, str):
        try:
            data = json.loads(protocol_raw)
        except Exception:
            return protocol_raw

    if not isinstance(data, dict):
        return str(data)

    lines = []
    if data.get("title"):
        lines.append(f"Тема: {data['title']}")

    if data.get("agenda"):
        lines.append("Повестка дня:")
        for item in data["agenda"]:
            lines.append(f"- {item}")

    if data.get("sections"):
        for sec in data["sections"]:
            sec_title = sec.get("title", "")
            lines.append(f"\nРаздел: {sec_title}")
            for d in sec.get("discussions", []):
                lines.append(f"Обсуждение: {d}")
            for dec in sec.get("decisions", []):
                lines.append(f"Решение: {dec.get('text', '')}")
                if dec.get("assignee"):
                    lines.append(f"  Ответственный: {dec['assignee']}")
                if dec.get("deadline"):
                    lines.append(f"  Срок: {dec['deadline']}")

    if data.get("tasks"):
        lines.append("\nПоручения и задачи:")
        for t in data["tasks"]:
            lines.append(f"- {t.get('task', '')} (Ответственный: {t.get('assignee', '')}, Срок: {t.get('deadline', '')})")

    return "\n".join(lines)


def _extract_summary_text(summary_raw: Any) -> str:
    """Extracts searchable plain text from summary JSON or string."""
    if not summary_raw:
        return ""

    data = summary_raw
    if isinstance(summary_raw, str):
        try:
            data = json.loads(summary_raw)
        except Exception:
            return summary_raw

    if not isinstance(data, dict):
        return str(data)

    lines = []
    if data.get("overview"):
        lines.append(f"Краткий обзор: {data['overview']}")
    if data.get("key_points"):
        lines.append("\nКлючевые пункты:")
        for p in data["key_points"]:
            lines.append(f"- {p}")
    if data.get("decisions"):
        lines.append("\nПринятые решения:")
        for d in data["decisions"]:
            lines.append(f"- {d}")
    if data.get("next_steps"):
        lines.append("\nСледующие шаги:")
        for s in data["next_steps"]:
            lines.append(f"- {s}")

    return "\n".join(lines)


async def index_meeting(meeting_id: str, conn) -> int:
    """
    Builds search chunks for a single meeting (protocol, summary, transcript),
    calculates vector embeddings, and stores them in SQLite vector_store.
    """
    cursor = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
    meeting = cursor.fetchone()
    if not meeting:
        logger.warning("Cannot index meeting %s: not found", meeting_id)
        return 0

    title = meeting["title"] or f"Совещание {meeting_id[:8]}"
    chunks_to_index: List[Dict[str, Any]] = []

    # 1. Russian Protocol
    proto_ru_text = _extract_protocol_text(meeting["protocol_ru"])
    if proto_ru_text:
        ru_chunks = chunk_text(proto_ru_text, max_words=250)
        for i, text in enumerate(ru_chunks):
            chunks_to_index.append({
                "source_type": "protocol_ru",
                "language": "ru",
                "chunk_index": i,
                "text": text,
            })

    # 2. Kazakh Protocol
    proto_kz_text = _extract_protocol_text(meeting["protocol_kz"])
    if proto_kz_text:
        kz_chunks = chunk_text(proto_kz_text, max_words=250)
        for i, text in enumerate(kz_chunks):
            chunks_to_index.append({
                "source_type": "protocol_kz",
                "language": "kz",
                "chunk_index": i,
                "text": text,
            })

    # 3. Russian Summary
    summary_ru_text = _extract_summary_text(meeting["summary_ru"])
    if summary_ru_text:
        s_ru_chunks = chunk_text(summary_ru_text, max_words=250)
        for i, text in enumerate(s_ru_chunks):
            chunks_to_index.append({
                "source_type": "summary_ru",
                "language": "ru",
                "chunk_index": i,
                "text": text,
            })

    # 4. Kazakh Summary
    summary_kz_text = _extract_summary_text(meeting["summary_kz"])
    if summary_kz_text:
        s_kz_chunks = chunk_text(summary_kz_text, max_words=250)
        for i, text in enumerate(s_kz_chunks):
            chunks_to_index.append({
                "source_type": "summary_kz",
                "language": "kz",
                "chunk_index": i,
                "text": text,
            })

    # 5. Transcript Text
    transcript_text = meeting["transcript_text"] or ""
    if transcript_text:
        tr_chunks = chunk_text(transcript_text, max_words=300)
        for i, text in enumerate(tr_chunks):
            chunks_to_index.append({
                "source_type": "transcript",
                "language": meeting["source_language"] or "ru",
                "chunk_index": i,
                "text": text,
            })

    if not chunks_to_index:
        logger.info("No content to index for meeting %s", meeting_id)
        return 0

    # Batch embed all chunk texts
    texts = [c["text"] for c in chunks_to_index]
    vectors = await embeddings.embed_texts(texts)

    indexed_count = vector_store.upsert_chunks(
        conn=conn,
        meeting_id=meeting_id,
        meeting_title=title,
        chunks=chunks_to_index,
        vectors=vectors,
    )

    logger.info("Indexed meeting %s (%s): %d chunks", meeting_id, title, indexed_count)
    return indexed_count


async def reindex_all_meetings(conn) -> Dict[str, Any]:
    """Indexes all meetings present in the database."""
    cursor = conn.execute("SELECT id, title FROM meetings ORDER BY created_at DESC")
    meetings = cursor.fetchall()

    total_indexed_chunks = 0
    meetings_indexed = 0

    for m in meetings:
        count = await index_meeting(m["id"], conn)
        if count > 0:
            total_indexed_chunks += count
            meetings_indexed += 1

    return {
        "meetings_processed": len(meetings),
        "meetings_indexed": meetings_indexed,
        "total_chunks": total_indexed_chunks,
    }
