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
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
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
from engine import chunking, docx_template, exporters, llm, prompts, protocol, stt, summary, timecode_matcher, vector_store, embeddings, indexer, retriever

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("steppe.desktop")

# ---------------------------------------------------------------------------
# Database Management (SQLite)
# ---------------------------------------------------------------------------

@contextmanager
def get_db():
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    # WAL lets the UI poll meeting status while a background transcription job
    # is writing. Without it the default rollback journal takes an exclusive
    # lock on every write and the polling reads block, which showed up as a UI
    # that froze for seconds at a time during long meetings.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        yield conn
    finally:
        conn.close()


def _ensure_columns(conn, table: str, columns: Dict[str, str]) -> None:
    """Add any missing columns so an existing database upgrades in place."""
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    for name, definition in columns.items():
        if name not in existing:
            logger.info("Migrating %s: adding column %s", table, name)
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


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

        _ensure_columns(conn, "meetings", {
            "progress": "REAL DEFAULT 0",
            "progress_label": "TEXT DEFAULT ''",
            "speaker_source": "TEXT DEFAULT ''",
        })

        conn.commit()
        vector_store.ensure_schema(conn)


def recover_interrupted_jobs():
    """Clear jobs left mid-flight by a crash or a restart.

    Transcription and generation run as in-process background tasks, so killing
    the server leaves rows stuck on 'transcribing' forever and the UI spins
    against a job nobody is working on. On boot, mark those as failed with an
    explanation and an actionable next step.
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, title, status FROM meetings WHERE status IN ('transcribing', 'generating')"
        ).fetchall()
        if not rows:
            return
        for row in rows:
            logger.warning("Recovering meeting %s stuck in status '%s'", row["id"], row["status"])
        conn.execute("""
            UPDATE meetings
            SET status = 'error',
                progress = 0,
                progress_label = '',
                error_message = 'Обработка была прервана при перезапуске сервера. Запустите её заново.'
            WHERE status IN ('transcribing', 'generating')
        """)
        conn.commit()
    logger.info("Recovered %d interrupted job(s)", len(rows))


init_db()
recover_interrupted_jobs()


def set_progress(meeting_id: str, percent: float, label: str) -> None:
    """Record job progress so the UI can render a real progress bar."""
    try:
        with get_db() as conn:
            conn.execute(
                "UPDATE meetings SET progress = ?, progress_label = ? WHERE id = ?",
                (max(0.0, min(100.0, float(percent))), label, meeting_id),
            )
            conn.commit()
    except Exception as error:
        # Progress is cosmetic. Never let it fail the job it is reporting on.
        logger.debug("Could not record progress for %s: %s", meeting_id, error)

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

DEFAULT_WHISPER_KEY = os.environ.get("WHISPER_API_KEY") or get_setting("whisper_api_key", "")

set_setting("llm_base_url", DEFAULT_LLM_URL)
set_setting("llm_model", DEFAULT_LLM_MODEL)
set_setting("llm_api_key", DEFAULT_LLM_KEY)
set_setting("whisper_base_url", DEFAULT_WHISPER_URL)
set_setting("whisper_model", DEFAULT_WHISPER_MODEL)
set_setting("whisper_api_key", DEFAULT_WHISPER_KEY)
set_setting("stt_provider", os.environ.get("STT_PROVIDER") or get_setting("stt_provider", "builtin"))
set_setting("whisper_model_size", os.environ.get("WHISPER_MODEL_SIZE") or get_setting("whisper_model_size", ""))

# ---------------------------------------------------------------------------
# Provider presets
#
# The app previously assumed a local Whisper server and a local Ollama and had
# no way to reach anything else, because the transcription call sent no
# Authorization header at all. These presets let a user switch the whole stack
# to a hosted provider in one click, which matters when the demo machine cannot
# run a 7B model.
# ---------------------------------------------------------------------------

PROVIDER_PRESETS: Dict[str, Dict[str, Any]] = {
    "builtin": {
        "label": "Встроенный Whisper + Ollama",
        "description": "Модель распознавания работает внутри бэкенда, отдельный сервер не нужен. Ни одного сетевого запроса.",
        "needs_key": False,
        "offline": True,
        "stt_provider": "builtin",
        "llm_base_url": "http://localhost:11434/v1",
        "llm_model": "qwen2.5:latest",
        "whisper_base_url": "",
        "whisper_model": "",
        "key_url": "",
    },
    "local": {
        "label": "Внешний Whisper-сервер + Ollama",
        "description": "Если у вас уже поднят faster-whisper-server или whisper.cpp на localhost.",
        "needs_key": False,
        "offline": True,
        "stt_provider": "http",
        "llm_base_url": "http://localhost:11434/v1",
        "llm_model": "qwen2.5:latest",
        "whisper_base_url": "http://localhost:8000/v1",
        "whisper_model": "whisper-1",
        "key_url": "",
    },
    "groq": {
        "label": "Groq (облако)",
        "description": "Быстро, но это внешний API. Нарушает требование полной автономности.",
        "needs_key": True,
        "offline": False,
        "stt_provider": "http",
        "llm_base_url": "https://api.groq.com/openai/v1",
        "llm_model": "llama-3.3-70b-versatile",
        "whisper_base_url": "https://api.groq.com/openai/v1",
        "whisper_model": "whisper-large-v3-turbo",
        "key_url": "https://console.groq.com/keys",
    },
    "openai": {
        "label": "OpenAI (облако)",
        "description": "Внешний API. Нарушает требование полной автономности.",
        "needs_key": True,
        "offline": False,
        "stt_provider": "http",
        "llm_base_url": "https://api.openai.com/v1",
        "llm_model": "gpt-4o",
        "whisper_base_url": "https://api.openai.com/v1",
        "whisper_model": "whisper-1",
        "key_url": "https://platform.openai.com/api-keys",
    },
}

# Hosts that count as "this machine". Anything else is an external service.
LOCAL_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "host.docker.internal")


def is_local_endpoint(url: str) -> bool:
    """True when a URL points at this machine (or is unset, meaning in-process)."""
    url = (url or "").strip()
    if not url:
        return True
    try:
        from urllib.parse import urlparse

        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return host in LOCAL_HOSTS or host.endswith(".local")


def offline_report() -> Dict[str, Any]:
    """Describe, precisely, whether this configuration can reach the internet.

    The track requires that no request leaves the machine, so the app needs to
    be able to prove its own state rather than just claim it.
    """
    stt_provider = get_setting("stt_provider", "builtin")
    whisper_url = get_setting("whisper_base_url", "")
    llm_url = get_setting("llm_base_url", "http://localhost:11434/v1")

    stt_local = stt_provider == "builtin" or is_local_endpoint(whisper_url)
    llm_local = is_local_endpoint(llm_url)

    violations = []
    if not stt_local:
        violations.append(f"Распознавание речи обращается к внешнему адресу: {whisper_url}")
    if not llm_local:
        violations.append(f"Языковая модель обращается к внешнему адресу: {llm_url}")

    return {
        "offline": stt_local and llm_local,
        "stt": {
            "local": stt_local,
            "mode": "в процессе бэкенда" if stt_provider == "builtin" else (whisper_url or "не задан"),
        },
        "llm": {"local": llm_local, "endpoint": llm_url},
        "violations": violations,
    }

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

    # Only route through the dedicated OpenAI client when the endpoint really is
    # OpenAI. Groq and other OpenAI-compatible hosts must stay on the "local"
    # path, which honours LLM_BASE_URL; the old sk- prefix check misrouted any
    # provider whose keys happen to start with sk- straight at api.openai.com.
    if "api.openai.com" in llm_url:
        settings.LLM_PRIMARY = "openai"
        settings.OPENAI_API_KEY = llm_api_key
        settings.OPENAI_LLM_MODEL = llm_model
    else:
        settings.LLM_PRIMARY = "local"
        settings.OPENAI_API_KEY = ""

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
    whisper_api_key: Optional[str] = None

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
    sync_generation_settings()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found")
        audio_path = row["audio_path"]
        if not audio_path or not os.path.exists(audio_path):
            raise HTTPException(status_code=400, detail="No audio file uploaded for this meeting")

        try:
            participants = json.loads(row["participants"] or "[]")
        except (json.JSONDecodeError, TypeError):
            participants = []

        source_language = row["source_language"] or "multi"

        conn.execute(
            "UPDATE meetings SET status = 'transcribing', error_message = '', progress = 0, "
            "progress_label = 'В очереди' WHERE id = ?",
            (meeting_id,),
        )
        conn.commit()

    background_tasks.add_task(run_transcription, meeting_id, audio_path, participants, source_language)
    return {"meeting_id": meeting_id, "status": "transcribing"}


# Whisper wants a two letter hint, not the app's own language mode. "multi"
# deliberately maps to None so the model auto-detects, which is what a mixed
# Russian and Kazakh meeting actually needs.
LANGUAGE_HINTS = {"ru": "ru", "kz": "kk", "kk": "kk", "en": "en"}


async def run_transcription(
    meeting_id: str,
    audio_path: str,
    participants: Optional[List[Dict[str, Any]]] = None,
    source_language: str = "multi",
):
    logger.info("Starting transcription for meeting %s with audio %s", meeting_id, audio_path)

    stt_provider = get_setting("stt_provider", "builtin")
    whisper_url = get_setting("whisper_base_url", "http://localhost:8000/v1")
    whisper_key = get_setting("whisper_api_key", "")
    language = LANGUAGE_HINTS.get((source_language or "").lower())

    # The built-in engine takes a model SIZE (small, large-v3); an HTTP endpoint
    # takes a model NAME (whisper-1). They are not interchangeable.
    if stt_provider == "builtin":
        whisper_model = get_setting("whisper_model_size", "")
    else:
        whisper_model = get_setting("whisper_model", "whisper-1")

    def report(percent: float, label: str) -> None:
        set_progress(meeting_id, percent, label)

    try:
        result = await stt.transcribe_audio(
            audio_path,
            base_url=whisper_url,
            model=whisper_model,
            api_key=whisper_key,
            provider=stt_provider,
            language=language,
            participants=participants or [],
            llm_module=llm,
            progress=report,
        )

        formatted_transcript = result.formatted_text()
        segments = result.segments_as_dicts()

        with get_db() as conn:
            conn.execute("""
                UPDATE meetings
                SET status = 'transcribed',
                    transcript_text = ?,
                    transcript_segments = ?,
                    duration_seconds = ?,
                    speaker_source = ?,
                    progress = 100,
                    progress_label = 'Расшифровка готова',
                    error_message = ''
                WHERE id = ?
            """, (
                formatted_transcript,
                json.dumps(segments, ensure_ascii=False),
                result.duration_seconds,
                result.speaker_source,
                meeting_id,
            ))
            conn.commit()

        logger.info(
            "Transcription completed for meeting %s: %d segments, %d chunk(s), speakers via %s",
            meeting_id, len(segments), result.chunk_count, result.speaker_source,
        )

        # Generation starts next and wants the same GPU memory the Whisper
        # weights are holding. On a card too small for both, hand it back.
        if stt_provider == "builtin":
            device, _ = stt.detect_compute_device()
            if stt.should_release_after_use(device):
                await asyncio.to_thread(stt.release_whisper_model)

    except stt.STTError as error:
        # Already a human readable message, show it as is.
        _fail_meeting(meeting_id, str(error))
    except Exception as error:
        logger.exception("Transcription failed for meeting %s", meeting_id)
        _fail_meeting(meeting_id, f"Не удалось расшифровать запись: {error}")


def _fail_meeting(meeting_id: str, message: str) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE meetings SET status = 'error', error_message = ?, progress = 0, "
            "progress_label = '' WHERE id = ?",
            (message, meeting_id),
        )
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

        conn.execute(
            "UPDATE meetings SET status = 'generating', error_message = '', progress = 0, "
            "progress_label = 'В очереди' WHERE id = ?",
            (meeting_id,),
        )
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
        set_progress(meeting_id, 10, "Формирование протокола (RU)")
        protocol_ru = await protocol.generate(
            transcript_text=transcript_text,
            participants=participants,
            agenda=agenda,
        )

        # Step 2: Kazakh Protocol Translation
        logger.info("Translating protocol to Kazakh...")
        set_progress(meeting_id, 40, "Перевод протокола (KZ)")
        protocol_kz = await protocol._translate(
            protocol_ru=protocol_ru,
            system_prompt=prompts.TRANSLATE_PROTOCOL_SYSTEM,
            language_name="Kazakh",
            has_agenda=agenda is not None,
        )

        # Step 3: Russian Summary
        logger.info("Generating Russian summary...")
        set_progress(meeting_id, 65, "Формирование резюме (RU)")
        summary_ru = await summary.generate(transcript_text=transcript_text)

        # Step 4: Kazakh Summary Translation
        logger.info("Translating summary to Kazakh...")
        set_progress(meeting_id, 85, "Перевод резюме (KZ)")
        summary_kz = await summary.translate(summary_ru=summary_ru)

        with get_db() as conn:
            conn.execute("""
                UPDATE meetings
                SET status = 'completed',
                    protocol_ru = ?,
                    protocol_kz = ?,
                    summary_ru = ?,
                    summary_kz = ?,
                    progress = 100,
                    progress_label = 'Готово',
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

    except llm.LLMError as error:
        logger.warning("Generation failed for meeting %s: %s", meeting_id, error)
        _fail_meeting(
            meeting_id,
            "Модель не ответила. Проверьте, что Ollama запущена и модель скачана, "
            "или переключитесь на облачного провайдера в настройках. "
            f"Детали: {str(error)[:200]}",
        )
    except Exception as e:
        logger.exception("Generation failed for meeting %s: %s", meeting_id, e)
        _fail_meeting(meeting_id, f"Ошибка генерации: {e}")


