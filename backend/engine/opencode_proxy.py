"""Local request proxy through the user's installed OpenCode v2 CLI.

No cloud client, identity headers, credentials, model fallback or public port.
Each request owns its directory and session. Native tool definitions and the
build agent load normally; a configuration policy blocks all tool execution,
including saved approvals and agent-specific allows. Meeting text is stdin.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile
import uuid


@contextmanager
def workspace():
    with tempfile.TemporaryDirectory(prefix='steppe-opencode-') as folder:
        # macOS /var is a symlink. Use one Location identity for run, config
        # and cleanup rather than creating aliases in the shared server.
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
        # The background service reads configuration for this Location, not
        # the CLI client's environment. Both paths must enforce the policy.
        Path(folder, 'opencode.json').write_text(content)
        env.update(PWD=folder, NO_COLOR='1', TERM='dumb',
                   OPENCODE_CONFIG_CONTENT=content, OPENCODE_DISABLE_AUTOUPDATE='1',
                   OPENCODE_DISABLE_CLAUDE_CODE='1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS='1')
        yield folder, env


def command(binary, model):
    return [binary, 'run', '--format', 'json', '--agent', 'build', '--model', model]


async def _cleanup(binary, session_id, folder, env, run):
    for method, suffix in [('POST', '/interrupt'), ('DELETE', '')]:
        try:
            await run([binary, 'api', method, f'/api/session/{session_id}{suffix}'],
                      cwd=folder, env=env, timeout=5)
        except Exception:
            # Best effort, including when creation failed. Never hide the
            # inference error, retry inference or touch another session.
            pass


async def request(binary, model, text, *, run, timeout):
    """One bounded CLI turn; return its structured output for adapter parsing.

    `run` owns process groups, pipe limits and cancellation. Passing it in keeps
    one process implementation for all CLI providers and a real executable seam
    for tests. Cleanup is bounded independently and survives task cancellation.
    """
    with workspace() as (folder, env):
        session_id = 'ses_' + uuid.uuid4().hex[:26]
        try:
            return await run(command(binary, model) + ['--session', session_id],
                             cwd=folder, env=env, stdin=text, timeout=timeout)
        finally:
            await asyncio.shield(_cleanup(binary, session_id, folder, env, run))
