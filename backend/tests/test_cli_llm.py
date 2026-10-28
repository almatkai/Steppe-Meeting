"""CLI adapter regressions: real catalog fixtures + executable process boundaries."""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import cli_llm as cli, llm

FIXTURES = Path(__file__).parent / 'fixtures/cli'
REPLIES = {
    'codex': '\n'.join(map(json.dumps, [
        {'type': 'item.completed', 'item': {'type': 'reasoning', 'text': 'private reasoning'}},
        {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': '{"answer":"OK"}'}},
        {'type': 'turn.completed', 'usage': {'input_tokens': 10, 'output_tokens': 4}},
    ])),
    'claude': json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': '{"answer":"OK"}'}),
    'antigravity': '\n'.join(map(json.dumps, [
        {'event': 'step_update', 'step_update': {'step_type': 'tool', 'text_delta': 'not an answer'}},
        {'event': 'result', 'result': {'status': 'SUCCESS', 'response': '{"answer":"OK"}'}},
    ])),
    'opencode': '\n'.join(map(json.dumps, [
        {'type': 'reasoning', 'part': {'text': 'not an answer'}},
        {'type': 'text', 'part': {'type': 'text', 'text': '{"answer":"OK"}'}},
    ])),
}

# Minimal OpenCode 2.2.0 envelope observed for our isolated, tiny free-model
# request. OpenCode replaces the provider's message but retains response.body.
OPENCODE_FREE_REJECTION = {
    'type': 'error',
    'error': {
        'type': 'provider.free-limit', 'status': 429,
        'message': 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.',
        'response': {'body': json.dumps({'type': 'error', 'error': {
            'type': 'FreeUsageLimitError',
            'message': 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go',
        }})},
    },
}


class ParserTests(unittest.TestCase):
    def test_assistant_only_all_providers_and_object_guarantee(self):
        for provider, fixture in REPLIES.items():
            self.assertEqual(llm._parse(cli.parse_reply(provider, fixture)), {'answer': 'OK'})
        for provider in cli.PROVIDERS:
            with self.assertRaises(cli.CLIError):
                cli.parse_reply(provider, '{}')
        for value in ('[]', '"text"', 'null'):
            with self.assertRaises(llm.LLMError):
                llm._parse(value)

    def test_terminal_failures_are_not_successful_partial_output(self):
        for provider, failure in [
            ('codex', {'type': 'turn.failed', 'error': {'message': 'secret'}}),
            ('opencode', {'type': 'error', 'error': {'message': 'secret'}}),
            ('antigravity', {'event': 'result', 'result': {'status': 'ERROR', 'response': 'partial'}}),
            ('claude', {'is_error': True, 'result': 'partial'}),
        ]:
            with self.assertRaises(cli.CLIError) as error:
                cli.parse_reply(provider, json.dumps(failure))
            self.assertNotIn('secret', str(error.exception))

    def test_actual_opencode_catalog_and_explicit_prices(self):
        models = cli.parse_models('opencode', FIXTURES.joinpath('opencode-models.txt').read_text())
        self.assertEqual(len(models), 43)
        self.assertTrue(all(item['free'] is None for item in models))
        enriched = cli.enrich_models(models, json.loads(FIXTURES.joinpath('opencode-costs.json').read_text()))
        self.assertEqual(sum(item['free'] is True for item in enriched), 9)
        self.assertTrue(any(item['free'] is False for item in enriched))
        self.assertTrue(all(set(item) <= {'id', 'name', 'provider', 'free'} for item in enriched))

    def test_free_is_never_guessed_and_local_catalogs_are_supported(self):
        models = cli.parse_models('opencode', 'ollama/local:latest\nopencode/name-free\nlocal/custom#fast\nprogress not a model\n')
        self.assertEqual([m['id'] for m in models], ['ollama/local:latest', 'opencode/name-free', 'local/custom#fast'])
        for cost, expected in [([], None), ([{'input': 0}], None), ([{'input': 0, 'output': 0}], True),
                               ([{'input': 0, 'output': 0}, {'input': 1, 'output': 0}], False)]:
            metadata = {'data': [{'id': 'name-free', 'providerID': 'opencode', 'cost': cost}]}
            self.assertEqual(cli.enrich_models(models, metadata)[1]['free'], expected)
        self.assertEqual(cli.parse_models('antigravity', 'Fetching available models...\ngemini-example\tGemini Example\n')[0]['name'], 'Gemini Example')

    def test_diagnostics_redact_token_shapes_and_bound_output(self):
        text = 'Bearer topsecret API_KEY="abcd" sk-' + 'x' * 48 + ' eyJ' + 'x' * 50
        result = cli.diagnostic(text + 'x' * 6000)
        for secret in ('topsecret', 'abcd', 'sk-xxx', 'eyJxxx'):
            self.assertNotIn(secret, result)
        self.assertLessEqual(len(result), 2048)

    def test_opencode_free_refusal_is_not_proof_of_exhausted_account_quota(self):
        # Known free-limit category, including older CLI envelopes without a
        # body, must not invent account-wide exhaustion or an HTTP status.
        for response in (OPENCODE_FREE_REJECTION['error']['response'], None,
                         {'body': 'malformed PRIVATE TRANSCRIPT sk-secret'}):
            for status in (429, None, 'PRIVATE TRANSCRIPT'):
                error = {'type': 'provider.free-limit', 'status': status,
                         'message': 'PRIVATE TRANSCRIPT', 'response': response}
                with self.subTest(response=response, status=status), self.assertRaises(cli.CLIError) as caught:
                    cli.parse_reply('opencode', json.dumps({'type': 'error', 'error': error}))
                message = str(caught.exception)
                self.assertIn('условия доступа', message)
                self.assertIn('другая модель не выбрана', message.lower())
                self.assertNotIn('исчерпан', message.lower())
                self.assertNotIn('PRIVATE', message)
                self.assertNotIn('sk-secret', message)
                self.assertEqual('(429)' in message, status == 429)

    def test_opencode_free_error_body_survives_changed_cli_error_categories(self):
        # Newer OpenCode maps QuotaExceeded to provider.quota. Only inspect
        # the provider's structured error type, never echo its arbitrary text.
        for category, body_type, status in [('provider.quota', 'FreeUsageLimitError', 429),
                                            ('provider.auth', 'FreeTierError', 403)]:
            error = {'type': category, 'status': status, 'message': 'PRIVATE TRANSCRIPT',
                     'response': {'body': json.dumps({'error': {'type': body_type, 'message': 'PRIVATE TRANSCRIPT'}})}}
            with self.subTest(category=category), self.assertRaises(cli.CLIError) as caught:
                cli.parse_reply('opencode', json.dumps({'type': 'error', 'error': error}))
            self.assertIn('бесплатн', str(caught.exception))
            self.assertIn(f'({status})', str(caught.exception))
            self.assertNotIn('PRIVATE', str(caught.exception))
        # Unknown/unstructured bodies cannot turn arbitrary provider errors
        # into a claimed free-tier restriction.
        with self.assertRaises(cli.CLIError) as caught:
            cli.parse_reply('opencode', json.dumps({'type': 'error', 'error': {
                'type': 'provider.quota', 'response': {'body': 'FreeUsageLimitError PRIVATE TRANSCRIPT'},
            }}))
        self.assertNotIn('бесплатн', str(caught.exception))


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        cli._ACCESS.clear()
        cli._CACHE.clear()
        self.storage = tempfile.TemporaryDirectory(prefix='steppe-cli-tests-')
        self.folder = Path(self.storage.name)

    async def asyncTearDown(self):
        self.storage.cleanup()

    def executable(self, source):
        path = self.folder / 'fake cli'
        path.write_text(f'#!{Path(sys.executable).resolve()}\n' + source)
        path.chmod(0o700)
        return str(path)

    async def test_argv_stdin_roles_variants_and_isolation_subprocess_providers(self):
        output = self.folder / 'capture.json'
        messages = [{'role': role, 'content': f'{role}: text $(touch INJECTION) ' + 'я' * 10000}
                    for role in ('system', 'user', 'assistant', 'user')]
        for provider in ('codex', 'claude', 'antigravity'):
            binary = self.executable(
                'import sys,os,json\nfrom pathlib import Path\n'
                'if len(sys.argv)>1 and sys.argv[1]=="api": print("{}"); sys.exit(0)\n'
                f'Path({str(output)!r}).write_text(json.dumps({{"argv":sys.argv,"stdin":sys.stdin.read(),"cwd":os.getcwd(),"pwd":os.environ["PWD"],"nested":os.environ.get("CLAUDECODE")}}))\n'
                f'print({REPLIES[provider]!r})\n')
            model = 'local/custom;no-shell#precise' if provider == 'opencode' else 'default#variant'
            with patch.dict(os.environ, CLAUDECODE='nested-session'):
                reply = await cli.complete(provider, binary, model, messages, json_mode=True)
            self.assertEqual(llm._parse(reply), {'answer': 'OK'})
            capture = json.loads(output.read_text())
            self.assertIn(model, capture['argv'])
            self.assertNotIn(messages[0]['content'], ' '.join(capture['argv']))
            self.assertEqual(capture['cwd'], capture['pwd'])
            self.assertNotEqual(capture['cwd'], os.getcwd())
            self.assertIsNone(capture['nested'])
            self.assertFalse(Path(capture['cwd']).exists(), 'temporary cwd is removed')
            text = capture['stdin']
            if provider == 'antigravity':
                envelope = json.loads(text)
                self.assertEqual(set(envelope), {'event', 'message'})
                self.assertEqual(envelope['event'], 'user')
                self.assertNotIn('--print', capture['argv'])
                text = envelope['message']['content']
            self.assertEqual(json.loads(text.split('Conversation messages (ordered JSON):\n')[1]), messages)
            self.assertIn('Return ONLY a JSON object', text)
            self.assertFalse(self.folder.joinpath('INJECTION').exists())
            self.assertFalse(any('bypass' in flag or 'skip-permissions' in flag for flag in capture['argv']))

    async def child_cleanup(self, cancel):
        marker = self.folder / 'child.pid'
        binary = self.executable(
            'import subprocess,sys,time\nfrom pathlib import Path\n'
            'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"])\n'
            f'Path({str(marker)!r}).write_text(str(p.pid))\n'
            'time.sleep(60)\n')
        task = asyncio.create_task(cli.run([binary], cwd=self.storage.name, timeout=2 if not cancel else 60))
        for _ in range(300):
            if marker.exists(): break
            await asyncio.sleep(.01)
        self.assertTrue(marker.exists())
        if cancel:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
        else:
            with self.assertRaisesRegex(cli.CLIError, 'CLI не ответил'): await task
        child = int(marker.read_text())
        for _ in range(100):
            try: os.kill(child, 0)
            except ProcessLookupError: break
            await asyncio.sleep(.01)
        else:
            os.kill(child, signal.SIGKILL)
            self.fail('CLI descendant survived cleanup')

    async def test_timeout_kills_descendants(self):
        await self.child_cleanup(False)

    async def test_cancellation_kills_descendants(self):
        await self.child_cleanup(True)

    async def test_exited_owned_process_cleanup_does_not_mask_original_error(self):
        for denied_signal in (signal.SIGTERM, signal.SIGKILL):
            process = SimpleNamespace(pid=123456, wait=AsyncMock(return_value=0))
            def signal_group(pid, sig):
                if sig == denied_signal:
                    raise PermissionError("exited group")
            with patch.object(cli.os, "killpg", side_effect=signal_group):
                await cli._terminate(process)
            process.wait.assert_awaited()

    async def test_permission_denial_for_running_owned_process_is_not_hidden(self):
        async def still_running():
            await asyncio.sleep(60)
        process = SimpleNamespace(pid=123456, wait=still_running)
        with patch.object(cli.os, "killpg", side_effect=PermissionError("active group")) as send:
            with self.assertRaises(PermissionError):
                await cli._terminate(process)
        send.assert_called_once_with(process.pid, signal.SIGTERM)

    async def test_output_is_bounded_and_inference_stderr_is_not_reflected(self):
        binary = self.executable('print("x"*10000)\n')
        with patch.object(cli, 'MAX_OUTPUT', 100):
            with self.assertRaisesRegex(cli.CLIError, 'размер'):
                await cli.run([binary], cwd=self.storage.name)
        binary = self.executable('import sys\nprint("PRIVATE TRANSCRIPT sk-secret",file=sys.stderr)\nsys.exit(1)\n')
        with self.assertRaises(cli.CLIError) as error:
            await cli.complete('codex', binary, '', [{'role': 'user', 'content': 'PRIVATE TRANSCRIPT'}])
        self.assertNotIn('PRIVATE', str(error.exception))
        self.assertNotIn('sk-secret', str(error.exception))

    async def test_test_is_exactly_one_request_no_default_paid_opencode_model(self):
        with patch.object(cli, 'complete', new_callable=AsyncMock, return_value='OK') as complete:
            self.assertTrue((await cli.test('codex'))['ok'])
            complete.assert_awaited_once()
        binary = self.executable('raise RuntimeError("must not execute")\n')
        result = await cli.test('opencode', binary, '')
        self.assertFalse(result['ok'])
        self.assertIn('Укажите модель', result['error'])

    async def test_check_has_no_inference_and_status_cache(self):
        invocations = []
        async def fake_run(argv, **_):
            invocations.append(argv)
            if '--version' in argv: return 0, 'v1', ''
            return 0, 'Logged in using ChatGPT', ''
        cli._CACHE.clear()
        with patch.object(cli, 'resolve', return_value='/fake/codex'), patch.object(cli, 'run', fake_run):
            first = await cli.check('codex', cached=True)
            second, third = await asyncio.gather(cli.check('codex', cached=True), cli.check('codex', cached=True))
            self.assertEqual(first, second)
            self.assertEqual(second, third)
            self.assertEqual(len(invocations), 2)
            overridden = await cli.check('codex', '/another/path', cached=True)
            self.assertEqual(len(invocations), 4)
        self.assertEqual(first['auth'], 'authenticated')
        self.assertEqual(first['configured_path'], '')
        self.assertEqual(overridden['configured_path'], '/another/path')
        self.assertEqual(overridden['path'], '/fake/codex')
        self.assertNotIn('exec', str(invocations))

    async def test_model_access_is_runtime_evidence_not_login_identity(self):
        cli._ACCESS.clear()
        for provider in cli.PROVIDERS:
            model = 'provider/exact#fast' if provider == 'opencode' else ''
            with patch.object(cli, 'resolve', return_value='/fake/cli'), \
                 patch.object(cli, 'run', AsyncMock(return_value=(0, REPLIES[provider], ''))), \
                 patch.object(cli.opencode_proxy, 'request', AsyncMock(return_value=(0, REPLIES[provider], ''))):
                result = await cli.test(provider, '/configured/cli', model)
                self.assertTrue(result['ok'])
                self.assertEqual(result['access']['model'], model)
                self.assertEqual(result['access']['path'], '/fake/cli')
                self.assertNotIn('response', result['access'])
                check = {'available': True, 'auth': 'unknown', 'path': '/fake/cli',
                         'model_access': result['access']}
                self.assertTrue(cli.model_ready(check, model))
                for changed in ({'auth': 'required'}, {'available': False}, {'path': '/other/cli'},
                                {'error': 'probe failed'}):
                    self.assertFalse(cli.model_ready({**check, **changed}, model))
                self.assertFalse(cli.model_ready(check, model + '-other'))
                with patch.object(cli, 'run', AsyncMock(return_value=(1, '', 'private'))), \
                     patch.object(cli.opencode_proxy, 'request', side_effect=cli.opencode_proxy.ProxyError('failed')):
                    failed = await cli.test(provider, '/configured/cli', model)
                self.assertFalse(failed['ok'])
                self.assertFalse(failed['access']['ok'])
                self.assertFalse(cli.model_ready({**check, 'model_access': failed['access']}, model))

    async def test_all_provider_checks_only_probe_metadata(self):
        for provider in cli.PROVIDERS:
            calls = []
            async def metadata(argv, **options):
                calls.append(argv[1:])
                if '--version' in argv:
                    return 0, 'v1', ''
                return 0, {'codex': 'Logged in', 'claude': '{"loggedIn":true}',
                           'opencode': '[]'}[provider], ''
            with patch.object(cli, 'resolve', return_value='/fake/cli'), \
                 patch.object(cli, 'run', metadata), \
                 patch.object(cli, 'complete', side_effect=AssertionError('no inference')), \
                 patch.object(cli.opencode_proxy, 'request', side_effect=AssertionError('no inference')):
                check = await cli.check(provider, '/configured/cli')
            self.assertTrue(check['available'])
            self.assertNotIn('error', check)
            self.assertEqual(calls[0], ['--version'])
            expected_auth = {'codex': ['login', 'status'], 'claude': ['auth', 'status', '--json'],
                             'opencode': ['auth', 'list', '--format', 'json']}.get(provider)
            self.assertEqual(calls[1:], [expected_auth] if expected_auth else [])

    async def test_missing_executable_after_success_replaces_runtime_access(self):
        with patch.object(cli, 'resolve', return_value='/fake/codex'), \
             patch.object(cli, 'run', AsyncMock(return_value=(0, REPLIES['codex'], ''))):
            self.assertTrue((await cli.test('codex'))['ok'])
        with patch.object(cli, 'resolve', side_effect=cli.CLIError('codex не найден')):
            failed = await cli.test('codex')
            check = await cli.check('codex')
        self.assertFalse(failed['ok'])
        self.assertFalse(check['model_access']['ok'])
        self.assertFalse(cli.model_ready(check))
        self.assertIn('не найден', failed['access']['error'])

    async def test_negative_login_and_failed_probe_cannot_reuse_previous_model_success(self):
        cli._ACCESS.clear()
        cli._ACCESS[('codex', '')] = {'ok': True, 'model': '', 'path': '/fake/codex'}
        for code, text, auth in [(0, 'Not logged in', 'required'), (1, 'Not logged in', 'required'),
                                 (1, 'probe unavailable', 'unknown')]:
            calls = [(0, 'v1', ''), (code, text, '')]
            with patch.object(cli, 'resolve', return_value='/fake/codex'), \
                 patch.object(cli, 'run', AsyncMock(side_effect=calls)):
                check = await cli.check('codex')
            self.assertEqual(check['auth'], auth)
            self.assertIn('error', check)
            self.assertFalse(cli.model_ready(check))

    async def test_unknown_auth_is_not_authenticated(self):
        with patch.object(cli, 'resolve', return_value='/fake/agy'), patch.object(cli, 'run', AsyncMock(return_value=(0, 'v1', ''))):
            result = await cli.check('antigravity')
        self.assertEqual(result['auth'], 'unknown')
        self.assertNotIn('error', result)
        self.assertNotEqual(result['auth'], 'authenticated')


if __name__ == '__main__':
    unittest.main()
