"""Calling the language model.

Two providers: a model hosted inside the network, and OpenAI. ``LLM_PRIMARY``
decides which is tried first; the other is the fallback, so a local outage
degrades to a paid provider rather than to a failed meeting.
"""
import asyncio
import datetime
import json
import logging
import pathlib
import time
import typing
import uuid

import httpx

from .core import lazy_client
from .config import settings
from . import telemetry

logger = logging.getLogger(__name__)


class LLMError(Exception):
    """Raises when no provider produced usable output."""

    def __init__(self, message, *, response_text=None):
        super().__init__(message)
        self.response_text = response_text


_client: httpx.AsyncClient | None = None


def _safe_path_part(value) -> str:
    value = str(value or 'ungrouped')
    return ''.join(character if character.isalnum() or character in '-_' else '_'
                   for character in value)


def _call_log_path(call_id, provider):
    context = telemetry.context()
    directory = pathlib.Path(settings.LLM_LOG_DIR)
    directory /= _safe_path_part(context.get('job_id'))
    directory /= f"attempt-{_safe_path_part(context.get('attempt', 'unknown'))}"
    return directory / f"{call_id}-{_safe_path_part(provider)}.json"


def _write_call_log(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


async def _save_call_log(path, record):
    try:
        await asyncio.to_thread(_write_call_log, path, record)
    except Exception as error:
        logger.warning('llm_call_log_write_failed path=%s error_type=%s',
                       path, type(error).__name__)


def client() -> httpx.AsyncClient:
    """A shared, pooled client, the same pattern vector_store.py already
    uses for Qdrant -- one per process instead of a fresh TCP+TLS handshake
    on every completion/stream call, of which a single chat turn makes
    several (query embed, rerank, then this)."""
    global _client
    _client = lazy_client.get_or_create(
        _client, lambda: httpx.AsyncClient(timeout=settings.LLM_TIMEOUT),
    )
    return _client


async def close() -> None:
    """Close the shared client, if one was ever created. Called from the API
    and worker shutdown paths -- without this the pooled connection outlives
    the process's own lifespan hooks, unlike Postgres and Kafka."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def _call(
    url: str, model: str, headers: dict, messages: list, temperature: float,
    json_mode: bool = True, max_tokens: int | None = None,
):
    payload = {
        'model': model,
        'messages': messages,
        'temperature': temperature,
    }
    if json_mode:
        payload['response_format'] = {'type': 'json_object'}
    if max_tokens is not None:
        payload['max_tokens'] = max_tokens

    call_id = uuid.uuid4().hex[:12]
    started = time.monotonic()
    provider = 'openai' if url.startswith('https://api.openai.com/') else 'local'
    details = {'call_id': call_id, 'model': model, 'provider': provider}
    log_path = _call_log_path(call_id, provider)
    log_record = {
        'call_id': call_id,
        'provider': provider,
        'model': model,
        'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'request': payload,
        'response': None,
        'error': None,
    }
    # Prompt logging is intentionally local and full. outputs/ is gitignored;
    # it contains transcript/PII and must never be committed or uploaded.
    await _save_call_log(log_path, log_record)
    await telemetry.emit('llm_started', **details,
                         prompt_chars=sum(len(str(m.get('content', ''))) for m in messages))
    request = asyncio.create_task(client().post(url, json=payload, headers=headers))
    try:
        while not request.done():
            done, _ = await asyncio.wait([request], timeout=30)
            if not done:
                await telemetry.emit('llm_waiting', **details,
                                     elapsed_seconds=round(time.monotonic() - started, 2))
        response = await request
        response.raise_for_status()
        body = response.json()
        log_record['completed_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        log_record['elapsed_seconds'] = round(time.monotonic() - started, 2)
        log_record['response'] = body
        await _save_call_log(log_path, log_record)
        usage = body.get('usage') or {}

        def tokens(key):
            value = usage.get(key)
            return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
        await telemetry.emit(
            'llm_completed', **details,
            elapsed_seconds=round(time.monotonic() - started, 2),
            input_tokens=tokens('prompt_tokens'), output_tokens=tokens('completion_tokens'),
        )
        return body['choices'][0]['message']['content']
    except asyncio.CancelledError:
        log_record['completed_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        log_record['elapsed_seconds'] = round(time.monotonic() - started, 2)
        log_record['error'] = {'type': 'CancelledError', 'message': 'request cancelled'}
        await _save_call_log(log_path, log_record)
        await telemetry.emit('llm_cancelled', **details,
                             elapsed_seconds=round(time.monotonic() - started, 2))
        raise
    except Exception as error:
        log_record['completed_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        log_record['elapsed_seconds'] = round(time.monotonic() - started, 2)
        log_record['error'] = {'type': type(error).__name__, 'message': str(error)}
        await _save_call_log(log_path, log_record)
        await telemetry.emit('llm_failed', **details, error_type=type(error).__name__,
                             elapsed_seconds=round(time.monotonic() - started, 2))
        raise
    finally:
        request.cancel()
        await asyncio.gather(request, return_exceptions=True)


def get_chat_completions_url(base_url: str) -> str:
    """Normalizes any provider base URL to the /chat/completions endpoint."""
    url = (base_url or '').strip().rstrip('/')
    if url.endswith('/chat/completions'):
        return url
    if url.endswith('/v1'):
        return f'{url}/chat/completions'
    return f'{url}/v1/chat/completions'


def get_auth_headers(api_key: str | None) -> dict[str, str]:
    if not api_key or not api_key.strip():
        return {}
    key = api_key.strip()
    if key.lower().startswith('bearer '):
        key = key[7:].strip()
    return {'Authorization': f'Bearer {key}'}


async def _call_local(
    messages: list, temperature: float, json_mode: bool = True,
    max_tokens: int | None = None,
) -> str:
    headers = get_auth_headers(settings.LLM_API_KEY)
    url = get_chat_completions_url(settings.LLM_BASE_URL)

    return await _call(
        url,
        settings.LLM_MODEL,
        headers,
        messages,
        temperature,
        json_mode=json_mode,
        max_tokens=max_tokens,
    )


async def _call_openai(
    messages: list, temperature: float, json_mode: bool = True,
    max_tokens: int | None = None,
) -> str:
    if not settings.OPENAI_API_KEY:
        raise LLMError('OPENAI_API_KEY is not set')

    return await _call(
        'https://api.openai.com/v1/chat/completions',
        settings.OPENAI_LLM_MODEL,
        {'Authorization': f'Bearer {settings.OPENAI_API_KEY}'},
        messages,
        temperature,
        json_mode=json_mode,
        max_tokens=max_tokens,
    )


def _parse(content: str) -> dict:
    """Read the JSON object out of a reply.

    Local models prepend commentary despite the instruction not to, so a reply
    that is not bare JSON is salvaged by taking the outermost braces before it
    is given up on. A value that parses but is not an object (a list, string or
    number) is just as unusable as invalid JSON: every caller treats the result
    as a dict, so that is enforced here rather than left to fail wherever the
    caller first calls `.get` on it.
    """
    if not isinstance(content, str):
        raise LLMError(f'The model returned no string content: {type(content).__name__}')

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        start = content.find('{')
        end = content.rfind('}') + 1

        if start == -1 or end <= start:
            raise LLMError(f'The model returned no JSON: {e}', response_text=content) from e

        try:
            parsed = json.loads(content[start:end])
        except json.JSONDecodeError as e:
            raise LLMError(f'The model returned malformed JSON: {e}', response_text=content) from e

    if not isinstance(parsed, dict):
        raise LLMError(
            f'The model returned a JSON {type(parsed).__name__}, not an object',
            response_text=content,
        )

    return parsed


async def complete_json(messages: list[dict], temperature: float = 0.1) -> dict:
    """Ask the model for a JSON object, trying both providers before failing."""
    local = ('local', _call_local)
    openai = ('openai', _call_openai)
    if settings.OPENAI_API_KEY and settings.LLM_PRIMARY.lower() == 'openai':
        providers = [openai, local]
    elif settings.OPENAI_API_KEY:
        providers = [local, openai]
    else:
        providers = [local]

    last_error = None
    output_error = None
    for index, (name, call) in enumerate(providers):
        try:
            content = await call(messages, temperature)
            parsed = _parse(content)
        except Exception as error:
            await telemetry.emit('llm_provider_failed', provider=name,
                                 error_type=type(error).__name__)
            last_error = error
            if isinstance(error, LLMError) and error.response_text is not None:
                output_error = error
            if index + 1 < len(providers):
                await telemetry.emit('llm_fallback', provider=providers[index + 1][0])
            continue
        return parsed

    if output_error is not None:
        raise LLMError(
            f'No LLM provider produced usable output. JSON error: {output_error}. '
            f'Last provider error: {last_error}',
            response_text=output_error.response_text,
        ) from output_error
    raise LLMError(f'No LLM provider produced usable output. Last error: {last_error}')


async def complete_text(prompt: str, temperature: float = 0.5) -> str:
    """Ask the model for a plain one-shot completion -- no JSON mode, no
    streaming. Tries both providers before failing, the same fallback
    order complete_json and stream_chat already use."""
    messages = [{'role': 'user', 'content': prompt}]
    local = (
        'local',
        lambda: _call_local(messages, temperature, json_mode=False, max_tokens=300),
    )
    openai = (
        'openai',
        lambda: _call_openai(messages, temperature, json_mode=False, max_tokens=300),
    )
    if settings.OPENAI_API_KEY and settings.LLM_PRIMARY.lower() == 'openai':
        providers = [openai, local]
    elif settings.OPENAI_API_KEY:
        providers = [local, openai]
    else:
        providers = [local]

    last_error = None
    for name, call in providers:
        try:
            content = await call()
        except Exception as e:
            logger.warning('LLM provider %s failed: %s: %s', name, type(e).__name__, e)
            last_error = e
            continue

        if not content or not content.strip():
            logger.warning('LLM provider %s returned an empty reply', name)
            last_error = LLMError(f'Provider {name} returned an empty reply')
            continue

        return content

    raise LLMError(f'No LLM provider produced usable output. Last error: {last_error}')


async def _stream(url: str, model: str, headers: dict, messages: list, temperature: float):
    payload = {
        'model': model,
        'messages': messages,
        'temperature': temperature,
        'stream': True,
    }

    async with client().stream('POST', url, json=payload, headers=headers) as response:
        response.raise_for_status()

        if 'text/event-stream' not in response.headers.get('content-type', ''):
            # The provider ignored stream:true (or does not support it)
            # -- degrade to yielding the whole reply as one chunk rather
            # than failing outright.
            body = await response.aread()
            content = json.loads(body)['choices'][0]['message']['content']
            if not content:
                # An empty reply is not usable output either -- raising
                # here (before anything was yielded) lets stream_chat's
                # fallback try the other provider instead of silently
                # completing with nothing, which would have persisted an
                # empty assistant message as if the turn had succeeded.
                raise LLMError(f'Provider returned an empty non-streaming reply: {body!r}')
            yield content
            return

        async for line in response.aiter_lines():
            if not line.startswith('data: '):
                continue
            data = line[len('data: '):]
            if data == '[DONE]':
                break

            delta = json.loads(data)['choices'][0].get('delta', {}).get('content')
            if delta:
                yield delta


async def _stream_local(messages: list, temperature: float):
    headers = get_auth_headers(settings.LLM_API_KEY)
    url = get_chat_completions_url(settings.LLM_BASE_URL)

    async for chunk in _stream(
        url, settings.LLM_MODEL,
        headers, messages, temperature,
    ):
        yield chunk


async def _stream_openai(messages: list, temperature: float):
    if not settings.OPENAI_API_KEY:
        raise LLMError('OPENAI_API_KEY is not set')

    async for chunk in _stream(
        'https://api.openai.com/v1/chat/completions', settings.OPENAI_LLM_MODEL,
        {'Authorization': f'Bearer {settings.OPENAI_API_KEY}'}, messages, temperature,
    ):
        yield chunk


async def stream_chat(
    messages: list[dict], temperature: float = 0.3,
) -> typing.AsyncIterator[str]:
    """Stream a chat reply, trying both providers before the first token.

    Once a provider has yielded at least one chunk, a later failure from
    that same provider ends the stream (raises LLMError) instead of
    silently switching providers mid-response -- a reply assembled from two
    different models is worse than an honest cutoff. See
    docs/superpowers/specs/2026-08-10-ai-chatbot-design.md section 5.
    """
    local = ('local', _stream_local)
    openai = ('openai', _stream_openai)
    if settings.OPENAI_API_KEY and settings.LLM_PRIMARY.lower() == 'openai':
        providers = [openai, local]
    elif settings.OPENAI_API_KEY:
        providers = [local, openai]
    else:
        providers = [local]

    last_error = None
    for name, call in providers:
        started = False
        try:
            async for chunk in call(messages, temperature):
                started = True
                yield chunk
            return
        except Exception as e:
            if started:
                raise LLMError(f'Provider {name} failed mid-stream: {e}') from e
            logger.warning('LLM provider %s failed before streaming began: %s', name, e)
            last_error = e
            continue

    raise LLMError(f'No LLM provider produced a response. Last error: {last_error}')
