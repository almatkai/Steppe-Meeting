"""
Desktop Application Configuration.
Standalone, local-first configuration model without cloud or corporate dependencies.
"""

from typing import Optional
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    DEBUG: bool = False
    APP_NAME: str = "Steppe Meeting"

    # Local LLM (Ollama or OpenAI-compatible)
    LLM_BASE_URL: str = "http://localhost:11434/v1"
    LLM_API_KEY: str = ""
    LLM_MODEL: str = "qwen2.5:latest"
    LLM_PRIMARY: str = "local"
    LLM_TIMEOUT: float = 300.0
    LLM_LOG_DIR: str = "data/logs/llm"
    OPENAI_LLM_MODEL: str = "gpt-4o"
    OPENAI_API_KEY: str = ""

    # Local STT (Whisper)
    STT_SERVICE_BASE_URL: str = "http://localhost:8000/v1"
    STT_RESPONSE_TIMEOUT: float = 1800.0
    OPENAI_WHISPER_MODEL: str = "whisper-1"

    TEMPLATE_TEST_TIMEOUT: float = 600.0
    TEMPLATE_GENERATION_MAX_PROMPT_CHARS: int = 300_000

    # Generation & chunking thresholds
    MAX_TRANSCRIPT_WORDS: int = 50_000
    GENERATION_CHUNK_RETRIES: int = 2
    GENERATION_MAX_CONCURRENT_CHUNKS: int = 4
    OLLAMA_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen2.5:latest"

    class Config:
        extra = "allow"

settings = Settings()
