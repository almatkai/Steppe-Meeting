"""Real process + loopback protocol regression for T3-compatible OpenCode turns."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import cli_llm as cli, opencode_proxy as proxy

SID = 'ses_steppe_owned_test_session'
def event(kind, **data):
    return {'type': kind, 'data': {'sessionID': SID, **data}}

class OpenCodeProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.storage = tempfile.TemporaryDirectory(prefix='steppe-opencode-test-')
        self.folder = Path(self.storage.name)
        self.capture = self.folder / 'capture.jsonl'

    async def asyncTearDown(self):
        self.storage.cleanup()

    def binary(self, events, mode=""):
        fixture = Path(__file__).parent / 'fixtures/cli/opencode-server.py'
        binary = self.folder / 'OpenCode CLI'
        binary.write_text(f'#!{Path(sys.executable).resolve()}\nCAPTURE={str(self.capture)!r}\nEVENTS={events!r}\nMODE={mode!r}\n' + fixture.read_text())
        binary.chmod(0o700)
        return str(binary)

    def records(self):
        return [json.loads(line) for line in self.capture.read_text().splitlines()]

    async def test_cli_complete_uses_owned_v2_session_instead_of_rejected_run(self):
        binary = self.binary([
            event('session.text.ended', assistantMessageID='msg_owned', ordinal=0, text='OK'),
            event('session.execution.succeeded'),
        ])
        model = 'opencode/deepseek-v4.1-flash-free#high'
        messages = [{'role': role, 'content': f'{role}: Привет ' + 'я' * 10000}
                    for role in ('system', 'user', 'assistant', 'user')]
        with patch.dict(os.environ, OPENCODE_SESSION_ID='ses_UNRELATED'):
            reply = await cli.complete('opencode', binary, model, messages, json_mode=True, timeout=5)
        self.assertEqual(reply, 'OK')
        calls = self.records()
        self.assertEqual(calls[0]['argv'][0], 'serve')
        self.assertIsNone(calls[0]['nested'])
        self.assertEqual(calls[0]['cwd'], calls[0]['pwd'])
        self.assertFalse(Path(calls[0]['cwd']).exists())
        create = next(c['body'] for c in calls if c.get('path') == '/api/session')
        owned = next(c['path'].split('/')[3] for c in calls if c.get('path', '').endswith('/prompt'))
        self.assertNotIn('id', create)
        self.assertNotIn('agent', create)
        self.assertEqual(create['model'], {'providerID': 'opencode', 'id': 'deepseek-v4.1-flash-free', 'variant': 'high'})
        self.assertEqual(create['location']['directory'], calls[0]['cwd'])
        prompt = next(c['body']['text'] for c in calls if c.get('path', '').endswith('/prompt'))
        self.assertEqual(prompt, cli.prompt(messages, True))
        config = calls[0]['config']
        self.assertIn({'action': 'tool.use', 'resource': '*', 'effect': 'deny'}, config['policies'])
        self.assertIn('-opencode.config.mcp', config['plugins'])
        self.assertNotIn('agents', config)
        self.assertEqual(create['permissions'], [{'action': '*', 'resource': '*', 'effect': 'ask'}])
        self.assertNotIn('Привет', ' '.join(calls[0]['argv']))
        self.assertEqual([(c.get('method'),c.get('path')) for c in calls[-2:]],
                         [('POST',f'/api/session/{owned}/interrupt'),('DELETE',f'/api/session/{owned}')])

    async def test_only_final_owned_text_and_permission_requests_are_rejected(self):
        binary = self.binary([
            {'type': 'session.text.ended', 'data': {'sessionID': 'ses_UNRELATED', 'text': 'PRIVATE'}},
            event('session.reasoning.ended', text='PRIVATE REASONING'),
            event('session.text.delta', delta='not final'),
            event('session.text.ended', assistantMessageID='msg_owned', ordinal=0, text='first'),
            event('session.text.ended', assistantMessageID='msg_owned', ordinal=0, text='OK'),
            event('permission.asked', id='per_owned'),
        ])
        self.assertEqual(await cli.complete('opencode', binary, 'local/example#precise',
                                           [{'role': 'user', 'content': 'Test'}], timeout=5), 'OK')
        calls = self.records()
        replies = [c for c in calls if '/permission/' in c.get('path', '')]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]['body']['decision'], 'reject')
        self.assertNotIn('ses_UNRELATED', str(calls))

    async def test_partial_text_followed_by_free_failure_never_succeeds_or_retries(self):
        binary = self.binary([
            event('session.text.ended', assistantMessageID='msg_owned', ordinal=0, text='partial'),
            event('session.execution.failed', error={
                'type': 'provider.quota', 'status': 429, 'message': 'PRIVATE TRANSCRIPT',
                'response': {'body': json.dumps({'error': {'type': 'FreeUsageLimitError', 'message': 'PRIVATE'}})},
            }),
        ])
        result = await cli.test('opencode', binary, 'opencode/deepseek-v4.1-flash-free')
        self.assertFalse(result['ok'])
        self.assertIn('(429)', result['error'])
        self.assertIn('условия доступа', result['error'])
        self.assertNotIn('response', result)
        self.assertNotIn('PRIVATE', str(result))
        calls = self.records()
        self.assertEqual(sum(c.get('path') == '/api/session' for c in calls), 1)
        self.assertEqual(sum(c.get('path', '').endswith('/prompt') for c in calls), 1)
        self.assertEqual(calls[-1]['method'], 'DELETE')
        self.assertFalse(Path(calls[0]['cwd']).exists())

    async def test_events_are_processed_while_prompt_http_response_is_pending(self):
        binary = self.binary([
            event('session.text.ended', assistantMessageID='msg_owned', ordinal=0, text='OK'),
            event('permission.asked', id='per_owned'),
        ], mode='wait-for-permission')
        self.assertEqual(await cli.complete('opencode', binary, 'local/example',
                         [{'role': 'user', 'content': 'Test'}], timeout=5), 'OK')
        replies = [c for c in self.records() if '/permission/' in c.get('path', '')]
        self.assertEqual(replies[0]['body']['decision'], 'reject')

    async def test_prompt_http_failure_does_not_wait_for_an_event_that_never_arrives(self):
        binary = self.binary([], mode='prompt-error')
        started = time.monotonic()
        with self.assertRaisesRegex(cli.CLIError, 'отклонил запрос'):
            await cli.complete('opencode', binary, 'local/example',
                               [{'role': 'user', 'content': 'Test'}], timeout=5)
        self.assertLess(time.monotonic() - started, 2)
        self.assert_stopped(self.records())

    async def wait_prompt(self):
        for _ in range(400):
            if self.capture.exists() and any(c.get('path', '').endswith('/prompt') for c in self.records()):
                return
            await asyncio.sleep(.01)
        self.fail('fake server was not prompted')

    def assert_stopped(self, calls):
        for start in [c for c in calls if c['kind'] == 'start']:
            self.assertFalse(Path(start['cwd']).exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(start['pid'], 0)

    async def test_cancellation_cleans_only_owned_session_and_process(self):
        binary = self.binary([])
        task = asyncio.create_task(cli.complete('opencode', binary, 'local/example',
                                               [{'role': 'user', 'content': 'Test'}], timeout=20))
        await self.wait_prompt()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        calls = self.records()
        owned = next(c['path'].split('/')[3] for c in calls if c.get('path', '').endswith('/prompt'))
        self.assertEqual([(c['method'], c['path']) for c in calls[-2:]],
                         [('POST', f'/api/session/{owned}/interrupt'), ('DELETE', f'/api/session/{owned}')])
        self.assert_stopped(calls)

    async def test_timeout_is_bounded_and_deletes_owned_session(self):
        binary = self.binary([])
        started = time.monotonic()
        with self.assertRaisesRegex(cli.CLIError, 'не ответил'):
            await cli.complete('opencode', binary, 'local/example',
                               [{'role': 'user', 'content': 'Test'}], timeout=.7)
        self.assertLess(time.monotonic() - started, 3)
        calls = self.records()
        self.assertEqual(calls[-1]['method'], 'DELETE')
        self.assert_stopped(calls)

    async def test_response_is_bounded_before_line_decoding(self):
        binary = self.binary([
            event('session.text.ended', assistantMessageID='msg_owned', ordinal=0, text='PRIVATE' * 1000),
            event('session.execution.succeeded'),
        ])
        with patch.object(proxy, 'MAX_OUTPUT', 2048):
            with self.assertRaisesRegex(cli.CLIError, 'размер') as error:
                await cli.complete('opencode', binary, 'local/example',
                                   [{'role': 'user', 'content': 'Test'}], timeout=5)
        self.assertNotIn('PRIVATE', str(error.exception))
        self.assertEqual(self.records()[-1]['method'], 'DELETE')
        self.assert_stopped(self.records())

    async def test_concurrent_requests_do_not_share_server_folder_or_session(self):
        binary = self.binary([
            event('session.text.ended', assistantMessageID='msg_owned', ordinal=0, text='OK'),
            event('session.execution.succeeded'),
        ])
        replies = await asyncio.gather(*[cli.complete('opencode', binary, 'local/example',
                                        [{'role': 'user', 'content': 'Test'}], timeout=5) for _ in range(2)])
        self.assertEqual(replies, ['OK', 'OK'])
        calls = self.records()
        starts = [c for c in calls if c['kind'] == 'start']
        self.assertEqual(len({c['cwd'] for c in starts}), 2)
        self.assertEqual(len({c['path'] for c in calls if c.get('path', '').endswith('/prompt')}), 2)
        self.assertEqual(sum(c.get('method') == 'DELETE' for c in calls), 2)
        self.assert_stopped(calls)

    async def test_empty_or_interrupted_output_is_not_success(self):
        for outcome in ('session.execution.succeeded', 'session.execution.interrupted'):
            binary = self.binary([event(outcome)])
            with self.assertRaises(cli.CLIError):
                await cli.complete('opencode', binary, 'local/example',
                                   [{'role': 'user', 'content': 'Test'}], timeout=5)
        self.assert_stopped(self.records())

    async def test_cleanup_errors_preserve_timeout_and_attempt_both_calls(self):
        binary = self.binary([], mode='cleanup-error')
        with self.assertRaisesRegex(cli.CLIError, 'не ответил'):
            await cli.complete('opencode', binary, 'local/example',
                               [{'role': 'user', 'content': 'Test'}], timeout=.7)
        calls = self.records()
        self.assertTrue(calls[-2]['path'].endswith('/interrupt'))
        self.assertEqual(calls[-1]['method'], 'DELETE')
        self.assert_stopped(calls)
