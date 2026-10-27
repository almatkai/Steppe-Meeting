"""Sequential recording chunks become the final transcript, with no second STT pass."""
import asyncio
import io
import os
import tempfile
import wave

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from engine import whisper_service

MAX_BYTES = 3 * 1024 * 1024


class CancelRecordingRequest(BaseModel):
    session_id: str


def validate_wav(content: bytes) -> float:
    try:
        with wave.open(io.BytesIO(content), 'rb') as audio:
            duration = audio.getnframes() / audio.getframerate()
            if (audio.getnchannels() != 1 or audio.getsampwidth() != 2
                    or not 8000 <= audio.getframerate() <= 96000 or not 0 < duration <= 15
                    or len(audio.readframes(audio.getnframes())) != audio.getnframes() * 2):
                raise ValueError('Expected up to 15 seconds of mono PCM16 WAV')
            return duration
    except (wave.Error, EOFError, ValueError, ZeroDivisionError) as error:
        raise HTTPException(400, 'Ожидается короткий фрагмент WAV PCM16 (до 15 секунд).') from error


def create_router(get_setting, streams=None):
    router = APIRouter()
    inference_lock = asyncio.Lock()

    if streams is not None:
        @router.post('/api/v1/meetings/{meeting_id}/recording-session')
        async def begin_recording(meeting_id: str):
            return streams.begin(meeting_id)

        @router.post('/api/v1/meetings/{meeting_id}/cancel-recording')
        async def cancel_recording(meeting_id: str, request: CancelRecordingRequest):
            return streams.cancel(meeting_id, request.session_id)

    @router.post('/api/v1/captions/transcribe')
    async def transcribe_caption(file: UploadFile = File(...), language: str = Form('multi'),
            session_id: str | None = Form(None), index: int = Form(0), offset_seconds: float = Form(0)):
        content = await file.read(MAX_BYTES + 1)
        if len(content) > MAX_BYTES:
            raise HTTPException(413, 'Фрагмент субтитров слишком большой.')
        duration = validate_wav(content)

        async def recognize():
            if session_id:
                if streams is None:
                    raise HTTPException(404, 'Потоковая запись недоступна.')
                return await streams.accept_chunk(session_id, index, offset_seconds, content, duration)
            # Compatibility with independent caption clients: use the selected
            # model exactly, never silently substitute Tiny.
            async with inference_lock:
                model = get_setting('whisper_local_model', 'small')
                if get_setting('whisper_mode', 'local') != 'local':
                    raise HTTPException(400, 'Для внешнего STT начните потоковую сессию записи.')
                def infer():
                    path = None
                    try:
                        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp:
                            temp.write(content); path = temp.name
                        return whisper_service.transcribe_local(path, model_name=model,
                            device=get_setting('whisper_device', 'auto'), language=language)
                    finally:
                        if path:
                            os.unlink(path)
                result = await asyncio.to_thread(infer)
                return {'text': ' '.join(s['text'] for s in result.get('segments', [])), 'model': model,
                        'segments': result.get('segments', [])}

        task = asyncio.create_task(recognize())
        try:
            # A disconnected response must not discard an accepted transcript.
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(503, 'Не удалось распознать фрагмент. Проверьте выбранную модель STT и повторите сохранение.') from error
    return router
