"""
Steppe Meeting Desktop - Local Backend Server
Autonomous local backend engine with local SQLite, local Whisper STT,
and local Ollama / OpenAI-compatible LLM endpoints.
"""

import asyncio
from contextlib import contextmanager
import json
import logging
import os
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

# Add current backend folder to python path
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

# Ensure required local data directories
DATA_DIR = BASE_DIR / "data"
AUDIO_DIR = DATA_DIR / "audio"
EXPORTS_DIR = DATA_DIR / "exports"
DB_PATH = DATA_DIR / "meetings.db"

AUDIO_DIR.mkdir(parents=True, exist_ok=True)
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)

# Import local engine modules
from engine.config import settings
from engine import chunking, docx_template, llm, prompts, protocol, summary, vector_store, embeddings, indexer, retriever

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("steppe.desktop")

# ---------------------------------------------------------------------------
# Database Management (SQLite)
# ---------------------------------------------------------------------------

@contextmanager
def get_db():
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=15.0)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                status TEXT NOT NULL,
                duration_seconds REAL DEFAULT 0,
                source_language TEXT DEFAULT 'multi',
                agenda TEXT DEFAULT '',
                participants TEXT DEFAULT '[]',
                audio_filename TEXT DEFAULT '',
                audio_path TEXT DEFAULT '',
                transcript_text TEXT DEFAULT '',
                transcript_segments TEXT DEFAULT '[]',
                protocol_ru TEXT DEFAULT '{}',
                protocol_kz TEXT DEFAULT '{}',
                summary_ru TEXT DEFAULT '{}',
                summary_kz TEXT DEFAULT '{}',
                error_message TEXT DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                citations TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)")
        conn.commit()
        vector_store.ensure_schema(conn)

init_db()

def get_setting(key: str, default: str = "") -> str:
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

def set_setting(key: str, value: str):
    with get_db() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
        conn.commit()

# Default Settings
DEFAULT_LLM_URL = os.environ.get("LLM_BASE_URL") or get_setting("llm_base_url", "http://localhost:11434/v1")
DEFAULT_LLM_MODEL = os.environ.get("LLM_MODEL") or get_setting("llm_model", "qwen2.5:latest")
DEFAULT_LLM_KEY = os.environ.get("LLM_API_KEY") or get_setting("llm_api_key", "")
DEFAULT_WHISPER_URL = os.environ.get("WHISPER_BASE_URL") or get_setting("whisper_base_url", "http://localhost:8000/v1")
DEFAULT_WHISPER_MODEL = os.environ.get("WHISPER_MODEL") or get_setting("whisper_model", "whisper-1")

set_setting("llm_base_url", DEFAULT_LLM_URL)
set_setting("llm_model", DEFAULT_LLM_MODEL)
set_setting("llm_api_key", DEFAULT_LLM_KEY)
set_setting("whisper_base_url", DEFAULT_WHISPER_URL)
set_setting("whisper_model", DEFAULT_WHISPER_MODEL)

def get_chat_completions_url(base_url: str) -> str:
    """Normalizes any provider base URL to the /chat/completions endpoint."""
    url = (base_url or "").strip().rstrip("/")
    if url.endswith("/chat/completions"):
        return url
    if url.endswith("/v1"):
        return f"{url}/chat/completions"
    return f"{url}/v1/chat/completions"

def get_models_url(base_url: str) -> str:
    """Normalizes any provider base URL to the /models endpoint."""
    url = (base_url or "").strip().rstrip("/")
    if url.endswith("/models"):
        return url
    if url.endswith("/v1"):
        return f"{url}/models"
    return f"{url}/v1/models"

def get_ollama_tags_url(base_url: str) -> str:
    url = (base_url or "").strip().rstrip("/")
    if url.endswith("/v1"):
        url = url[:-3]
    return f"{url}/api/tags"

def get_auth_headers(api_key: Optional[str]) -> Dict[str, str]:
    if not api_key or not api_key.strip():
        return {}
    key = api_key.strip()
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    return {"Authorization": f"Bearer {key}"}

def sync_generation_settings():
    llm_url = get_setting("llm_base_url", "http://localhost:11434/v1")
    llm_model = get_setting("llm_model", "qwen2.5:latest")
    llm_api_key = get_setting("llm_api_key", "")
    settings.LLM_BASE_URL = llm_url
    settings.LLM_MODEL = llm_model
    settings.LLM_API_KEY = llm_api_key
    if "api.openai.com" in llm_url or (llm_api_key and llm_api_key.startswith("sk-")):
        settings.LLM_PRIMARY = "openai"
        settings.OPENAI_API_KEY = llm_api_key
        settings.OPENAI_LLM_MODEL = llm_model
    else:
        settings.LLM_PRIMARY = "local"
    settings.STT_SERVICE_BASE_URL = get_setting("whisper_base_url", "http://localhost:8000/v1")

