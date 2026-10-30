"""Retry an owned meeting job with a frozen route; no real inference or user data."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_storage = tempfile.TemporaryDirectory(prefix='steppe-route-import-')
with patch.dict(os.environ, STEPPE_DATA_DIR=_storage.name):
    import desktop_server as server
import httpx
from engine import llm
from generation_jobs import GenerationJobs


class GenerationRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.storage = tempfile.TemporaryDirectory(prefix='steppe-route-test-')
        self.path = Path(self.storage.name)
        self.calls = []
        self.saved_settings = server.settings.model_dump()
        self.patches = [patch.object(server, 'DB_PATH', self.path / 'test.db'),
                        patch.object(server, 'generation_jobs', GenerationJobs(server.write_generation_status)),
                        patch.object(server.indexer, 'index_meeting', AsyncMock(return_value=1)),
                        patch.object(llm, '_save_call_log', AsyncMock()),
                        patch.object(server.cli_llm, 'complete', AsyncMock(side_effect=self.cli)),
                        patch.object(llm, '_call', AsyncMock(side_effect=self.http))]
        for p in self.patches: p.start()
        server.init_db()
        server.RecordingStreams(server.get_db, server.get_setting)
        self.save(llm_mode='cli', llm_cli_provider='opencode', llm_model='saved-api',
                  llm_base_url='https://saved.test/v1', llm_api_key='synthetic-private-key',
                  llm_cli=json.dumps({'opencode': {'path': '/saved/opencode', 'model': 'provider/original#fast'},
                                      'codex': {'path': '/saved/codex', 'model': 'saved-codex'},
                                      'claude': {'path': '/saved/claude', 'model': ''},
                                      'antigravity': {'path': '/saved/agy', 'model': 'saved-gemini'}}))
        server.sync_generation_settings()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url='http://test')
        self.id = (await self.client.post('/api/v1/meetings/create', json={
            'title': 'Synthetic', 'transcript_text': 'Saved full synthetic transcript'})).json()['id']
        async def stage(**kwargs):
            return await llm.complete_json([{'role': 'user', 'content': 'synthetic stage'}])
        for module, name in [(server.protocol, 'generate'), (server.protocol, '_translate'),
                             (server.summary, 'generate'), (server.summary, 'translate')]:
            p = patch.object(module, name, stage); p.start(); self.patches.append(p)

    async def asyncTearDown(self):
        await server.generation_jobs.shutdown()
        await self.client.aclose()
        for p in reversed(self.patches): p.stop()
        for key, value in self.saved_settings.items(): setattr(server.settings, key, value)
        self.storage.cleanup()

    def save(self, **settings):
        with server.get_db() as db:
            for key, value in settings.items():
                db.execute('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)', (key, value))
            db.commit()

    def config_rows(self):
        with server.get_db() as db:
            return [tuple(r) for r in db.execute('SELECT key,value FROM settings ORDER BY key')]

    async def cli(self, provider, path, model, messages, **kwargs):
        self.calls.append(('cli', provider, path, model))
        return '{}'

    async def http(self, url, model, headers, messages, *args, **kwargs):
        self.calls.append(('api', url, model, headers))
        return '{}'

    async def post(self, body=None, id=None):
        kw = {'json': body} if body is not None else {}
        return await self.client.post(f'/api/v1/meetings/{id or self.id}/generate', **kw)

    async def settle(self, id=None):
        job = server.generation_jobs.jobs.get(id or self.id)
        if job:
            await asyncio.wait_for(asyncio.shield(job.task), 3)
            await asyncio.sleep(0)

    async def meeting(self):
        return (await self.client.get(f'/api/v1/meetings/{self.id}')).json()

    async def test_failed_opencode_can_retry_codex_without_changing_settings_or_inputs(self):
        with patch.object(server.cli_llm, 'complete', AsyncMock(side_effect=server.cli_llm.CLIError('429 synthetic refusal'))):
            self.assertEqual((await self.post()).status_code, 200)
            await self.settle()
        before = await self.meeting()
        self.assertEqual(before['status'], 'error')
        settings = self.config_rows()
        global_settings = server.settings.model_dump()
        response = await self.post({'mode': 'cli', 'provider': 'codex', 'model': 'selected-codex'})
        self.assertEqual(response.status_code, 200, response.text)
        await self.settle()
        self.assertEqual(self.calls, [('cli', 'codex', '/saved/codex', 'selected-codex')] * 4)
        after = await self.meeting()
        self.assertEqual(after['status'], 'completed')
        self.assertEqual(after['transcript_text'], before['transcript_text'])
        self.assertEqual(after['audio_path'], before['audio_path'])
        self.assertEqual(self.config_rows(), settings)
        self.assertEqual(server.settings.model_dump(), global_settings)
        self.assertEqual(after['generation_attempt']['provider'], 'codex')
        self.assertEqual(after['generation_attempt']['model'], 'selected-codex')
        self.assertNotIn('synthetic-private-key', json.dumps(after['generation_attempt']))

    async def test_exact_variant_and_no_body_defaults(self):
        self.assertEqual((await self.post()).status_code, 200)
        await self.settle()
        self.assertEqual(self.calls, [('cli', 'opencode', '/saved/opencode', 'provider/original#fast')] * 4)
        self.calls.clear()
        await self.post({'mode': 'cli', 'provider': 'opencode', 'model': 'local/new#precise'})
        await self.settle()
        self.assertEqual(self.calls, [('cli', 'opencode', '/saved/opencode', 'local/new#precise')] * 4)

    async def test_invalid_or_secret_overrides_fail_before_job_or_status_change(self):
        before = await self.meeting()
        for body in [{'mode': 'cli', 'provider': 'other', 'model': 'x'},
                     {'mode': 'cli', 'provider': 'opencode', 'model': ''},
                     {'mode': 'cli', 'provider': 'opencode', 'model': 'invalid'},
                     {'mode': 'api', 'model': ''}, {'mode': 'api', 'model': 'ok', 'path': '/bin/evil'},
                     {'mode': 'api', 'model': 'ok', 'api_key': 'must-not-accept'},
                     {'mode': 'api', 'model': 'ok', 'base_url': 'https://evil.test'},
                     {'mode': 'cli', 'provider': 'codex', 'model': 'line\nbreak'}]:
            response = await self.post(body)
            self.assertEqual(response.status_code, 422, (body, response.text))
            self.assertIsNone(server.generation_jobs.active(self.id))
            self.assertEqual((await self.meeting())['status'], before['status'])
        self.assertFalse(self.calls)

    async def test_route_stays_frozen_after_global_edits_and_does_not_leak_to_chat(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def pause(provider, path, model, messages, **kwargs):
            self.calls.append(('cli', provider, path, model))
            if len(self.calls) == 1:
                entered.set(); await release.wait()
            return '{}'
        with patch.object(server.cli_llm, 'complete', AsyncMock(side_effect=pause)):
            await self.post({'mode': 'cli', 'provider': 'codex', 'model': 'frozen'})
            await entered.wait()
            self.save(llm_cli_provider='antigravity', llm_cli=json.dumps({'antigravity': {'path': '/new/agy', 'model': 'new-global'}}))
            server.sync_generation_settings()
            await llm.complete_messages([{'role': 'user', 'content': 'independent chat'}])
            release.set(); await self.settle()
        self.assertEqual(self.calls[1], ('cli', 'antigravity', '/new/agy', 'new-global'))
        self.assertEqual([x for i, x in enumerate(self.calls) if i != 1], [('cli', 'codex', '/saved/codex', 'frozen')] * 4)

    async def test_http_selection_never_uses_legacy_openai_fallback(self):
        prior = await self.meeting()
        server.settings.OPENAI_API_KEY = 'synthetic-legacy-key'
        with patch.object(llm, '_call', AsyncMock(side_effect=llm.LLMError('synthetic HTTP refusal'))) as request:
            response = await self.post({'mode': 'api', 'model': 'exact-api-model'})
            self.assertEqual(response.status_code, 200)
            await self.settle()
        self.assertEqual(request.await_count, 1)
        self.assertEqual(request.await_args.args[:3], ('https://saved.test/v1/chat/completions', 'exact-api-model', {'Authorization': 'Bearer synthetic-private-key'}))
        after = await self.meeting()
        self.assertEqual(after['status'], 'error')
        for key in ('transcript_text', 'transcript_segments', 'protocol_ru', 'protocol_kz', 'summary_ru', 'summary_kz'):
            self.assertEqual(after[key], prior[key])

    async def test_options_and_discovery_use_saved_paths_without_returning_secrets(self):
        response = await self.client.get(f'/api/v1/meetings/{self.id}/generation-options')
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body['default'], {'mode': 'cli', 'provider': 'opencode', 'model': 'provider/original#fast'})
        self.assertEqual({x['provider'] for x in body['providers']}, {'api', 'opencode', 'codex', 'claude', 'antigravity'})
        self.assertNotIn('synthetic-private-key', response.text)
        self.assertNotIn('/saved/', response.text)
        with patch.object(server.cli_llm, 'models', AsyncMock(return_value={'models': []})) as discover:
            response = await self.client.get(f'/api/v1/meetings/{self.id}/generation-models?mode=cli&provider=opencode')
            self.assertEqual(response.status_code, 200)
            discover.assert_awaited_once_with('opencode', '/saved/opencode')

    async def test_concurrent_meetings_keep_different_routes_and_chat_keeps_defaults(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def pause(provider, path, model, messages, **kwargs):
            self.calls.append(('cli', provider, path, model))
            if provider == 'codex' and not entered.is_set():
                entered.set(); await release.wait()
            return '{}'
        other = (await self.client.post('/api/v1/meetings/create', json={
            'title': 'Other', 'transcript_text': 'Other synthetic transcript'})).json()['id']
        with patch.object(server.cli_llm, 'complete', AsyncMock(side_effect=pause)):
            await self.post({'mode': 'cli', 'provider': 'codex', 'model': 'meeting-a'})
            await entered.wait()
            await self.post({'mode': 'cli', 'provider': 'claude', 'model': ''}, other)
            await self.settle(other)
            await llm.complete_messages([{'role': 'user', 'content': 'independent chat'}])
            release.set(); await self.settle()
        self.assertEqual(self.calls.count(('cli', 'codex', '/saved/codex', 'meeting-a')), 4)
        self.assertEqual(self.calls.count(('cli', 'claude', '/saved/claude', '')), 4)
        self.assertEqual(self.calls.count(('cli', 'opencode', '/saved/opencode', 'provider/original#fast')), 1)

    async def test_template_stages_use_same_route_after_global_configuration_changes(self):
        template = self.path / 'template.docx'; template.write_bytes(b'fake template')
        with server.get_db() as db:
            db.execute("INSERT INTO protocol_templates(id,name,docx_path,source_docx_path,slots,schema_json,style_config,created_at) VALUES ('t','t',?,?,'[]','{}','{}','now')", (str(template), str(template)))
            db.execute("UPDATE meetings SET template_id='t' WHERE id=?", (self.id,)); db.commit()
        async def template_values(*args, **kwargs):
            self.save(llm_mode='api', llm_model='changed-api')
            server.sync_generation_settings()
            return {'template_values': await llm.complete_json([{'role': 'user', 'content': 'template'}])}
        async def translate_values(*args, **kwargs):
            return await llm.complete_json([{'role': 'user', 'content': 'template translation'}])
        with patch.object(server.docx_template, 'parse_docx_template', return_value=type('Template', (), {'slots': []})()), \
             patch.object(server.docx_template, '_loop_iterables', return_value={}), \
             patch.object(server.template_protocol, 'build_protocol_source', return_value={}), \
             patch.object(server.template_generation, 'generate_protocol_template_values', template_values), \
             patch.object(server.template_generation, 'translate_template_values', translate_values):
            await self.post({'mode': 'cli', 'provider': 'antigravity', 'model': 'selected-gemini'})
            await self.settle()
        self.assertEqual((await self.meeting())['status'], 'completed')
        self.assertEqual(self.calls, [('cli', 'antigravity', '/saved/agy', 'selected-gemini')] * 6)

    async def test_cancel_override_preserves_prior_results_audio_transcript_and_config(self):
        audio = self.path / 'audio.webm'; audio.write_bytes(b'preserved synthetic audio')
        with server.get_db() as db:
            db.execute("UPDATE meetings SET protocol_ru=?,summary_ru=?,audio_path=?,audio_filename='audio.webm' WHERE id=?",
                       (json.dumps({'prior': 'protocol'}), json.dumps({'prior': 'summary'}), str(audio), self.id)); db.commit()
        before = await self.meeting(); config = self.config_rows()
        entered = asyncio.Event()
        async def wait(*args, **kwargs):
            entered.set(); await asyncio.Future()
        with patch.object(server.cli_llm, 'complete', AsyncMock(side_effect=wait)):
            await self.post({'mode': 'cli', 'provider': 'codex', 'model': ''})
            await entered.wait()
            response = await self.client.post(f'/api/v1/meetings/{self.id}/stop-generation')
            self.assertEqual(response.json()['status'], 'cancelled')
        after = await self.meeting()
        for field in ('protocol_ru', 'summary_ru', 'transcript_text', 'transcript_segments', 'audio_path'):
            self.assertEqual(after[field], before[field])
        self.assertEqual(audio.read_bytes(), b'preserved synthetic audio')
        self.assertEqual(self.config_rows(), config)

    async def test_bad_saved_config_auto_handoff_is_retryable_without_losing_transcription(self):
        self.save(llm_cli='{}')
        self.assertEqual(server.start_saved_meeting_generation(self.id), 'error')
        failed = await self.meeting()
        self.assertIn('Не удалось начать генерацию', failed['error_message'])
        self.assertEqual(failed['transcript_text'], 'Saved full synthetic transcript')
        self.assertIsNone(server.generation_jobs.active(self.id))
        response = await self.post({'mode': 'cli', 'provider': 'codex', 'model': ''})
        self.assertEqual(response.status_code, 200)
        await self.settle()
        self.assertEqual((await self.meeting())['status'], 'completed')

    async def test_mini_invalid_saved_route_keeps_finalized_text_for_explicit_retry(self):
        self.save(llm_cli='{}')
        audio = self.path / 'audio.wav'; audio.write_bytes(b'synthetic audio')
        with server.get_db() as db:
            db.execute("UPDATE meetings SET audio_path=? WHERE id=?", (str(audio), self.id))
            db.execute("INSERT INTO recording_streams(id,meeting_id,config,finalized) VALUES ('s',?,'{}',0)", (self.id,)); db.commit()
        def prepare(db, meeting, *args):
            db.execute("UPDATE meetings SET transcript_text='Full finalized transcript',status='generating' WHERE id=?", (meeting,))
            db.execute("UPDATE recording_streams SET finalized=1 WHERE id='s'")
        manifest = {'session_id': 's', 'chunk_count': 1, 'duration_seconds': 1}
        with patch.object(server.recording_streams, 'prepare_completion', prepare):
            response = await self.client.post(f'/api/v1/meetings/{self.id}/process-recording', json=manifest)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['status'], 'error')
            duplicate = await self.client.post(f'/api/v1/meetings/{self.id}/process-recording', json=manifest)
            self.assertEqual(duplicate.json()['status'], 'error')
        self.assertEqual((await self.meeting())['transcript_text'], 'Full finalized transcript')
        await self.post({'mode': 'cli', 'provider': 'codex', 'model': ''}); await self.settle()
        self.assertEqual((await self.meeting())['status'], 'completed')

    async def test_auto_transcription_reports_generation_config_error_truthfully(self):
        self.save(llm_cli='{}', whisper_mode='local')
        audio = self.path / 'audio.wav'; audio.write_bytes(b'synthetic audio')
        with server.get_db() as db:
            db.execute("UPDATE meetings SET audio_path=?,transcript_text='',status='draft' WHERE id=?", (str(audio), self.id)); db.commit()
        with patch.object(server.whisper_service, 'transcribe_local', return_value={
                'text': 'Full new transcript', 'segments': [{'text': 'Full new transcript'}], 'duration': 3}):
            response = await self.client.post(f'/api/v1/meetings/{self.id}/transcribe', params={'auto_generate': 'true'})
        self.assertEqual(response.status_code, 200)
        row = await self.meeting()
        self.assertEqual(row['status'], 'error')
        self.assertEqual(row['transcript_text'], 'Full new transcript')
        self.assertTrue(row['error_message'].startswith('Не удалось начать генерацию:'))
        self.assertTrue(audio.exists())


if __name__ == '__main__':
    unittest.main()
