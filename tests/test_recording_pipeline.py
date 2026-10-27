"""Isolated backend regression tests: never touch the user's meeting database."""
import asyncio
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

sandbox = tempfile.TemporaryDirectory(prefix="steppe-recording-test-")
os.environ["STEPPE_DATA_DIR"] = sandbox.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import httpx
import desktop_server as server
from live_captions import create_router
from fastapi import FastAPI


class RecordingPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="http://test")
        created = await self.client.post("/api/v1/meetings/create", json={"title": "Isolated test"})
        self.id = created.json()["id"]
        self.events = []

    async def asyncTearDown(self):
        await self.client.aclose()

    async def save_audio(self):
        await self.client.post(f"/api/v1/meetings/{self.id}/upload-audio", files={"file": ("test.wav", b"audio", "audio/wav")})

    async def fake_transcribe(self, meeting_id, path):
        self.events.append("transcribe")
        await asyncio.sleep(0.01)
        with server.get_db() as db:
            db.execute("UPDATE meetings SET status='transcribed', transcript_text='Тестовая речь' WHERE id=?", (meeting_id,))
            db.commit()
        self.events.append("transcript_saved")

    async def fake_generate(self, meeting_id):
        with server.get_db() as db:
            row = db.execute("SELECT status, transcript_text FROM meetings WHERE id=?", (meeting_id,)).fetchone()
            self.assertEqual(row["status"], "generating")
            self.assertTrue(row["transcript_text"])
            db.execute("UPDATE meetings SET status='completed' WHERE id=?", (meeting_id,))
            db.commit()
        self.events.append("generate")

    async def test_uploaded_files_still_support_explicit_transcription(self):
        await self.save_audio()
        with patch.object(server, "run_transcription", self.fake_transcribe), patch.object(server, "run_generation", self.fake_generate):
            response = await self.client.post(f"/api/v1/meetings/{self.id}/transcribe")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(self.events, ["transcribe", "transcript_saved"])
            result = await self.client.get(f"/api/v1/meetings/{self.id}")
            self.assertEqual(result.json()["transcript_text"], "Тестовая речь")

    async def test_mini_cannot_request_an_implicit_full_audio_pass(self):
        await self.save_audio()
        with patch.object(server, "run_transcription", self.fake_transcribe):
            response = await self.client.post(f"/api/v1/meetings/{self.id}/process-recording")
            self.assertEqual(response.status_code, 409)
            self.assertIn("Обновите", response.json()["detail"])
            self.assertIn("сохранено", response.json()["detail"])
            self.assertEqual(self.events, [])

    async def test_completed_legacy_recording_can_open_without_another_stt_pass(self):
        await self.save_audio()
        with server.get_db() as db:
            db.execute("UPDATE meetings SET status='completed', transcript_text='Восстановленная речь' WHERE id=?", (self.id,))
            db.commit()
        with patch.object(server, "run_transcription", self.fake_transcribe), patch.object(server, "run_generation", self.fake_generate):
            response = await self.client.post(f"/api/v1/meetings/{self.id}/process-recording")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "completed")
        self.assertEqual(self.events, [])


class CaptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_wav_is_recognized_and_temp_audio_removed(self):
        app = FastAPI()
        app.include_router(create_router(lambda key, default: default))
        wav = io.BytesIO()
        with wave.open(wav, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\0\0" * 32000)
        paths = []
        def recognize(path, **kwargs):
            self.assertTrue(Path(path).exists())
            paths.append(path)
            return {"segments": [{"text": "Субтитры во время записи"}]}
        with patch("live_captions.whisper_service.transcribe_local", recognize):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post("/api/v1/captions/transcribe", files={"file": ("live.wav", wav.getvalue(), "audio/wav")})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["text"], "Субтитры во время записи")
        self.assertTrue(paths)
        self.assertFalse(Path(paths[0]).exists())

    async def test_invalid_or_oversized_caption_is_rejected(self):
        app = FastAPI()
        app.include_router(create_router(lambda key, default: default))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            invalid = await client.post("/api/v1/captions/transcribe", files={"file": ("bad.wav", b"bad")})
            self.assertEqual(invalid.status_code, 400)
            oversized = await client.post("/api/v1/captions/transcribe", files={"file": ("big.wav", b"x" * (3 * 1024 * 1024 + 1))})
            self.assertEqual(oversized.status_code, 413)


if __name__ == "__main__":
    unittest.main()
