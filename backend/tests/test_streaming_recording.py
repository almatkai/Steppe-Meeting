"""Mini recording must recognize each chunk once with one frozen model."""
import io
import os
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch, AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_storage = tempfile.TemporaryDirectory(prefix='steppe-stream-test-')
with patch.dict(os.environ, STEPPE_DATA_DIR=_storage.name):
    import desktop_server as server
from fastapi.testclient import TestClient


def audio(seconds=2):
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(b'\xcd\x0c' * int(seconds * 16000))
    return output.getvalue()


class StreamingRecordingTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.id = self.client.post('/api/v1/meetings/create', json={'title': 'Stream regression', 'source_language': 'multi'}).json()['id']
        self.settings = {'whisper_mode': 'local', 'whisper_local_model': 'small', 'whisper_device': 'auto'}
        self.config = patch.object(server, 'get_setting', side_effect=lambda key, default=None: self.settings.get(key, default))
        self.config.start()
        self.ready = patch.object(server.whisper_service, 'is_env_installed', return_value=True)
        self.ready.start()
        self.downloaded = patch.object(server.whisper_service, 'is_model_downloaded', return_value=True)
        self.downloaded.start()

    def tearDown(self):
        self.config.stop(); self.ready.stop(); self.downloaded.stop()

    def begin(self):
        response = self.client.post(f'/api/v1/meetings/{self.id}/recording-session')
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['session_id']

    def chunk(self, session, index=0, offset=0, content=None):
        return self.client.post('/api/v1/captions/transcribe',
            data={'session_id': session, 'index': index, 'offset_seconds': offset},
            files={'file': ('chunk.wav', content or audio(), 'audio/wav')})

    def result(self, text='тестовая речь'):
        return {'text': text, 'duration': 2, 'language': 'ru', 'segments': [{'text': text, 'timestamp_start': 0.1, 'timestamp_end': 1.9, 'speaker': 'Спикер 1'}]}

    def test_stream_never_switches_to_tiny_and_freezes_model_at_start(self):
        session = self.begin()
        self.settings['whisper_local_model'] = 'medium'
        with patch.object(server.whisper_service, 'transcribe_local', return_value=self.result()) as recognize:
            response = self.chunk(session)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(recognize.call_args.kwargs['model_name'], 'small')
        self.assertEqual(response.json()['model'], 'small')

    def test_retry_returns_checkpoint_without_recognizing_again(self):
        session = self.begin()
        with patch.object(server.whisper_service, 'transcribe_local', return_value=self.result()) as recognize:
            first = self.chunk(session); retry = self.chunk(session)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual(recognize.call_count, 1)

    def test_full_audio_cache_uses_frozen_stream_config_and_survives_deletion(self):
        from recording_cache import load_input
        session = self.begin()
        self.settings['whisper_local_model'] = 'medium'
        response = self.client.post(f'/api/v1/meetings/{self.id}/upload-audio',
            files={'file': ('full.wav', audio(61), 'audio/wav')})
        self.assertEqual(response.status_code, 200, response.text)
        sha = response.json()['regression_case']
        root = server.DATA_DIR / 'stt-regression'
        self.assertEqual(load_input(sha, root).read_bytes(), audio(61))
        import json
        manifests = list((root / 'cases' / sha / 'sources').glob('*.json'))
        manifest = next(json.loads(p.read_text()) for p in manifests if json.loads(p.read_text())['source_id'] == self.id)
        self.assertEqual(manifest['config']['model'], 'small')
        self.assertTrue(manifest['config']['streaming'])
        self.client.delete(f'/api/v1/meetings/{self.id}')
        self.assertTrue(load_input(sha, root).is_file())

    def test_cache_failure_does_not_acknowledge_upload(self):
        with patch.object(server, 'retain_recording', side_effect=OSError('disk full')):
            response = self.client.post(f'/api/v1/meetings/{self.id}/upload-audio',
                files={'file': ('full.wav', audio(), 'audio/wav')})
        self.assertEqual(response.status_code, 503)
        with server.get_db() as db:
            self.assertFalse(db.execute('SELECT audio_path FROM meetings WHERE id=?',(self.id,)).fetchone()['audio_path'])

    def test_stop_formats_checkpoint_and_generates_without_full_file_stt(self):
        session = self.begin()
        with patch.object(server.whisper_service, 'transcribe_local', side_effect=[self.result('первая часть'), self.result('вторая часть')]) as recognize:
            self.assertEqual(self.chunk(session).status_code, 200)
            self.assertEqual(self.chunk(session, 1, 2).status_code, 200)
        self.client.post(f'/api/v1/meetings/{self.id}/upload-audio', files={'file': ('full.wav', audio(4), 'audio/wav')})
        seen = []
        async def generate(meeting):
            row = self.client.get(f'/api/v1/meetings/{meeting}').json()
            self.assertEqual(row['status'], 'generating')
            self.assertIn('первая часть', row['transcript_text'])
            self.assertIn('вторая часть', row['transcript_text'])
            self.assertEqual(row['transcript_segments'][1]['timestamp_start'], 2.1)
            seen.append(meeting)
        with patch.object(server, 'run_transcription', new=AsyncMock()) as full_stt, patch.object(server, 'run_generation', side_effect=generate):
            response = self.client.post(f'/api/v1/meetings/{self.id}/process-recording', json={'session_id': session, 'chunk_count': 2, 'duration_seconds': 4})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['status'], 'generating')
        full_stt.assert_not_called()
        self.assertEqual(recognize.call_count, 2)
        self.assertEqual(seen, [self.id])

    def test_duplicate_completion_does_not_generate_twice(self):
        session = self.begin()
        with patch.object(server.whisper_service, 'transcribe_local', return_value=self.result()):
            self.chunk(session)
        self.client.post(f'/api/v1/meetings/{self.id}/upload-audio', files={'file': ('full.wav', audio(), 'audio/wav')})
        manifest = {'session_id': session, 'chunk_count': 1, 'duration_seconds': 2}
        with patch.object(server, 'run_generation', new=AsyncMock()) as generate:
            first = self.client.post(f'/api/v1/meetings/{self.id}/process-recording', json=manifest)
            retry = self.client.post(f'/api/v1/meetings/{self.id}/process-recording', json=manifest)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(generate.call_count, 1)

    def test_digital_silence_advances_checkpoint_without_model_inference(self):
        session = self.begin()
        silence = bytearray(audio())
        silence[44:] = bytes(len(silence) - 44)
        with patch.object(server.whisper_service, 'transcribe_local') as recognize:
            result = self.chunk(session, content=bytes(silence))
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['segments'], [])
        self.assertEqual(result.json()['duration_seconds'], 2)
        recognize.assert_not_called()

    def test_silent_recording_keeps_audio_without_starting_generation(self):
        session = self.begin()
        with patch.object(server.whisper_service, 'transcribe_local', return_value={'segments': []}):
            self.chunk(session)
        self.client.post(f'/api/v1/meetings/{self.id}/upload-audio', files={'file': ('full.wav', audio(), 'audio/wav')})
        with patch.object(server, 'run_generation', new=AsyncMock()) as generate:
            response = self.client.post(f'/api/v1/meetings/{self.id}/process-recording', json={'session_id': session, 'chunk_count': 1, 'duration_seconds': 2})
        self.assertEqual(response.status_code, 400)
        self.assertIn('речь', response.json()['detail'])
        generate.assert_not_called()
        with server.get_db() as db:
            path = db.execute('SELECT audio_path FROM meetings WHERE id=?', (self.id,)).fetchone()['audio_path']
        self.assertTrue(Path(path).is_file())

    def test_reset_keeps_audio_and_checkpoint_without_recognition_or_generation(self):
        session = self.begin()
        with patch.object(server.whisper_service, 'transcribe_local', return_value=self.result()):
            self.chunk(session)
        self.client.post(f'/api/v1/meetings/{self.id}/upload-audio', files={'file': ('full.wav', audio(), 'audio/wav')})
        with patch.object(server.whisper_service, 'transcribe_local') as recognize, patch.object(server, 'run_generation', new=AsyncMock()) as generate:
            response = self.client.post(f'/api/v1/meetings/{self.id}/cancel-recording', json={'session_id': session})
            retry = self.client.post(f'/api/v1/meetings/{self.id}/cancel-recording', json={'session_id': session})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(retry.status_code, 200, retry.text)
        recognize.assert_not_called(); generate.assert_not_called()
        row = self.client.get(f'/api/v1/meetings/{self.id}').json()
        self.assertEqual(row['status'], 'draft')
        self.assertIn('тестовая речь', row['transcript_text'])
        self.assertTrue(Path(row['audio_path']).is_file())
        late = self.chunk(session, 1, 2)
        self.assertEqual(late.status_code, 409)
        completion = self.client.post(f'/api/v1/meetings/{self.id}/process-recording', json={'session_id': session, 'chunk_count': 1, 'duration_seconds': 2})
        self.assertEqual(completion.status_code, 409)

    def test_missing_chunk_cannot_silently_start_full_transcription(self):
        session = self.begin()
        self.client.post(f'/api/v1/meetings/{self.id}/upload-audio', files={'file': ('full.wav', audio(4), 'audio/wav')})
        with patch.object(server, 'run_transcription', new=AsyncMock()) as full_stt:
            response = self.client.post(f'/api/v1/meetings/{self.id}/process-recording', json={'session_id': session, 'chunk_count': 2, 'duration_seconds': 4})
        self.assertEqual(response.status_code, 409, response.text)
        full_stt.assert_not_called()


if __name__ == '__main__':
    unittest.main()
