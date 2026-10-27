"""Text generation through an owned, loopback-only OpenCode v2 CLI server.

Use the supported session/prompt + event protocol used by T3's v2 driver.
The CLI owns cloud authentication and inference. Its native default agent and
tools load normally, but policies deny execution and permission requests are
rejected. No connection to another application's server or session.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import tempfile
import urllib.parse

import httpx


@contextmanager
def workspace():
    with tempfile.TemporaryDirectory(prefix='steppe-opencode-') as folder:
        # macOS /var is a symlink. Keep one Location identity for configuration,
        # session creation and cleanup.
        folder = str(Path(folder).resolve())
        env = os.environ.copy()
        for key in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID',
                    'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_PROJECT_ID',
                    'OPENCODE_SESSION_ID', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
                    'OPENCODE_DISABLE_PROJECT_CONFIG'):
            env.pop(key, None)
        config = {
            # Policies apply after permissions and saved approvals. Keep
            # permissions as ask so the native harness can expose its tools.
            'policies': [{'action': 'tool.use', 'resource': '*', 'effect': 'deny'}],
            'permissions': [{'action': '*', 'resource': '*', 'effect': 'ask'}],
            # Third-party plugins and configured MCP can run code at startup.
            # Retain built-in tool plugins instead of removing their schemas.
            'plugins': ['-*', 'opencode.*', '-opencode.config.mcp', '-opencode.warming'],
            'warming': False, 'share': 'disabled', 'instructions': [],
            'lsp': False, 'formatter': False,
        }
        content = json.dumps(config)
        # Discovery and the owned server both use this isolated Location.
        Path(folder, 'opencode.json').write_text(content)
        env.update(PWD=folder, NO_COLOR='1', TERM='dumb',
                   OPENCODE_CONFIG_CONTENT=content, OPENCODE_DISABLE_AUTOUPDATE='1',
                   OPENCODE_DISABLE_CLAUDE_CODE='1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS='1')
        yield folder, env


MAX_OUTPUT = 8 * 1024 * 1024
MAX_LOG = 64 * 1024
CLEANUP_TIMEOUT = 5


class ProxyError(Exception):
    """Safe diagnostics only: never include HTTP bodies, logs or input."""


async def _drain(stream):
    # Drain without retaining logs: both startup and inference can echo input.
    size = 0
    while chunk := await stream.read(16384):
        size += len(chunk)
        if size > MAX_LOG:
            raise ProxyError('Вывод сервера OpenCode превысил допустимый размер')


async def _stop(process):
    # Only our process group; children can outlive the CLI's main process.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            if os.name == 'posix':
                os.killpg(process.pid, sig)
            elif process.returncode is None:
                process.kill()
        except ProcessLookupError:
            pass
        if sig == signal.SIGTERM:
            await asyncio.sleep(.1)
    await process.wait()


async def _json(client, method, path, payload=None):
    async with client.stream(method, path, json=payload) as response:
        if not response.is_success:
            raise ProxyError('Локальный сервер OpenCode отклонил запрос')
        chunks, size = [], 0
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > MAX_OUTPUT:
                raise ProxyError('Ответ OpenCode превысил допустимый размер')
            chunks.append(chunk)
        raw = b''.join(chunks)
        return json.loads(raw) if raw else None


@asynccontextmanager
async def _server(binary, folder, env):
    # The random password protects the ephemeral listener, including the small
    # gap between choosing a free port and binding it. Verify the owning PID.
    with socket.socket() as address:
        address.bind(('127.0.0.1', 0))
        port = address.getsockname()[1]
    password = secrets.token_urlsafe(32)
    env = dict(env, OPENCODE_PASSWORD=password)
    env.pop('OPENCODE_SERVER_PASSWORD', None)
    process = await asyncio.create_subprocess_exec(
        binary, 'serve', '--hostname=127.0.0.1', f'--port={port}',
        cwd=folder, env=env, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        start_new_session=(os.name == 'posix'))
    drains = [asyncio.create_task(_drain(process.stdout)),
              asyncio.create_task(_drain(process.stderr))]
    try:
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}',
                                     auth=('opencode', password), trust_env=False,
                                     timeout=5) as client:
            async with asyncio.timeout(15):
                while True:
                    for task in drains:
                        if task.done():
                            task.result()
                    if process.returncode is not None:
                        raise ProxyError('Сервер OpenCode завершился при запуске')
                    try:
                        info = await _json(client, 'GET', '/api/info')
                        if not str(info.get('version', '')).startswith('2.'):
                            raise ProxyError('Для CLI прокси требуется OpenCode v2')
                        if info.get('pid') != process.pid:
                            raise ProxyError('Не удалось подтвердить собственный сервер OpenCode')
                        break
                    except httpx.ConnectError:
                        await asyncio.sleep(.05)
            yield client, drains
    finally:
        await asyncio.shield(_stop(process))
        for task in drains:
            task.cancel()
        await asyncio.gather(*drains, return_exceptions=True)


def _model(model):
    slug, separator, variant = model.partition('#')
    provider, name = slug.split('/', 1)
    return dict(providerID=provider, id=name, **({'variant': variant} if separator else {}))


async def _events(response):
    # Bound bytes before decoding/splitting: a hostile line must not bypass
    # the memory limit of a convenient but unbounded aiter_lines().
    buffer, size, data = b'', 0, []
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_OUTPUT:
            raise ProxyError('Ответ OpenCode превысил допустимый размер')
        buffer += chunk
        while b'\n' in buffer:
            line, buffer = buffer.split(b'\n', 1)
            line = line.rstrip(b'\r')
            if line.startswith(b'data:'):
                data.append(line[5:].lstrip())
            elif not line and data:
                yield json.loads(b'\n'.join(data))
                data = []
    raise ProxyError('Поток событий OpenCode завершился без результата')


def _failure(error):
    # Only the category/status and structured free-tier type are needed by
    # cli_llm.parse_reply. Drop messages, headers and echoed request bodies.
    safe = {key: error[key] for key in ('type', 'status') if key in error}
    body = (error.get('response') or {}).get('body')
    if isinstance(body, str):
        try:
            kind = json.loads(body).get('error', {}).get('type')
            if kind in ('FreeUsageLimitError', 'FreeTierError'):
                safe['response'] = {'body': json.dumps({'error': {'type': kind}})}
        except (ValueError, AttributeError):
            pass
    return 1, json.dumps({'type': 'error', 'error': safe}), ''


async def _cleanup(client, session):
    for method, suffix in [('POST', '/interrupt'), ('DELETE', '')]:
        try:
            async with asyncio.timeout(CLEANUP_TIMEOUT):
                await _json(client, method, f'/api/session/{session}{suffix}')
        except Exception:
            pass


async def _turn(client, folder, model, text):
    # Let the native server allocate the session identity, as its SDK does.
    # In 2.1.4, manual UUID IDs received a free-tier 429 while a native ID
    # succeeded on the same server/model/prompt. Don't invent session IDs.
    session = None
    try:
        created = await _json(client, 'POST', '/api/session', {
            'location': {'directory': folder},
            'model': _model(model),
            'title': 'Steppe text generation',
            'permissions': [{'action': '*', 'resource': '*', 'effect': 'ask'}]})
        session = created['data']['id']
        if not isinstance(session, str) or not re.fullmatch(r'ses_[A-Za-z0-9_-]{1,100}', session):
            session = None
            raise ProxyError('OpenCode вернул некорректную сессию')
        texts = {}
        async with client.stream('GET', '/api/event', timeout=None) as response:
            if not response.is_success:
                raise ProxyError('Не удалось открыть поток событий OpenCode')
            await _json(client, 'POST', f'/api/session/{session}/prompt', {'text': text})
            async for event in _events(response):
                data = event.get('data') or {}
                if data.get('sessionID') != session:
                    continue
                kind = event.get('type')
                if kind == 'permission.asked':
                    await _json(client, 'POST',
                                f'/api/session/{session}/permission/{urllib.parse.quote(data["id"], safe="")}/reply',
                                {'decision': 'reject', 'message': 'Tools are not available while generating text.'})
                elif kind == 'session.text.ended':
                    texts[(data['assistantMessageID'], data['ordinal'])] = data['text']
                elif kind == 'session.execution.failed':
                    return _failure(data.get('error') or {})
                elif kind == 'session.execution.interrupted':
                    raise ProxyError('OpenCode прервал генерацию')
                elif kind == 'session.execution.succeeded':
                    reply = '\n'.join(texts.values()).strip()
                    if not reply:
                        raise ProxyError('OpenCode вернул пустой ответ ассистента')
                    return 0, json.dumps({'type': 'text', 'part': {'text': reply}}), ''
    finally:
        if session is not None:
            await asyncio.shield(_cleanup(client, session))


async def request(binary, model, text, *, timeout):
    """One admitted prompt, bounded lifetime/output, no retry or fallback."""
    try:
        async with asyncio.timeout(timeout):
            with workspace() as (folder, env):
                async with _server(binary, folder, env) as (client, drains):
                    turn = asyncio.create_task(_turn(client, folder, model, text))
                    try:
                        done, _ = await asyncio.wait([turn, *drains], return_when=asyncio.FIRST_COMPLETED)
                        for task in drains:
                            if task in done:
                                task.result()
                                raise ProxyError('Сервер OpenCode завершился без результата')
                        return await turn
                    finally:
                        if not turn.done():
                            turn.cancel()
                        await asyncio.gather(turn, return_exceptions=True)
    except TimeoutError:
        raise ProxyError(f'OpenCode не ответил за {timeout:g} с') from None
    except (httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError):
        raise ProxyError('Не удалось обработать ответ локального сервера OpenCode') from None
