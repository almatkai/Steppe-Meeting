"""
Local Embeddings & HyDE generator for Steppe Meeting Desktop.
Interacts with local Ollama (/v1/embeddings or /api/embeddings) with
an automatic lightweight feature-hashing fallback if local Ollama embeddings
are not yet loaded.
"""

import asyncio
import hashlib
import logging
import math
import re
from typing import List, Optional

import httpx

from .config import settings
from . import llm

logger = logging.getLogger("steppe.embeddings")


def _deterministic_hash_vector(text: str, dim: int = 384) -> List[float]:
    """
    Lightweight feature hashing vectorizer (zero-dependency fallback).
    Converts text tokens and n-grams into a normalized float vector of size `dim`.
    Guarantees lexical and semantic overlap search works even if Ollama is offline.
    """
    vector = [0.0] * dim
    words = re.findall(r"\w+", text.lower(), re.UNICODE)
    if not words:
        return [0.0] * dim

    for i, word in enumerate(words):
        # Unigram hash
        h1 = int(hashlib.md5(word.encode("utf-8")).hexdigest(), 16) % dim
        vector[h1] += 1.0

        # Bigram hash
        if i < len(words) - 1:
            bigram = f"{word}_{words[i+1]}"
            h2 = int(hashlib.md5(bigram.encode("utf-8")).hexdigest(), 16) % dim
            vector[h2] += 1.5

    # L2 normalize
    norm = math.sqrt(sum(x * x for x in vector))
    if norm > 1e-9:
        vector = [x / norm for x in vector]

    return vector


async def embed_texts(texts: List[str], model: Optional[str] = None) -> List[List[float]]:
    """
    Embeds a list of texts using local Ollama endpoint.
    Falls back to feature hashing if Ollama is unreachable or model doesn't support embeddings.
    """
    if not texts:
        return []

    target_model = (
        model
        or getattr(settings, "OLLAMA_MODEL", None)
        or getattr(settings, "LLM_MODEL", "qwen2.5:latest")
    )
    raw_url = (
        getattr(settings, "OLLAMA_URL", None)
        or getattr(settings, "LLM_BASE_URL", "http://localhost:11434/v1")
    )
    if raw_url.endswith("/v1"):
        host_url = raw_url[:-3].rstrip("/")
        v1_url = raw_url.rstrip("/")
    else:
        host_url = raw_url.rstrip("/")
        v1_url = f"{host_url}/v1"

    # Strategy 1: OpenAI-compatible /v1/embeddings on Ollama
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                f"{v1_url}/embeddings",
                json={"model": target_model, "input": texts},
                headers={"Content-Type": "application/json"},
            )
            if response.status_code == 200:
                data = response.json()
                ordered = sorted(data.get("data", []), key=lambda x: x.get("index", 0))
                vectors = [item["embedding"] for item in ordered]
                if len(vectors) == len(texts):
                    return vectors
    except Exception as e:
        logger.debug("Ollama /v1/embeddings attempt failed: %s", e)

    # Strategy 2: Ollama native /api/embeddings (single or batched)
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            vectors = []
            for text in texts:
                resp = await client.post(
                    f"{host_url}/api/embeddings",
                    json={"model": target_model, "prompt": text},
                    headers={"Content-Type": "application/json"},
                )
                if resp.status_code == 200:
                    vec = resp.json().get("embedding")
                    if vec:
                        vectors.append(vec)
                    else:
                        break
                else:
                    break

            if len(vectors) == len(texts):
                return vectors
    except Exception as e:
        logger.debug("Ollama /api/embeddings attempt failed: %s", e)

    # Strategy 3: Zero-dependency fallback
    logger.info("Using local deterministic feature hashing for %d text(s)", len(texts))
    return [_deterministic_hash_vector(t, dim=384) for t in texts]


_HYDE_PROMPT = (
    "Напиши короткий гипотетический фрагмент официального протокола или резюме совещания, "
    "который точно и исчерпывающе отвечает на следующий вопрос. "
    "Не пиши никаких вводных слов, пояснений или заголовков — только сам фрагмент текста.\n\n"
    "Вопрос: {query}"
)


async def generate_hyde_vector(query: str, model: Optional[str] = None) -> Optional[List[float]]:
    """
    Generates a hypothetical document snippet for query expansion (HyDE),
    then embeds it. Returns None if LLM is unavailable.
    """
    try:
        prompt = _HYDE_PROMPT.format(query=query)
        hypothetical_doc = await asyncio.wait_for(
            llm.complete_text(prompt, temperature=0.2),
            timeout=8.0,
        )
        if hypothetical_doc and len(hypothetical_doc.strip()) > 10:
            vectors = await embed_texts([hypothetical_doc], model=model)
            if vectors:
                return vectors[0]
    except Exception as e:
        logger.debug("HyDE generation skipped or timed out: %s", e)

    return None