class RenameSpeakerRequest(BaseModel):
    old_label: str
    new_label: str


@app.post("/api/v1/meetings/{meeting_id}/speakers/rename")
async def rename_meeting_speaker(meeting_id: str, req: RenameSpeakerRequest):
    """Rename a detected speaker across the whole transcript.

    Turn detection finds where the speaker changed but cannot know who it was,
    so the user assigns real names here. The flat transcript text is rebuilt
    too, because that is what the protocol generator and the RAG index read.
    """
    with get_db() as conn:
        row = conn.execute(
            "SELECT transcript_segments FROM meetings WHERE id = ?", (meeting_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found")

        try:
            segments = json.loads(row["transcript_segments"] or "[]")
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Transcript segments are corrupted")

        if not segments:
            raise HTTPException(status_code=400, detail="This meeting has no transcript yet")

        try:
            segments = stt.rename_speaker(segments, req.old_label, req.new_label)
        except stt.STTError as error:
            raise HTTPException(status_code=400, detail=str(error))

        transcript_text = stt.rebuild_transcript_text(segments)

        conn.execute(
            "UPDATE meetings SET transcript_segments = ?, transcript_text = ? WHERE id = ?",
            (json.dumps(segments, ensure_ascii=False), transcript_text, meeting_id),
        )
        conn.commit()

    speakers = sorted({segment.get("speaker", "") for segment in segments if segment.get("speaker")})
    return {"success": True, "speakers": speakers, "segments_updated": len(segments)}


@app.get("/api/v1/meetings")
async def list_meetings(q: Optional[str] = None):
    with get_db() as conn:
        if q:
            query = "%" + q + "%"
            rows = conn.execute("""
                SELECT id, title, created_at, status, duration_seconds, source_language,
                       error_message, progress, progress_label
                FROM meetings
                WHERE title LIKE ? OR agenda LIKE ? OR transcript_text LIKE ?
                ORDER BY created_at DESC
            """, (query, query, query)).fetchall()
        else:
            rows = conn.execute("""
                SELECT id, title, created_at, status, duration_seconds, source_language,
                       error_message, progress, progress_label
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

EXPORT_FORMATS = {
    "json": ("application/json", "json", exporters.to_json),
    "csv": ("text/csv; charset=utf-8", "csv", exporters.to_csv),
    "ics": ("text/calendar; charset=utf-8", "ics", exporters.to_ics),
}


@app.get("/api/v1/meetings/{meeting_id}/export/{fmt}")
async def export_meeting(meeting_id: str, fmt: str):
    """Machine readable exports: JSON, CSV and a calendar file of the tasks.

    DOCX keeps its own endpoint because it builds a formatted document rather
    than serialising the same payload.
    """
    if fmt not in EXPORT_FORMATS:
        raise HTTPException(
            status_code=404,
            detail=f"Unsupported format '{fmt}'. Available: {', '.join(EXPORT_FORMATS)}",
        )

    with get_db() as conn:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found")

    payload = exporters.build_payload(row)
    media_type, extension, renderer = EXPORT_FORMATS[fmt]

    try:
        body = renderer(payload)
    except Exception as error:
        logger.exception("Export failed for meeting %s as %s", meeting_id, fmt)
        raise HTTPException(status_code=500, detail=f"Не удалось собрать экспорт: {error}")

    safe_title = "".join(
        char if char.isalnum() or char in "-_ " else "_" for char in (row["title"] or "meeting")
    ).strip()[:60] or "meeting"
    filename = f"{safe_title}_{meeting_id[:8]}.{extension}"

    return Response(
        content=body,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/v1/meetings/{meeting_id}/action-items")
async def get_action_items(meeting_id: str):
    """Action items as structured data, for the UI table and integrations."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found")

    payload = exporters.build_payload(row)
    items = payload["action_items"]
    with_dates = sum(1 for item in items if exporters.parse_deadline(item["deadline"]))

    return {
        "items": items,
        "total": len(items),
        "with_parsable_deadline": with_dates,
    }


@app.get("/api/v1/system/offline")
async def system_offline():
    """Report whether the current configuration makes any external request."""
    return offline_report()


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

    whisper_key = get_setting("whisper_api_key", "").strip()
    whisper_headers = get_auth_headers(whisper_key)

    whisper_ok = False
    whisper_err = ""
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            # The key matters here: hosted providers answer 401 on /models
            # without it, which the old check reported as "server down".
            resp = await client.get(f"{whisper_url}/models", headers=whisper_headers)
            if resp.status_code == 200:
                whisper_ok = True
            elif resp.status_code in (401, 403):
                whisper_err = "Провайдер отклонил API-ключ Whisper. Проверьте ключ в настройках."
            elif resp.status_code == 404:
                # Some local Whisper builds expose no /models route but still
                # transcribe fine, so a 404 means reachable, not broken.
                whisper_ok = True
            else:
                whisper_err = f"Эндпоинт вернул код {resp.status_code}"
    except Exception as e:
        whisper_err = str(e)

    ffmpeg_path = stt.resolve_ffmpeg()
    stt_provider = get_setting("stt_provider", "builtin")

    if stt_provider == "builtin":
        # No socket to probe: report whether the library and model are ready.
        if stt.faster_whisper_available():
            device, _ = stt.detect_compute_device()
            model_size = get_setting("whisper_model_size", "") or stt.recommended_model(device)
            whisper_ok = True
            whisper_err = ""
            whisper_where = f"встроенный ({model_size}, {device})"
        else:
            whisper_ok = False
            whisper_err = "Не установлен faster-whisper. Выполните: pip install faster-whisper"
            whisper_where = "встроенный (не установлен)"
    else:
        whisper_where = whisper_url

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
            "url": whisper_where,
            "model": get_setting("whisper_model_size") or get_setting("whisper_model"),
            "provider": stt_provider,
            "error": whisper_err,
        },
        "offline": offline_report(),
        "ffmpeg": {
            "available": bool(ffmpeg_path),
            "path": ffmpeg_path or "",
            "error": "" if ffmpeg_path else (
                "ffmpeg не найден. Длинные записи и видеофайлы будут обрабатываться "
                "медленно или падать. Установите: pip install imageio-ffmpeg"
            ),
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
        "whisper_api_key": get_setting("whisper_api_key", ""),
        "active_preset": detect_active_preset(),
    }


def detect_active_preset() -> str:
    """Report which preset the current settings correspond to, if any."""
    llm_url = get_setting("llm_base_url", "").rstrip("/")
    whisper_url = get_setting("whisper_base_url", "").rstrip("/")
    for name, preset in PROVIDER_PRESETS.items():
        if (
            preset["llm_base_url"].rstrip("/") == llm_url
            and preset["whisper_base_url"].rstrip("/") == whisper_url
        ):
            return name
    return "custom"


@app.get("/api/v1/system/presets")
async def list_presets():
    """Expose the provider presets so the settings UI can offer one-click setup."""
    return {
        "active": detect_active_preset(),
        "presets": [{"id": name, **preset} for name, preset in PROVIDER_PRESETS.items()],
    }


class ApplyPresetRequest(BaseModel):
    preset: str
    api_key: Optional[str] = None


@app.post("/api/v1/system/presets/apply")
async def apply_preset(req: ApplyPresetRequest):
    preset = PROVIDER_PRESETS.get(req.preset)
    if not preset:
        raise HTTPException(status_code=404, detail=f"Unknown preset: {req.preset}")

    key = (req.api_key or "").strip()
    if preset["needs_key"] and not key:
        raise HTTPException(
            status_code=400,
            detail=f"Для провайдера {preset['label']} нужен API-ключ",
        )

    set_setting("llm_base_url", preset["llm_base_url"])
    set_setting("llm_model", preset["llm_model"])
    set_setting("whisper_base_url", preset["whisper_base_url"])
    set_setting("whisper_model", preset["whisper_model"])
    # One key covers both services for Groq and OpenAI. A local preset clears
    # the keys so a leftover cloud token cannot leak into offline mode.
    set_setting("llm_api_key", key)
    set_setting("whisper_api_key", key)

    sync_generation_settings()
    logger.info("Applied provider preset '%s'", req.preset)
    return {"success": True, "preset": req.preset, **await get_config()}


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
    if req.whisper_api_key is not None:
        set_setting("whisper_api_key", req.whisper_api_key.strip())
    sync_generation_settings()
    return {"success": True}

@app.on_event("startup")
async def warm_up_models():
    """Load the transcriber ahead of first use.

    Loading large-v3 into VRAM takes ten to twenty seconds. Paying that on the
    first upload makes the app look slow exactly when someone is timing it, so
    pay it at boot instead, in the background, without blocking the API.
    """
    if get_setting("stt_provider", "builtin") != "builtin":
        return
    if not stt.faster_whisper_available():
        logger.warning("faster-whisper is not installed; skipping warm-up")
        return

    async def load() -> None:
        try:
            device, compute_type = stt.detect_compute_device()
            model_size = get_setting("whisper_model_size", "") or stt.recommended_model(device)
            started = datetime.now(timezone.utc)
            await asyncio.to_thread(stt.load_whisper_model, model_size, device, compute_type)
            elapsed = (datetime.now(timezone.utc) - started).total_seconds()
            logger.info("Whisper '%s' warmed up on %s in %.1fs", model_size, device, elapsed)
        except Exception as error:
            # A failed warm-up must not stop the server; the real transcription
            # will surface the problem with a proper message.
            logger.warning("Whisper warm-up failed: %s", error)

    asyncio.create_task(load())


@app.post("/api/v1/system/selftest")
async def selftest():
    """Run a tiny synthetic clip through the real decode path and time each stage.

    Loading weights and actually decoding are different code paths: a broken
    cuDNN install loads fine and then hangs in the encoder. This exercises the
    second one in a few seconds instead of finding out on a real recording.
    """
    import tempfile
    import time as _time

    stages: List[Dict[str, Any]] = []

    def stage(name: str, ok: bool, seconds: float, detail: str = "") -> None:
        stages.append({"stage": name, "ok": ok, "seconds": round(seconds, 2), "detail": detail})

    ffmpeg = stt.resolve_ffmpeg()
    stage("ffmpeg", bool(ffmpeg), 0.0, ffmpeg or "не найден")
    if not ffmpeg:
        return {"ok": False, "stages": stages}

    work = tempfile.mkdtemp(prefix="steppe_selftest_")
    try:
        # Six seconds of speech-like noise. Whisper may transcribe nothing from
        # it, which is fine: we are testing that the decoder RUNS, not what it
        # hears.
        sample = os.path.join(work, "probe.wav")
        started = _time.monotonic()
        await asyncio.to_thread(
            stt._run,
            [ffmpeg, "-y", "-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:a=0.3",
             "-ar", "16000", "-ac", "1", sample],
        )
        stage("генерация тестового аудио", os.path.exists(sample), _time.monotonic() - started)

        if not os.path.exists(sample):
            return {"ok": False, "stages": stages}

        device, compute_type = stt.detect_compute_device()
        model_size = get_setting("whisper_model_size", "") or stt.recommended_model(device)
        stage("устройство", True, 0.0, f"{device} / {compute_type} / {model_size}")

        started = _time.monotonic()
        try:
            await asyncio.to_thread(stt.load_whisper_model, model_size, device, compute_type)
            stage("загрузка модели", True, _time.monotonic() - started)
        except Exception as error:
            stage("загрузка модели", False, _time.monotonic() - started, str(error)[:300])
            return {"ok": False, "stages": stages}

        started = _time.monotonic()
        try:
            async def report(_percent: float, _label: str) -> None:
                return

            segments, _text, _duration = await stt._transcribe_builtin(
                sample, model_size=model_size, language="ru", report=report
            )
            elapsed = _time.monotonic() - started
            stage("декодирование", True, elapsed, f"{len(segments)} сегментов за {elapsed:.1f}с")
        except Exception as error:
            stage("декодирование", False, _time.monotonic() - started,
                  f"{type(error).__name__}: {str(error)[:300]}")
            return {"ok": False, "stages": stages}

    finally:
        import shutil as _shutil
        _shutil.rmtree(work, ignore_errors=True)

    device_now, _ = stt.detect_compute_device()
    return {
        "ok": all(s["ok"] for s in stages),
        "stages": stages,
        "gpu_memory_mb": stt.query_gpu_memory_mb(),
        "releases_between_stages": stt.should_release_after_use(device_now),
        "offline": offline_report(),
    }


@app.post("/api/v1/system/warmup")
async def warmup_now():
    """Force-load the transcription model and report how long it took."""
    if get_setting("stt_provider", "builtin") != "builtin":
        return {"warmed": False, "reason": "Активен внешний Whisper-сервер, прогрев не требуется"}

    device, compute_type = stt.detect_compute_device()
    model_size = get_setting("whisper_model_size", "") or stt.recommended_model(device)
    started = datetime.now(timezone.utc)
    try:
        await asyncio.to_thread(stt.load_whisper_model, model_size, device, compute_type)
    except stt.STTError as error:
        raise HTTPException(status_code=503, detail=str(error))

    return {
        "warmed": True,
        "model": model_size,
        "device": device,
        "compute_type": compute_type,
        "seconds": round((datetime.now(timezone.utc) - started).total_seconds(), 1),
        "gpu_memory_mb": stt.query_gpu_memory_mb(),
        "releases_between_stages": stt.should_release_after_use(device),
    }


if __name__ == "__main__":
    port = int(os.environ.get("DESKTOP_API_PORT", 8008))
    logger.info("Starting Steppe Meeting Desktop Server on port %d...", port)
    uvicorn.run(app, host="127.0.0.1", port=port)
