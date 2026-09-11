"""Splitting a transcript into pieces the model can hold at once.

The window is sized in words rather than tokens because counting tokens needs
the model's tokenizer; the ratios below are the estimates the previous backend
arrived at, kept so chunk boundaries land where they used to.

Consecutive chunks overlap. The old service had a ``chunk_without_overlap``
alongside this, but it computed the same overlap and passed it to the same
builder — the two differed only in whether an agenda was attached, so there was
never a non-overlapping mode to preserve.
"""
import re

from .config import settings

TARGET_TOKENS = 3000
OVERLAP_TOKENS = 200

_CYRILLIC_RE = re.compile(r'[а-яА-ЯәіңғүұқөһӘІҢҒҮҰҚӨҺ]')
_LATIN_RE = re.compile(r'[a-zA-Z]')

# Words per token, by script. Cyrillic tokenizes into more pieces per word than
# Latin does, so the same token budget buys fewer words. Public because
# search/chunking.py sizes its own, smaller chunks off the same estimate.
WORDS_PER_TOKEN = {
    'cyrillic': 0.55,
    'latin': 0.75,
    'mixed': 0.6,
}


def detect_language(text: str) -> str:
    """Classify a transcript by script, from a leading sample."""
    sample = text[:1000]
    cyrillic = len(_CYRILLIC_RE.findall(sample))
    latin = len(_LATIN_RE.findall(sample))

    if cyrillic > latin * 1.5:
        return 'cyrillic'

    if latin > cyrillic * 1.5:
        return 'latin'

    return 'mixed'


def chunk(text: str, participants: list | None = None, agenda: str = '') -> list[dict]:
    """Split a transcript into overlapping chunks.

    ``participants`` and ``agenda`` are attached to every chunk because the
    extraction prompt interpolates them per chunk. Both default to empty rather
    than None: the prompt renders them directly, and None would reach the model
    as the word "None".
    """
    if not text or not text.strip():
        raise ValueError('Cannot chunk an empty transcript')

    words = text.split()
    if len(words) > settings.MAX_TRANSCRIPT_WORDS:
        raise ValueError(
            f'Transcript is too long to generate from ({len(words)} words, '
            f'limit {settings.MAX_TRANSCRIPT_WORDS})'
        )

    language = detect_language(text)
    words_per_token = WORDS_PER_TOKEN[language]
    words_per_chunk = int(TARGET_TOKENS * words_per_token)
    overlap_words = int(OVERLAP_TOKENS * words_per_token)

    total_words = len(words)

    chunks: list[dict] = []
    index = 0

    while index < total_words:
        end = min(index + words_per_chunk, total_words)
        window = words[index:end]

        chunks.append({
            'chunk_id': len(chunks),
            'text': ' '.join(window),
            'word_count': len(window),
            'participants': participants or [],
            'agenda': agenda or '',
            'total_chunks': 0,  # back-filled once the count is known
            'detected_language': language,
        })

        index += words_per_chunk - overlap_words

        if index >= total_words or end >= total_words:
            break

    for piece in chunks:
        piece['total_chunks'] = len(chunks)

    return chunks
