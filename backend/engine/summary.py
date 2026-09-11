"""The summary pipeline.

Extract the topics, decisions, commitments and problems from each chunk, then
combine them into one structured summary. Kazakh is a translation of the
finished Russian, as it is for protocols.

``GenerationError`` is shared with ``protocol`` rather than redefined: a caller
generating all four artifacts handles one failure type, not two that mean the
same thing.

The old service had a name-correction stage between combining and translating.
It ran only when participants or an agenda were supplied, and automatic
generation supplies neither, so it belongs with the regeneration phase that
introduces them.
"""
import logging

from .core import retries
from .config import settings
from . import chunking
from . import llm
from . import prompts
from . import schemas
from .protocol import GenerationError
from .protocol import gather_chunks
from .protocol import stage

logger = logging.getLogger(__name__)


async def _extract_chunk(piece: dict) -> dict:
    messages = [
        {'role': 'system', 'content': prompts.SUMMARY_CHUNK_SYSTEM},
        {'role': 'user', 'content': prompts.summary_chunk_user(
            text=piece['text'],
            chunk_id=piece['chunk_id'],
            total_chunks=piece['total_chunks'],
        )},
    ]

    async def _complete(messages):
        return await llm.complete_json(messages)

    call = retries.retry_wrap(
        _complete,
        exception=llm.LLMError,
        max_retries=settings.GENERATION_CHUNK_RETRIES + 1,
        max_value=0,
        factor=1,
    )

    try:
        result = await call(messages)
    except llm.LLMError as e:
        raise GenerationError(f"chunk {piece['chunk_id']} could not be read: {e}") from e

    result['chunk_id'] = piece['chunk_id']
    return result


async def generate(transcript_text: str) -> dict:
    """Produce the Russian summary from a transcript."""
    try:
        pieces = chunking.chunk(transcript_text)
    except ValueError as e:
        raise GenerationError(str(e)) from e

    logger.info('Generating a summary from %s chunks', len(pieces))

    results = await gather_chunks(pieces, _extract_chunk)

    return await stage(
        prompts.SUMMARY_FINAL_SYSTEM,
        prompts.summary_final_user(list(results)),
        'summary generation',
        schemas.SummaryFinal,
    )


async def translate(summary_ru: dict) -> dict:
    """Translate a finished Russian summary into Kazakh."""
    return await stage(
        prompts.TRANSLATE_SUMMARY_SYSTEM,
        prompts.translate_summary_user(summary_ru),
        'summary translation to Kazakh',
    )


async def translate_english(summary_ru: dict) -> dict:
    """Translate a finished Russian summary into English."""
    return await stage(
        prompts.TRANSLATE_SUMMARY_ENGLISH_SYSTEM,
        prompts.translate_summary_user(summary_ru),
        'summary translation to English',
    )