sync_generation_settings()

# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Meeting Protocol Desktop API",
    version="1.0.0",
    description="Local backend engine for meeting protocol and summary generation",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class CreateMeetingRequest(BaseModel):
    title: str
    source_language: str = "multi"
    agenda: Optional[str] = ""
    participants: Optional[List[Dict[str, Any]]] = []
    transcript_text: Optional[str] = ""

class UpdateMeetingRequest(BaseModel):
    title: Optional[str] = None
    source_language: Optional[str] = None
    agenda: Optional[str] = None
    participants: Optional[List[Dict[str, Any]]] = None
    transcript_text: Optional[str] = None
    protocol_ru: Optional[Dict[str, Any]] = None
    protocol_kz: Optional[Dict[str, Any]] = None
    summary_ru: Optional[Dict[str, Any]] = None
    summary_kz: Optional[Dict[str, Any]] = None

class SystemConfigRequest(BaseModel):
    llm_base_url: Optional[str] = None
    llm_model: Optional[str] = None
    llm_api_key: Optional[str] = None
    whisper_base_url: Optional[str] = None
    whisper_model: Optional[str] = None

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    meeting_id: Optional[str] = None
    messages: List[ChatMessage]
    context: Optional[Dict[str, Any]] = None

class EditRequest(BaseModel):
    selected_text: str
    instruction: str
    context: Optional[Dict[str, Any]] = None

