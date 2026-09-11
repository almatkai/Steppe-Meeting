"""
Local SQLite Vector Store for Steppe Meeting Desktop.
Stores meeting chunks and embedding vectors in local SQLite meetings.db.
Calculates cosine similarity with numpy (or zero-dependency pure Python fallback).
"""

import logging
import math
import struct
import uuid
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("steppe.vector_store")


def ensure_schema(conn) -> None:
    """Create meeting_chunks table and indexes in SQLite if they don't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meeting_chunks (
            id TEXT PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            meeting_title TEXT NOT NULL,
            source_type TEXT NOT NULL,
            language TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            text TEXT NOT NULL,
            embedding BLOB NOT NULL,
            dim INTEGER NOT NULL,
            timestamp_start REAL,
            timestamp_end REAL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_meeting_id ON meeting_chunks(meeting_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_source_type ON meeting_chunks(source_type)")
    conn.commit()


def serialize_vector(vector: List[float]) -> Tuple[bytes, int]:
    """Packs a float list into raw binary BLOB."""
    dim = len(vector)
    return struct.pack(f"{dim}f", *vector), dim


def deserialize_vector(blob: bytes, dim: int) -> List[float]:
    """Unpacks raw binary BLOB into a float list."""
    return list(struct.unpack(f"{dim}f", blob))


def cosine_similarity(v1: List[float], v2: List[float]) -> float:
    """Calculates cosine similarity between two vectors."""
    try:
        import numpy as np
        a = np.array(v1, dtype=np.float32)
        b = np.array(v2, dtype=np.float32)
        denom = float(np.linalg.norm(a) * np.linalg.norm(b))
        if denom < 1e-9:
            return 0.0
        return float(np.dot(a, b) / denom)
    except Exception:
        # High-precision pure Python fallback
        dot = 0.0
        norm1 = 0.0
        norm2 = 0.0
        for a, b in zip(v1, v2):
            dot += a * b
            norm1 += a * a
            norm2 += b * b
        denom = math.sqrt(norm1) * math.sqrt(norm2)
        if denom < 1e-9:
            return 0.0
        return dot / denom


def upsert_chunks(
    conn,
    meeting_id: str,
    meeting_title: str,
    chunks: List[Dict[str, Any]],
    vectors: List[List[float]],
) -> int:
    """
    Inserts or replaces chunk records and embeddings for a meeting.
    chunks and vectors must be parallel lists of the same length.
    """
    if not chunks or not vectors or len(chunks) != len(vectors):
        return 0

    ensure_schema(conn)

    # Remove existing chunks for this meeting first to avoid stale entries
    delete_meeting_chunks(conn, meeting_id)

    rows = []
    for chunk, vector in zip(chunks, vectors):
        blob, dim = serialize_vector(vector)
        chunk_id = str(uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"{meeting_id}:{chunk.get('source_type', 'doc')}:{chunk.get('language', 'ru')}:{chunk.get('chunk_index', 0)}"
        ))
        rows.append((
            chunk_id,
            meeting_id,
            meeting_title,
            chunk.get("source_type", "protocol"),
            chunk.get("language", "ru"),
            chunk.get("chunk_index", 0),
            chunk.get("text", ""),
            blob,
            dim,
            chunk.get("timestamp_start"),
            chunk.get("timestamp_end"),
        ))

    conn.executemany("""
        INSERT OR REPLACE INTO meeting_chunks (
            id, meeting_id, meeting_title, source_type, language,
            chunk_index, text, embedding, dim, timestamp_start, timestamp_end
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, rows)
    conn.commit()

    logger.info("Upserted %d vector chunks for meeting %s (%s)", len(rows), meeting_id, meeting_title)
    return len(rows)


def delete_meeting_chunks(conn, meeting_id: str) -> None:
    """Removes all indexed chunks for a meeting."""
    ensure_schema(conn)
    conn.execute("DELETE FROM meeting_chunks WHERE meeting_id = ?", (meeting_id,))
    conn.commit()


def search(
    conn,
    query_vector: List[float],
    top_k: int = 15,
    filter_meeting_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Scans stored chunks in SQLite, computes cosine similarity against query_vector,
    and returns top_k results sorted by score descending.
    """
    ensure_schema(conn)

    query = "SELECT id, meeting_id, meeting_title, source_type, language, chunk_index, text, embedding, dim, timestamp_start, timestamp_end FROM meeting_chunks"
    params = []
    if filter_meeting_id:
        query += " WHERE meeting_id = ?"
        params.append(filter_meeting_id)

    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    if not rows:
        return []

    scored_results = []
    for row in rows:
        chunk_dim = row["dim"]
        blob = row["embedding"]
        stored_vector = deserialize_vector(blob, chunk_dim)
        score = cosine_similarity(query_vector, stored_vector)

        scored_results.append({
            "id": row["id"],
            "meeting_id": row["meeting_id"],
            "meeting_title": row["meeting_title"],
            "source_type": row["source_type"],
            "language": row["language"],
            "chunk_index": row["chunk_index"],
            "text": row["text"],
            "timestamp_start": row["timestamp_start"],
            "timestamp_end": row["timestamp_end"],
            "score": score,
        })

    # Sort descending by cosine similarity score
    scored_results.sort(key=lambda x: x["score"], reverse=True)
    return scored_results[:top_k]


def get_stats(conn) -> Dict[str, Any]:
    """Returns vector database statistics."""
    ensure_schema(conn)
    cursor = conn.execute("""
        SELECT 
            COUNT(*) as total_chunks,
            COUNT(DISTINCT meeting_id) as total_meetings
        FROM meeting_chunks
    """)
    row = cursor.fetchone()
    return {
        "total_chunks": row["total_chunks"] if row else 0,
        "indexed_meetings": row["total_meetings"] if row else 0,
    }
