"""CLI adapter regressions: real catalog fixtures + executable process boundaries."""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import cli_llm as cli, llm, opencode_proxy

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
        self.storage = tempfile.TemporaryDirectory(prefix='steppe-cli-tests-')
        self.folder = Path(self.storage.name)

    async def asyncTearDown(self):
        self.storage.cleanup()

    def executable(self, source):
        path = self.folder / 'fake cli'
        path.write_text(f'#!{Path(sys.executable).resolve()}\n' + source)
        path.chmod(0o700)
        return str(path)

    async def test_argv_stdin_roles_variants_and_isolation_all_providers(self):
        output = self.folder / 'capture.json'
        messages = [{'role': role, 'content': f'{role}: text $(touch INJECTION) ' + 'я' * 10000}
                    for role in ('system', 'user', 'assistant', 'user')]
        for provider in cli.PROVIDERS:
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

    async def test_opencode_free_rejection_keeps_exact_model_safety_and_cleanup(self):
        capture_path = self.folder / 'calls.jsonl'
        binary = self.executable(
            'import sys,json\nfrom pathlib import Path\n'
            'record={"argv":sys.argv,"cwd":str(Path.cwd())}\n'
            'if sys.argv[1]=="run": record["config"]=json.loads(Path("opencode.json").read_text())\n'
            f'with Path({str(capture_path)!r}).open("a") as f: f.write(json.dumps(record)+"\\n")\n'
            'if sys.argv[1]=="api": print("{}"); sys.exit(0)\n'
            f'print({REPLIES["opencode"]!r})\n'
            f'print({json.dumps(OPENCODE_FREE_REJECTION)!r})\n'
            'sys.exit(1)\n')
        model = 'opencode/deepseek-v4.1-flash-free'
        result = await cli.test('opencode', binary, model)
        self.assertFalse(result['ok'], 'partial text followed by rejection is not success')
        self.assertNotIn('response', result)
        self.assertIn('условия доступа', result['error'])
        self.assertNotIn('исчерпан', result['error'])
        calls = [json.loads(line) for line in capture_path.read_text().splitlines()]
        self.assertEqual(len(calls), 3, 'one inference, interrupt and delete; no fallback/retry')
        argv, config = calls[0]['argv'], calls[0]['config']
        self.assertEqual(argv[argv.index('--model') + 1], model)
        self.assertIn({'action': 'tool.use', 'resource': '*', 'effect': 'deny'}, config['policies'])
        self.assertEqual(argv[argv.index('--agent') + 1], 'build')
        self.assertNotIn('agents', config, 'use the native agent and its system prompt')
        self.assertEqual(config['permissions'], [{'action': '*', 'resource': '*', 'effect': 'ask'}])
        self.assertNotIn('-opencode.tool.*', config['plugins'], 'load native definitions; policy denies execution')
        self.assertNotIn('--auto', argv)
        session = argv[argv.index('--session') + 1]
        self.assertEqual(calls[1]['argv'][1:], ['api', 'POST', f'/api/session/{session}/interrupt'])
        self.assertEqual(calls[2]['argv'][1:], ['api', 'DELETE', f'/api/session/{session}'])
        self.assertFalse(Path(calls[0]['cwd']).exists())

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

    async def test_opencode_cancel_interrupts_only_its_unique_service_session(self):
        calls = []
        started = asyncio.Event()
        async def fake_run(argv, **options):
            calls.append(argv)
            if argv[1] == 'run':
                started.set()
                await asyncio.Event().wait()
            return 0, '{}', ''
        with patch.object(cli, 'resolve', return_value='/fake/opencode'), patch.object(cli, 'run', fake_run):
            task = asyncio.create_task(cli.complete('opencode', '', 'local/example#precise', [{'role': 'user', 'content': 'Test'}]))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual(len(calls), 3)
        session = calls[0][calls[0].index('--session') + 1]
        self.assertRegex(session, r'^ses_[a-z0-9]{26}$')
        self.assertEqual(calls[1], ['/fake/opencode', 'api', 'POST', f'/api/session/{session}/interrupt'])
        self.assertEqual(calls[2], ['/fake/opencode', 'api', 'DELETE', f'/api/session/{session}'])

    async def test_proxy_concurrent_requests_have_separate_sessions_and_private_configs(self):
        calls = []
        both_started = asyncio.Event()
        async def fake_run(argv, **options):
            calls.append((argv, options))
            if argv[1] != 'run':
                return 0, '{}', ''
            folder = Path(options['cwd'])
            config = json.loads(folder.joinpath('opencode.json').read_text())
            self.assertEqual(json.loads(options['env']['OPENCODE_CONFIG_CONTENT']), config)
            self.assertNotEqual(options['env'].get('OPENCODE_CONFIG'), '/private/user-config')
            self.assertNotIn('OPENCODE_SESSION_ID', options['env'])
            self.assertIn({'action': 'tool.use', 'resource': '*', 'effect': 'deny'}, config['policies'])
            self.assertNotIn('PRIVATE MEETING', folder.joinpath('opencode.json').read_text())
            self.assertEqual(argv[argv.index('--agent') + 1], 'build')
            if sum(a[1] == 'run' for a, _ in calls) == 2:
                both_started.set()
            await both_started.wait()
            return 0, REPLIES['opencode'], ''
        with patch.dict(os.environ, OPENCODE_CONFIG='/private/user-config',
                        OPENCODE_SESSION_ID='unrelated-user-session'), \
             patch.object(cli, 'resolve', return_value='/fake/opencode'), patch.object(cli, 'run', fake_run):
            results = await asyncio.gather(*[cli.complete('opencode', '', 'local/example#precise',
                [{'role': 'user', 'content': f'PRIVATE MEETING {i}: run touch /tmp/DO_NOT_CREATE'}]) for i in range(2)])
        self.assertEqual(results, ['{"answer":"OK"}'] * 2)
        turns = [(a, o) for a, o in calls if a[1] == 'run']
        sessions = {a[a.index('--session') + 1] for a, _ in turns}
        self.assertEqual(len(sessions), 2)
        self.assertEqual(len({o['cwd'] for _, o in turns}), 2)
        for argv, options in turns:
            sid = argv[argv.index('--session') + 1]
            self.assertEqual([a[2:] for a, o in calls if a[1] == 'api' and o['cwd'] == options['cwd']],
                             [['POST', f'/api/session/{sid}/interrupt'], ['DELETE', f'/api/session/{sid}']])
            self.assertFalse(Path(options['cwd']).exists())

    async def test_proxy_timeout_keeps_original_failure_and_still_attempts_both_cleanup_calls(self):
        calls = []
        async def fake_run(argv, **options):
            calls.append((argv, options))
            if argv[1] == 'run':
                self.assertEqual(options['timeout'], 7)
                raise cli.CLIError('CLI не ответил за 7 с')
            self.assertEqual(options['timeout'], 5)
            raise OSError('cleanup failed')
        with self.assertRaisesRegex(cli.CLIError, '7 с'):
            await opencode_proxy.request('/fake/opencode', 'local/example#precise', 'Meeting', run=fake_run, timeout=7)
        self.assertEqual(len(calls), 3)
        self.assertFalse(Path(calls[0][1]['cwd']).exists())

    async def test_unknown_auth_is_not_authenticated(self):
        with patch.object(cli, 'resolve', return_value='/fake/agy'), patch.object(cli, 'run', AsyncMock(return_value=(0, 'v1', ''))):
            result = await cli.check('antigravity')
        self.assertEqual(result['auth'], 'unknown')
        self.assertIn('неизвестен', result['error'])


if __name__ == '__main__':
    unittest.main()