# ---------------------------------------------------------------------------
# Meeting Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/v1/meetings/create")
async def create_meeting(req: CreateMeetingRequest):
    meeting_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    status = "transcribed" if req.transcript_text.strip() else "draft"

    with get_db() as conn:
        conn.execute("""
            INSERT INTO meetings (
                id, title, created_at, status, source_language, agenda,
                participants, transcript_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            meeting_id,
            req.title or f"Совещание {datetime.now().strftime('%d.%m.%Y %H:%M')}",
            now,
            status,
            req.source_language,
            req.agenda or "",
            json.dumps(req.participants or [], ensure_ascii=False),
            req.transcript_text or "",
        ))
        conn.commit()

    return {"id": meeting_id, "status": status, "created_at": now}

@app.post("/api/v1/meetings/{meeting_id}/upload-audio")
async def upload_audio(meeting_id: str, file: UploadFile = File(...)):
    with get_db() as conn:
        row = conn.execute("SELECT id FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found")

    clean_filename = Path(file.filename).name if file.filename else "recording.wav"
    # Remove any stray path separators
    clean_filename = clean_filename.replace("/", "_").replace("\\", "_")
    safe_filename = f"{meeting_id}_{clean_filename}"
    file_path = AUDIO_DIR / safe_filename

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    with get_db() as conn:
        conn.execute("""
            UPDATE meetings 
            SET audio_filename = ?, audio_path = ?, status = 'draft'
            WHERE id = ?
        """, (clean_filename, str(file_path), meeting_id))
        conn.commit()

    return {"meeting_id": meeting_id, "filename": clean_filename, "size": len(content)}

@app.post("/api/v1/meetings/{meeting_id}/transcribe")
async def transcribe_meeting(meeting_id: str, background_tasks: BackgroundTasks):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found")
        audio_path = row["audio_path"]
        if not audio_path or not os.path.exists(audio_path):
            raise HTTPException(status_code=400, detail="No audio file uploaded for this meeting")

        conn.execute("UPDATE meetings SET status = 'transcribing', error_message = '' WHERE id = ?", (meeting_id,))
        conn.commit()

    background_tasks.add_task(run_transcription, meeting_id, audio_path)
    return {"meeting_id": meeting_id, "status": "transcribing"}

async def run_transcription(meeting_id: str, audio_path: str):
    logger.info("Starting transcription for meeting %s with audio %s", meeting_id, audio_path)
    whisper_url = get_setting("whisper_base_url", "http://localhost:8000/v1").rstrip("/")
    whisper_model = get_setting("whisper_model", "whisper-1")

    try:
        url = f"{whisper_url}/audio/transcriptions"
        async with httpx.AsyncClient(timeout=600.0) as client:
            with open(audio_path, "rb") as f:
                files = {"file": (os.path.basename(audio_path), f, "audio/mpeg")}
                data = {
                    "model": whisper_model,
                    "response_format": "verbose_json",
                }
                resp = await client.post(url, files=files, data=data)

            if resp.status_code != 200:
                with open(audio_path, "rb") as f:
                    files = {"file": (os.path.basename(audio_path), f, "audio/mpeg")}
                    data = {"model": whisper_model}
                    resp = await client.post(url, files=files, data=data)

            if resp.status_code != 200:
                raise Exception(f"Whisper server returned HTTP {resp.status_code}: {resp.text[:300]}")

            result = resp.json()

        segments = []
        raw_text = result.get("text", "")

        if "segments" in result and isinstance(result["segments"], list):
            for idx, s in enumerate(result["segments"]):
                start = float(s.get("start", 0) or 0)
                end = float(s.get("end", 0) or 0)
                start_str = time.strftime("%H:%M:%S", time.gmtime(max(0.0, start)))
                speaker = s.get("speaker") or f"Спикер {(idx % 3) + 1}"
                text = s.get("text", "").strip()
                segments.append({
                    "index": idx,
                    "speaker": speaker,
                    "text": text,
                    "timestamp_start": start,
                    "timestamp_end": end,
                    "timestamp_str": f"[{start_str}]",
                })
        else:
            lines = [l.strip() for l in raw_text.split("\n") if l.strip()]
            if not lines:
                lines = [raw_text]
            for idx, line in enumerate(lines):
                segments.append({
                    "index": idx,
                    "speaker": f"Спикер {(idx % 2) + 1}",
                    "text": line,
                    "timestamp_start": idx * 10.0,
                    "timestamp_end": (idx + 1) * 10.0,
                    "timestamp_str": f"[{time.strftime('%H:%M:%S', time.gmtime(idx * 10))}]",
                })

        formatted_transcript = "\n".join(
            f"[{s['speaker']}] {s['timestamp_str']}\n{s['text']}\n" for s in segments
        ) or raw_text

        total_duration = 0.0
        if result.get("duration"):
            try:
                total_duration = float(result["duration"])
            except (ValueError, TypeError):
                pass
        if not total_duration and segments:
            total_duration = max((float(s.get("timestamp_end", 0) or 0) for s in segments), default=0.0)

        with get_db() as conn:
            conn.execute("""
                UPDATE meetings 
                SET status = 'transcribed', transcript_text = ?, transcript_segments = ?, duration_seconds = ?, error_message = ''
                WHERE id = ?
            """, (formatted_transcript, json.dumps(segments, ensure_ascii=False), total_duration, meeting_id))
            conn.commit()

        logger.info("Transcription completed for meeting %s (%d segments)", meeting_id, len(segments))

    except Exception as e:
        logger.exception("Transcription failed for meeting %s: %s", meeting_id, e)
        with get_db() as conn:
            conn.execute("""
                UPDATE meetings SET status = 'error', error_message = ? WHERE id = ?
            """, (str(e), meeting_id))
            conn.commit()

@app.post("/api/v1/meetings/{meeting_id}/generate")
async def generate_meeting(meeting_id: str, background_tasks: BackgroundTasks):
    sync_generation_settings()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found")
        if not row["transcript_text"]:
            raise HTTPException(status_code=400, detail="Meeting has no transcript to generate from")

        conn.execute("UPDATE meetings SET status = 'generating', error_message = '' WHERE id = ?", (meeting_id,))
        conn.commit()

    background_tasks.add_task(run_generation, meeting_id)
    return {"meeting_id": meeting_id, "status": "generating"}

async def run_generation(meeting_id: str):
    logger.info("Starting protocol & summary generation for meeting %s", meeting_id)
    with get_db() as conn:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if not row:
            return

    transcript_text = row["transcript_text"]
    agenda = row["agenda"] or None
    raw_participants = json.loads(row["participants"] or "[]")
    participants = [
        f"{p.get('name', '')} ({p.get('position', '')})" if p.get('position') else p.get('name', '')
        for p in raw_participants if p.get('name')
    ] or None

    try:
        # Step 1: Russian Protocol
        logger.info("Generating Russian protocol...")
        protocol_ru = await protocol.generate(
            transcript_text=transcript_text,
            participants=participants,
            agenda=agenda,
        )

        # Step 2: Kazakh Protocol Translation
        logger.info("Translating protocol to Kazakh...")
        protocol_kz = await protocol._translate(
            protocol_ru=protocol_ru,
            system_prompt=prompts.TRANSLATE_PROTOCOL_SYSTEM,
            language_name="Kazakh",
            has_agenda=agenda is not None,
        )

        # Step 3: Russian Summary
        logger.info("Generating Russian summary...")
        summary_ru = await summary.generate(transcript_text=transcript_text)

        # Step 4: Kazakh Summary Translation
        logger.info("Translating summary to Kazakh...")
        summary_kz = await summary.translate(summary_ru=summary_ru)

        with get_db() as conn:
            conn.execute("""
                UPDATE meetings 
                SET status = 'completed',
                    protocol_ru = ?,
                    protocol_kz = ?,
                    summary_ru = ?,
                    summary_kz = ?,
                    error_message = ''
                WHERE id = ?
            """, (
                json.dumps(protocol_ru, ensure_ascii=False),
                json.dumps(protocol_kz, ensure_ascii=False),
                json.dumps(summary_ru, ensure_ascii=False),
                json.dumps(summary_kz, ensure_ascii=False),
                meeting_id,
            ))
            conn.commit()

        logger.info("Meeting generation completed successfully for %s", meeting_id)

        # Auto-index into local vector store for RAG
        try:
            with get_db() as conn:
                await indexer.index_meeting(meeting_id, conn)
            logger.info("Auto-indexed meeting %s into vector store", meeting_id)
        except Exception as idx_err:
            logger.warning("Failed to auto-index meeting %s: %s", meeting_id, idx_err)

    except Exception as e:
        logger.exception("Generation failed for meeting %s: %s", meeting_id, e)
        with get_db() as conn:
            conn.execute("""
                UPDATE meetings SET status = 'error', error_message = ? WHERE id = ?
            """, (f"Generation error: {e}", meeting_id))
            conn.commit()

@app.get("/api/v1/meetings")
async def list_meetings(q: Optional[str] = None):
    with get_db() as conn:
        if q:
            query = "%" + q + "%"
            rows = conn.execute("""
                SELECT id, title, created_at, status, duration_seconds, source_language, error_message
                FROM meetings
                WHERE title LIKE ? OR agenda LIKE ? OR transcript_text LIKE ?
                ORDER BY created_at DESC
            """, (query, query, query)).fetchall()
        else:
            rows = conn.execute("""
                SELECT id, title, created_at, status, duration_seconds, source_language, error_message
                FROM meetings
                ORDER BY created_at DESC
            """).fetchall()

        return [dict(r) for r in rows]

@app.get("/api/v1/meetings/{meeting_id}")
async def get_meeting(meeting_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found")

        data = dict(row)
        data["participants"] = json.loads(data["participants"] or "[]")
        data["transcript_segments"] = json.loads(data["transcript_segments"] or "[]")
        data["protocol_ru"] = json.loads(data["protocol_ru"] or "{}")
        data["protocol_kz"] = json.loads(data["protocol_kz"] or "{}")
        data["summary_ru"] = json.loads(data["summary_ru"] or "{}")
        data["summary_kz"] = json.loads(data["summary_kz"] or "{}")
        return data

@app.patch("/api/v1/meetings/{meeting_id}")
async def update_meeting(meeting_id: str, req: UpdateMeetingRequest):
    with get_db() as conn:
        row = conn.execute("SELECT id FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found")

        updates = []
        params = []
        if req.title is not None:
            updates.append("title = ?")
            params.append(req.title)
        if req.source_language is not None:
            updates.append("source_language = ?")
            params.append(req.source_language)
        if req.agenda is not None:
            updates.append("agenda = ?")
            params.append(req.agenda)
        if req.participants is not None:
            updates.append("participants = ?")
            params.append(json.dumps(req.participants, ensure_ascii=False))
        if req.transcript_text is not None:
            updates.append("transcript_text = ?")
            params.append(req.transcript_text)
        if req.protocol_ru is not None:
            updates.append("protocol_ru = ?")
            params.append(json.dumps(req.protocol_ru, ensure_ascii=False))
        if req.protocol_kz is not None:
            updates.append("protocol_kz = ?")
            params.append(json.dumps(req.protocol_kz, ensure_ascii=False))
        if req.summary_ru is not None:
            updates.append("summary_ru = ?")
            params.append(json.dumps(req.summary_ru, ensure_ascii=False))
        if req.summary_kz is not None:
            updates.append("summary_kz = ?")
            params.append(json.dumps(req.summary_kz, ensure_ascii=False))

        if updates:
            params.append(meeting_id)
            conn.execute(f"UPDATE meetings SET {', '.join(updates)} WHERE id = ?", params)
            conn.commit()

        return {"success": True}

@app.delete("/api/v1/meetings/{meeting_id}")
async def delete_meeting(meeting_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT audio_path FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if row and row["audio_path"] and os.path.exists(row["audio_path"]):
            try:
                os.remove(row["audio_path"])
            except Exception:
                pass
        conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
        conn.commit()
    return {"success": True}

# ---------------------------------------------------------------------------
# AI Assistant & Chat Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/v1/chat")
async def chat_assistant(req: ChatRequest):
    sync_generation_settings()
    llm_url = get_setting("llm_base_url", "http://localhost:11434/v1").rstrip("/")
    llm_model = get_setting("llm_model", "qwen2.5:latest")
    api_key = get_setting("llm_api_key", "").strip()
    chat_url = get_chat_completions_url(llm_url)
    headers = get_auth_headers(api_key)

    context_parts = [
        "You are an expert AI meeting assistant. Answer questions concisely and professionally based on the meeting data.",
    ]

    if req.meeting_id:
        with get_db() as conn:
            row = conn.execute("SELECT * FROM meetings WHERE id = ?", (req.meeting_id,)).fetchone()
            if row:
                if row["transcript_text"]:
                    context_parts.append(f"\n\nTranscript:\n{row['transcript_text'][:6000]}")
                if row["protocol_ru"] and row["protocol_ru"] != "{}":
                    context_parts.append(f"\n\nProtocol:\n{row['protocol_ru'][:4000]}")
                if row["summary_ru"] and row["summary_ru"] != "{}":
                    context_parts.append(f"\n\nSummary:\n{row['summary_ru'][:2000]}")

    if req.context:
        if req.context.get("protocol"):
            context_parts.append(f"\n\nProtocol Context:\n{req.context['protocol'][:4000]}")
        if req.context.get("summary"):
            context_parts.append(f"\n\nSummary Context:\n{req.context['summary'][:2000]}")

    system_prompt = "\n".join(context_parts)
    messages = [{"role": "system", "content": system_prompt}] + [
        {"role": m.role, "content": m.content} for m in req.messages
    ]

    async def event_generator():
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    chat_url,
                    headers=headers,
                    json={
                        "model": llm_model,
                        "messages": messages,
                        "stream": True,
                        "temperature": 0.3,
                    },
                ) as resp:
                    if resp.status_code != 200:
                        err_bytes = await resp.aread()
                        err_msg = err_bytes.decode(errors="replace")[:300]
                        yield f"data: {json.dumps({'error': f'LLM returned {resp.status_code}: {err_msg}'})}\n\n"
                        return

                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            yield f"{line}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# ---------------------------------------------------------------------------
# Multi-Turn RAG Chat Sessions & Vector Search API
# ---------------------------------------------------------------------------

class CreateChatSessionRequest(BaseModel):
    title: Optional[str] = "Новый диалог"

class SendSessionMessageRequest(BaseModel):
    content: str
    filter_meeting_id: Optional[str] = None

@app.get("/api/v1/chat/sessions")
async def list_chat_sessions():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT s.id, s.title, s.created_at, s.updated_at,
                   COUNT(m.id) as message_count,
                   (SELECT content FROM chat_messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) as last_message
            FROM chat_sessions s
            LEFT JOIN chat_messages m ON m.session_id = s.id
            GROUP BY s.id
            ORDER BY s.updated_at DESC
        """).fetchall()
        return [dict(r) for r in rows]

