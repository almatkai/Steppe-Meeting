"""Isolated SQLite/API routing checks. No live CLI or HTTP model requests."""
import asyncio
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_storage = tempfile.TemporaryDirectory(prefix='steppe-cli-api-')
with patch.dict(os.environ, STEPPE_DATA_DIR=_storage.name):
    import desktop_server as server
from fastapi.testclient import TestClient
from engine import cli_llm, llm


class CLIAPITests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        with server.get_db() as db:
            db.execute('DELETE FROM settings')
            db.execute('DELETE FROM chat_messages')
            db.execute('DELETE FROM chat_sessions')
            db.commit()
        server.sync_generation_settings()
        self.no_http = patch.object(server.httpx.AsyncClient, 'post', side_effect=AssertionError('HTTP inference forbidden'))
        self.no_http.start()
        self.addCleanup(self.no_http.stop)

    def save(self, **values):
        return self.client.post('/api/v1/system/config', json=values)

    def activate(self, provider='opencode'):
        response = self.save(llm_mode='cli', llm_cli_provider=provider,
                             llm_cli={provider: {'path': '/test/cli', 'model': 'local/example#precise'}})
        self.assertEqual(response.status_code, 200, response.text)

    def test_legacy_defaults_and_switch_round_trip_preserve_every_provider(self):
        legacy = self.client.get('/api/v1/system/config').json()
        self.assertEqual(legacy['llm_mode'], 'api')
        self.assertEqual(legacy['llm_cli_provider'], 'opencode')
        self.assertEqual(legacy['llm_cli'], {})
        self.save(llm_base_url='https://example.test/v1', llm_model='http-model', llm_api_key='test-value')
        self.activate()
        self.save(llm_cli_provider='codex', llm_cli={'codex': {'path': '/bin/codex', 'model': 'model-y'}})
        self.save(llm_mode='api')
        self.save(llm_mode='cli', llm_cli_provider='opencode')
        actual = self.client.get('/api/v1/system/config').json()
        self.assertEqual((actual['llm_base_url'], actual['llm_model'], actual['llm_api_key']), ('https://example.test/v1', 'http-model', 'test-value'))
        self.assertEqual(actual['llm_cli']['opencode']['model'], 'local/example#precise')
        self.assertEqual(actual['llm_cli']['codex']['model'], 'model-y')
        with server.get_db() as db:
            persisted = json.loads(db.execute("SELECT value FROM settings WHERE key='llm_cli'").fetchone()[0])
        self.assertEqual(persisted, actual['llm_cli'])
        server.settings.LLM_CLI = {}
        server.sync_generation_settings()
        self.assertEqual(server.settings.LLM_CLI, persisted)

    def test_whole_update_validation_is_atomic_and_only_active_values_block(self):
        self.activate()
        previous = self.client.get('/api/v1/system/config').json()
        for invalid in ({'llm_model': 'must-not-save', 'llm_cli': {'opencode': {'path': 'relative'}}},
                        {'llm_api_key': 'must-not-save', 'whisper_local_model': 'unknown'}):
            response = self.save(**invalid)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(self.client.get('/api/v1/system/config').json(), previous)
        # HTTP legacy values are irrelevant in CLI mode.
        self.assertEqual(self.save(llm_base_url='legacy invalid', llm_model='').status_code, 200)
        # Only the active provider's override/model are validated.
        self.assertEqual(self.save(llm_cli={'codex': {'path': 'inactive relative'}}).status_code, 200)
        # Switching back requires usable API fields, but inactive CLI remains intact.
        self.assertEqual(self.save(llm_mode='api', llm_base_url='http://localhost:11434/v1', llm_model='restored').status_code, 200)
        self.assertEqual(self.save(llm_cli={'opencode': {'path': 'legacy relative', 'model': 'legacy'}}).status_code, 200)

    def test_check_models_test_use_unsaved_values_without_persisting(self):
        before = self.client.get('/api/v1/system/config').json()
        requests = [
            ('check', {'provider': 'codex', 'path': '/unsaved/codex'}, 'check', {'available': True}),
            ('models', {'provider': 'opencode', 'path': '/unsaved/opencode'}, 'models', {'models': []}),
            ('test', {'provider': 'opencode', 'path': '/unsaved/opencode', 'model': 'local/example#fast'}, 'test', {'ok': True, 'response': 'OK', 'elapsed_ms': 1}),
        ]
        for action, body, function, result in requests:
            with patch.object(cli_llm, function, AsyncMock(return_value=result)) as call:
                response = self.client.post(f'/api/v1/system/cli/{action}', json=body)
                self.assertEqual(response.json(), result)
                call.assert_awaited_once_with(*body.values())
            self.assertEqual(self.client.get('/api/v1/system/config').json(), before)

    def test_free_tier_refusal_reaches_test_api_without_fallback_or_settings_changes(self):
        before = self.client.get('/api/v1/system/config').json()
        model = 'opencode/deepseek-v4.1-flash-free'
        refusal = json.dumps({'type': 'error', 'error': {
            'type': 'provider.free-limit', 'status': 429,
            'message': 'PRIVATE TRANSCRIPT',
            'response': {'body': json.dumps({'error': {'type': 'FreeUsageLimitError', 'message': 'PRIVATE TRANSCRIPT'}})},
        }})
        async def fake_run(argv, **options):
            if argv[1] == 'run':
                self.assertEqual(argv[argv.index('--model') + 1], model)
                self.assertIn('Reply with OK only.', options['stdin'])
                return 1, refusal, 'PRIVATE TRANSCRIPT'
            return 0, '{}', ''
        with patch.object(cli_llm, 'resolve', return_value='/fake/opencode'), \
             patch.object(cli_llm, 'run', AsyncMock(side_effect=fake_run)) as run:
            response = self.client.post('/api/v1/system/cli/test', json={'provider': 'opencode', 'model': model})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body['ok'])
        self.assertIn('условия доступа', body['error'])
        self.assertNotIn('исчерпан', body['error'])
        self.assertNotIn('PRIVATE', response.text)
        self.assertEqual(run.await_count, 3, 'one inference plus interrupt/delete')
        self.assertEqual(self.client.get('/api/v1/system/config').json(), before)

    def test_cli_status_never_contacts_http_llm_and_retains_legacy_shape(self):
        self.activate('codex')
        check = {'provider': 'codex', 'available': True, 'auth': 'authenticated', 'supports_models': False, 'checked_at': '2026-10-27T00:00:00Z'}
        local = {'ready': False, 'local': {'error': 'missing weights'}}
        with patch.object(cli_llm, 'check', AsyncMock(return_value=check)) as probe, \
             patch.object(server.httpx.AsyncClient, 'get', side_effect=AssertionError('HTTP LLM discovery forbidden')), \
             patch.object(server.whisper_service, 'get_whisper_full_status', return_value=local):
            response = self.client.get('/api/v1/system/status')
        body = response.json()
        self.assertEqual(body['cli'], check)
        self.assertEqual(body['llm_mode'], 'cli')
        self.assertTrue(body['ollama']['connected'])
        self.assertIn('available_models', body['ollama'])
        probe.assert_awaited_once_with('codex', '/test/cli', cached=True)

    def test_chat_and_edit_preserve_roles_and_sse_all_providers(self):
        for provider in cli_llm.PROVIDERS:
            self.activate(provider)
            with patch.object(cli_llm, 'complete', AsyncMock(return_value='Assistant answer')) as call:
                chat = self.client.post('/api/v1/chat', json={'messages': [
                    {'role': 'user', 'content': 'First'}, {'role': 'assistant', 'content': 'History'}, {'role': 'user', 'content': 'Next'}]})
                self.assertIn('"choices"', chat.text)
                self.assertIn('Assistant answer', chat.text)
                self.assertIn('[DONE]', chat.text)
                messages = call.await_args.args[3]
                self.assertEqual([m['role'] for m in messages], ['system', 'user', 'assistant', 'user'])
                self.assertEqual(call.await_args.args[0], provider)
                self.assertEqual(call.await_args.args[2], 'local/example#precise')
                edited = self.client.post('/api/v1/edit', json={'selected_text': 'Old', 'instruction': 'Edit'})
                self.assertEqual(edited.json(), {'edited_text': 'Assistant answer'})
                self.assertEqual([m['role'] for m in call.await_args.args[3]], ['system', 'user'])

    def test_cli_failure_surfaces_without_http_fallback_or_failed_retry_persistence(self):
        self.activate()
        session = self.client.post('/api/v1/chat/sessions', json={}).json()['id']
        citations = [{'meeting_title': 'Test', 'source_label': 'Transcript', 'snippet': 'Evidence'}]
        with patch.object(server.retriever, 'retrieve', AsyncMock(return_value=([], citations))), \
             patch.object(cli_llm, 'complete', AsyncMock(side_effect=cli_llm.CLIError('CLI unavailable'))):
            for _ in range(2):
                response = self.client.post(f'/api/v1/chat/sessions/{session}/messages', json={'content': 'Question'})
                self.assertIn('event: citations', response.text)
                self.assertIn('event: error', response.text)
                self.assertNotIn('event: done', response.text)
            self.assertEqual(self.client.get(f'/api/v1/chat/sessions/{session}/messages').json(), [])
            chat = self.client.post('/api/v1/chat', json={'messages': [{'role': 'user', 'content': 'Question'}]})
            self.assertIn('CLI unavailable', chat.text)
            self.assertNotIn('[DONE]', chat.text)
            edited = self.client.post('/api/v1/edit', json={'selected_text': 'Old', 'instruction': 'Edit'})
            self.assertEqual(edited.status_code, 502)
        with patch.object(server.retriever, 'retrieve', AsyncMock(return_value=([], citations))), \
             patch.object(cli_llm, 'complete', AsyncMock(return_value='Answer')):
            response = self.client.post(f'/api/v1/chat/sessions/{session}/messages', json={'content': 'Question'})
            self.assertIn('event: done', response.text)
        rows = self.client.get(f'/api/v1/chat/sessions/{session}/messages').json()
        self.assertEqual([row['role'] for row in rows], ['user', 'assistant'])
        self.assertEqual(rows[-1]['citations'], citations)

    def test_engine_json_text_stream_never_fall_back_when_cli_fails(self):
        self.activate()
        async def exercise():
            with patch.object(cli_llm, 'complete', AsyncMock(side_effect=cli_llm.CLIError('failed'))) as call:
                with self.assertRaises(llm.LLMError): await llm.complete_json([{'role': 'user', 'content': 'JSON'}])
                with self.assertRaises(llm.LLMError): await llm.complete_text('Text')
                with self.assertRaises(llm.LLMError):
                    async for _ in llm.stream_chat([{'role': 'user', 'content': 'Chat'}]): pass
                self.assertEqual(call.await_count, 3)
        asyncio.run(exercise())

    def test_direct_api_chat_keeps_selected_http_provider_without_fallback(self):
        async def fail_selected(*args, **kwargs):
            raise llm.LLMError('Selected API unavailable')
            yield ''
        with patch.object(llm, '_stream_local', fail_selected), \
             patch.object(llm, '_stream_openai', side_effect=AssertionError('No direct-chat fallback')):
            response = self.client.post('/api/v1/chat', json={'messages': [{'role': 'user', 'content': 'Test'}]})
        self.assertIn('Selected API unavailable', response.text)
        self.assertNotIn('[DONE]', response.text)

    def test_meeting_generation_and_template_paths_use_cli(self):
        self.activate()
        meeting = self.client.post('/api/v1/meetings/create', json={'title': 'Test', 'transcript_text': 'Решили продолжить работу.'}).json()['id']
        # {} satisfies the existing empty protocol/summary schema. The actual
        # pipelines still call llm.complete_json, including their translations.
        with patch.object(cli_llm, 'complete', AsyncMock(return_value='{}')) as call, \
             patch.object(server.indexer, 'index_meeting', AsyncMock()):
            response = self.client.post(f'/api/v1/meetings/{meeting}/generate')
            self.assertEqual(response.status_code, 200)
            generated = self.client.get(f'/api/v1/meetings/{meeting}').json()
            self.assertEqual(generated['status'], 'completed', generated.get('error_message'))
            self.assertGreater(call.await_count, 3)
        # Real DOCX upload enters profile inference through the same adapter.
        from docx import Document
        document = Document(); document.add_paragraph('{{ meeting_title }}')
        content = io.BytesIO(); document.save(content)
        with patch.object(cli_llm, 'complete', AsyncMock(return_value='{}')) as call:
            response = self.client.post('/api/v1/templates/upload', data={'name': 'CLI template'}, files={'file': ('template.docx', content.getvalue())})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertGreaterEqual(call.await_count, 1)
        template = response.json()['id']
        # A provider failure produces 502 and never persists test artifacts.
        with patch.object(cli_llm, 'complete', AsyncMock(side_effect=cli_llm.CLIError('CLI offline'))):
            response = self.client.post(f'/api/v1/templates/{template}/test', json={'transcript': 'Test'})
        self.assertEqual(response.status_code, 502, response.text)
        self.assertFalse(self.client.get(f'/api/v1/templates/{template}').json()['has_test_docx'])


if __name__ == '__main__':
    unittest.main()