@app.post("/api/v1/chat/sessions")
async def create_chat_session(req: Optional[CreateChatSessionRequest] = None):
    session_id = str(uuid.uuid4())
    title = (req.title if req and req.title else "Новый диалог").strip()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO chat_sessions (id, title) VALUES (?, ?)",
            (session_id, title)
        )
        conn.commit()
        row = conn.execute("SELECT * FROM chat_sessions WHERE id = ?", (session_id,)).fetchone()
        return dict(row)

@app.get("/api/v1/chat/sessions/{session_id}/messages")
async def get_session_messages(session_id: str):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC",
            (session_id,)
        ).fetchall()
        result = []
        for r in rows:
            item = dict(r)
            if item.get("citations"):
                try:
                    item["citations"] = json.loads(item["citations"])
                except Exception:
                    item["citations"] = []
            else:
                item["citations"] = []
            result.append(item)
        return result

@app.delete("/api/v1/chat/sessions/{session_id}")
async def delete_chat_session(session_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM chat_sessions WHERE id = ?", (session_id,))
        conn.commit()
    return {"success": True}

@app.post("/api/v1/chat/sessions/{session_id}/messages")
async def send_session_message(session_id: str, req: SendSessionMessageRequest):
    content = req.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content cannot be empty")

    with get_db() as conn:
        session = conn.execute("SELECT * FROM chat_sessions WHERE id = ?", (session_id,)).fetchone()
        if not session:
            raise HTTPException(status_code=404, detail="Chat session not found")

        # 1. Save user message
        user_msg_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, citations) VALUES (?, ?, ?, ?, ?)",
            (user_msg_id, session_id, "user", content, None)
        )

        # 2. Auto-update session title if it is default
        if session["title"] in ("Новый диалог", "New Chat", ""):
            new_title = content[:45] + ("..." if len(content) > 45 else "")
            conn.execute("UPDATE chat_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (new_title, session_id))
        else:
            conn.execute("UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (session_id,))
        conn.commit()

        # 3. Retrieve context & citations via RAG
        top_chunks, citations = await retriever.retrieve(
            conn=conn,
            query=content,
            top_k=6,
            filter_meeting_id=req.filter_meeting_id,
        )

        # 4. Fetch recent history for multi-turn context
        history_rows = conn.execute(
            "SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC",
            (session_id,)
        ).fetchall()
        history = [dict(r) for r in history_rows[:-1]]

    # 5. Build prompt with RAG context
    prompt = retriever.build_rag_prompt(history, top_chunks, content)

    # 6. Stream SSE events
    sync_generation_settings()

    async def event_generator():
        # Frame 1: Citations event
        yield f"event: citations\ndata: {json.dumps({'citations': citations}, ensure_ascii=False)}\n\n"

        assistant_text = ""
        try:
            async for delta in llm.stream_chat([{"role": "user", "content": prompt}], temperature=0.3):
                if delta:
                    assistant_text += delta
                    yield f"event: delta\ndata: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"

            # Save assistant message to database
            asst_msg_id = str(uuid.uuid4())
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO chat_messages (id, session_id, role, content, citations) VALUES (?, ?, ?, ?, ?)",
                    (asst_msg_id, session_id, "assistant", assistant_text, json.dumps(citations, ensure_ascii=False))
                )
                conn.execute("UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (session_id,))
                conn.commit()

            yield f"event: done\ndata: {json.dumps({'message_id': asst_msg_id, 'full_text': assistant_text}, ensure_ascii=False)}\n\n"

        except Exception as e:
            logger.warning("LLM generation stream failed: %s", e)
            if not assistant_text:
                if citations:
                    fallback_text = (
                        "⚠️ **Локальная языковая модель не запущена или не загружена в Ollama.**\n\n"
                        "Тем не менее, векторный поиск успешно нашёл релевантные данные в базе совещаний:\n\n"
                    )
                    for idx, c in enumerate(citations[:4], 1):
                        fallback_text += f"{idx}. **{c['meeting_title']}** — *{c['source_label']}*:\n> {c['snippet']}\n\n"
                    fallback_text += (
                        "💡 *Для генерации полных ответов скачайте модель командой:*\n"
                        f"`ollama pull {settings.LLM_MODEL or 'qwen2.5:latest'}`\n"
                        "или укажите API-ключ в разделе **Настройки**."
                    )
                else:
                    fallback_text = (
                        "⚠️ **Не удалось связаться с языковой моделью.**\n\n"
                        "Убедитесь, что Ollama запущена (`ollama serve`) и модель загружена:\n"
                        f"`ollama pull {settings.LLM_MODEL or 'qwen2.5:latest'}`\n"
                        "Либо настройте параметры модели в **Настройках**."
                    )

                asst_msg_id = str(uuid.uuid4())
                with get_db() as conn:
                    conn.execute(
                        "INSERT INTO chat_messages (id, session_id, role, content, citations) VALUES (?, ?, ?, ?, ?)",
                        (asst_msg_id, session_id, "assistant", fallback_text, json.dumps(citations, ensure_ascii=False))
                    )
                    conn.execute("UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (session_id,))
                    conn.commit()

                yield f"event: delta\ndata: {json.dumps({'delta': fallback_text}, ensure_ascii=False)}\n\n"
                yield f"event: done\ndata: {json.dumps({'message_id': asst_msg_id, 'full_text': fallback_text}, ensure_ascii=False)}\n\n"
            else:
                yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.post("/api/v1/search/reindex")
async def reindex_search():
    with get_db() as conn:
        stats = await indexer.reindex_all_meetings(conn)
        return {"status": "ok", **stats}

@app.get("/api/v1/search/stats")
async def get_search_stats():
    with get_db() as conn:
        return vector_store.get_stats(conn)

@app.post("/api/v1/edit")
async def edit_text(req: EditRequest):
    sync_generation_settings()
    llm_url = get_setting("llm_base_url", "http://localhost:11434/v1").rstrip("/")
    llm_model = get_setting("llm_model", "qwen2.5:latest")
    api_key = get_setting("llm_api_key", "").strip()
    chat_url = get_chat_completions_url(llm_url)
    headers = get_auth_headers(api_key)

    system_prompt = (
        "You are an editorial assistant for official and business meeting protocols. "
        "Your job is to rewrite or correct the highlighted text according to the user's instructions. "
        "Preserve official business style and language (Kazakh or Russian). Return ONLY the edited replacement text, "
        "with no explanation or greeting."
    )

    user_prompt = f"Original text:\n\"\"\"\n{req.selected_text}\n\"\"\"\n\nInstruction:\n{req.instruction}\n\nEdited text:"

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            chat_url,
            headers=headers,
            json={
                "model": llm_model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.2,
            },
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        edited = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
        return {"edited_text": edited}

# ---------------------------------------------------------------------------
# DOCX Export
# ---------------------------------------------------------------------------

@app.get("/api/v1/meetings/{meeting_id}/export/docx")
async def export_docx(meeting_id: str, lang: str = Query("ru", pattern="^(ru|kz)$")):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found")

    import docx
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    doc = docx.Document()

    raw_protocol = (row["protocol_kz"] if lang == "kz" else row["protocol_ru"]) or "{}"
    try:
        protocol_data = json.loads(raw_protocol)
    except Exception:
        protocol_data = {}

    title = row["title"]

    # Header
    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title_p.add_run(f"ХАТТАМА / ПРОТОКОЛ\n{title.upper()}")
    run.font.bold = True
    run.font.size = Pt(16)

    # Date
    date_p = doc.add_paragraph()
    date_p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    date_p.add_run(f"Күні / Дата: {row['created_at'][:10]}")

    # Agenda
    doc.add_heading("Повестка дня / Күн тәртібі", level=2)
    agenda_text = row["agenda"] or protocol_data.get("metadata", {}).get("agenda", "Вопросы рабочего совещания")
    doc.add_paragraph(agenda_text)

    # Participants (supports both object dicts and strings)
    doc.add_heading("Присутствовали / Қатысқандар", level=2)
    protocol_participants = protocol_data.get("participants")
    if protocol_participants and isinstance(protocol_participants, list):
        participants = protocol_participants
    else:
        try:
            participants = json.loads(row["participants"] or "[]")
        except Exception:
            participants = []

    if participants:
        for p in participants:
            if isinstance(p, dict):
                name = p.get("name", "Участник")
                pos = f" — {p.get('position')}" if p.get("position") else ""
                doc.add_paragraph(f"• {name}{pos}")
            else:
                doc.add_paragraph(f"• {p}")
    else:
        doc.add_paragraph("Согласно списку участников")

    # Decisions / Topics (supports both agenda_items and topics)
    doc.add_heading("Решения и поручения / Шешімдер", level=2)
    raw_topics = protocol_data.get("agenda_items") or protocol_data.get("topics") or []
    if raw_topics:
        for idx, t in enumerate(raw_topics, 1):
            topic_title = t.get("topic") or t.get("topic_name") or f"Вопрос {idx}"
            doc.add_heading(f"{idx}. {topic_title}", level=3)

            speaker = t.get("speaker") or t.get("discussion")
            if speaker:
                doc.add_paragraph(f"Докладчик / Баяндамашы: {speaker}")

            decisions = t.get("decisions", [])
            for d in decisions:
                if isinstance(d, dict):
                    text = d.get("decision", "")
                    assignee = d.get("responsible", "")
                    deadline = d.get("deadline", "")
                    meta = []
                    if assignee:
                        meta.append(f"Отв: {assignee}")
                    if deadline:
                        meta.append(f"Срок: {deadline}")
                    meta_str = f" ({', '.join(meta)})" if meta else ""
                    doc.add_paragraph(f"— {text}{meta_str}")
                else:
                    doc.add_paragraph(f"— {d}")
    else:
        raw_summary = (row["summary_kz"] if lang == "kz" else row["summary_ru"]) or "{}"
        try:
            summary_data = json.loads(raw_summary)
        except Exception:
            summary_data = {}
        if summary_data.get("executive_summary"):
            doc.add_paragraph(summary_data["executive_summary"])

    export_path = EXPORTS_DIR / f"{meeting_id}_{lang}.docx"
    doc.save(str(export_path))

    return FileResponse(
        path=str(export_path),
        filename=f"Protocol_{meeting_id[:8]}_{lang}.docx",
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

# ---------------------------------------------------------------------------
# Diagnostics & System Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/v1/system/status")
async def system_status():
    llm_url = get_setting("llm_base_url", "http://localhost:11434/v1").rstrip("/")
    api_key = get_setting("llm_api_key", "").strip()
    whisper_url = get_setting("whisper_base_url", "http://localhost:8000/v1").rstrip("/")

    headers = get_auth_headers(api_key)
    tags_url = get_ollama_tags_url(llm_url)
    models_url = get_models_url(llm_url)

    ollama_ok = False
    ollama_err = ""
    ollama_models = []
    try:
        async with httpx.AsyncClient(timeout=3.5) as client:
            resp = await client.get(tags_url)
            if resp.status_code == 200:
                ollama_ok = True
                data = resp.json()
                ollama_models = [m.get("name") for m in data.get("models", []) if m.get("name")]
            else:
                resp2 = await client.get(models_url, headers=headers)
                if resp2.status_code == 200:
                    ollama_ok = True
                    data = resp2.json()
                    ollama_models = [m.get("id") for m in data.get("data", []) if m.get("id")]
                elif resp2.status_code in (401, 403):
                    ollama_err = f"Ошибка авторизации ({resp2.status_code}): проверьте Bearer-токен / API ключ."
                else:
                    ollama_err = f"Эндпоинт вернул код {resp2.status_code}"
    except Exception as e:
        ollama_err = str(e)

    whisper_ok = False
    whisper_err = ""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{whisper_url}/models")
            if resp.status_code == 200:
                whisper_ok = True
            else:
                whisper_ok = False
                whisper_err = f"Эндпоинт вернул код {resp.status_code}"
    except Exception as e:
        whisper_err = str(e)

    return {
        "ollama": {
            "connected": ollama_ok,
            "url": llm_url,
            "model": get_setting("llm_model"),
            "available_models": ollama_models,
            "error": ollama_err,
        },
        "whisper": {
            "connected": whisper_ok,
            "url": whisper_url,
            "model": get_setting("whisper_model"),
            "error": whisper_err,
        },
    }

@app.get("/api/v1/system/models")
async def list_models():
    llm_url = get_setting("llm_base_url", "http://localhost:11434/v1").rstrip("/")
    api_key = get_setting("llm_api_key", "").strip()
    headers = get_auth_headers(api_key)

    tags_url = get_ollama_tags_url(llm_url)
    models_url = get_models_url(llm_url)

    # 1. Try Ollama tags endpoint
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(tags_url)
            if resp.status_code == 200:
                data = resp.json()
                models = [m.get("name") for m in data.get("models", []) if m.get("name")]
                if models:
                    return sorted(models)
    except Exception:
        pass

    # 2. Try standard OpenAI /models endpoint
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp2 = await client.get(models_url, headers=headers)
            if resp2.status_code == 200:
                data = resp2.json()
                models = [m.get("id") for m in data.get("data", []) if m.get("id")]
                if models:
                    return sorted(models)
    except Exception as e:
        logger.warning("Failed to list models from %s: %s", models_url, e)

    return ["qwen2.5:latest", "llama3.2:latest", "gpt-4o", "gpt-4o-mini", "llama-3.3-70b-versatile"]

@app.get("/api/v1/system/config")
async def get_config():
    return {
        "llm_base_url": get_setting("llm_base_url", "http://localhost:11434/v1"),
        "llm_model": get_setting("llm_model", "qwen2.5:latest"),
        "llm_api_key": get_setting("llm_api_key", ""),
        "whisper_base_url": get_setting("whisper_base_url", "http://localhost:8000/v1"),
        "whisper_model": get_setting("whisper_model", "whisper-1"),
    }

@app.post("/api/v1/system/config")
async def save_config(req: SystemConfigRequest):
    if req.llm_base_url is not None:
        set_setting("llm_base_url", req.llm_base_url.strip())
    if req.llm_model is not None:
        set_setting("llm_model", req.llm_model.strip())
    if req.llm_api_key is not None:
        set_setting("llm_api_key", req.llm_api_key.strip())
    if req.whisper_base_url is not None:
        set_setting("whisper_base_url", req.whisper_base_url.strip())
    if req.whisper_model is not None:
        set_setting("whisper_model", req.whisper_model.strip())
    sync_generation_settings()
    return {"success": True}

if __name__ == "__main__":
    port = int(os.environ.get("DESKTOP_API_PORT", 8008))
    logger.info("Starting Steppe Meeting Desktop Server on port %d...", port)
    uvicorn.run(app, host="127.0.0.1", port=port)
