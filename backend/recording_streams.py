"""One pinned STT model and durable, idempotent transcript chunks per recording."""
from __future__ import annotations

import asyncio
import hashlib
import io
import wave
import json
import math
import os
import tempfile
import uuid

import httpx
from fastapi import HTTPException
from engine import local_stt, whisper_service


class RecordingStreams:
    def __init__(self, get_db, get_setting):
        self.get_db = get_db
        self.get_setting = get_setting
        self.locks = {}
        with get_db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS recording_streams (
                    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL UNIQUE,
                    config TEXT NOT NULL, finalized INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS recording_stream_chunks (
                    session_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
                    audio_hash TEXT NOT NULL, offset_seconds REAL NOT NULL,
                    duration_seconds REAL NOT NULL, response TEXT NOT NULL,
                    PRIMARY KEY (session_id, chunk_index)
                );
            ''')
            db.commit()

    def begin(self, meeting_id):
        with self.get_db() as db:
            meeting = db.execute('SELECT status, source_language FROM meetings WHERE id=?', (meeting_id,)).fetchone()
            if not meeting:
                raise HTTPException(404, 'Встреча не найдена.')
            existing = db.execute('SELECT id, config, finalized FROM recording_streams WHERE meeting_id=?', (meeting_id,)).fetchone()
            if existing:
                if existing['finalized']:
                    raise HTTPException(409, 'Запись уже завершена.')
                config = json.loads(existing['config'])
                return {'session_id': existing['id'], 'model': config['model'], 'mode': config['mode']}
            if meeting['status'] != 'draft':
                raise HTTPException(409, 'Для потоковой записи нужна новая встреча.')
            mode = self.get_setting('whisper_mode', 'local')
            model = self.get_setting('whisper_local_model', 'small') if mode == 'local' else self.get_setting('whisper_model', 'whisper-1')
            language = meeting['source_language'] or 'multi'
            if mode == 'local':
                if not whisper_service.is_env_installed(model) or not whisper_service.is_model_downloaded(model):
                    raise HTTPException(400, 'Выбранная модель STT не готова. Скачайте её и установите среду в настройках.')
                fixed = whisper_service.get_model_info(model).get('language')
                if fixed and fixed != 'multi' and local_stt.normalize_language(language) not in (None, fixed):
                    raise HTTPException(400, 'Язык встречи не соответствует выбранной модели STT.')
            config = {'mode': mode, 'model': model, 'language': language,
                      'device': self.get_setting('whisper_device', 'auto'),
                      'url': self.get_setting('whisper_base_url', 'http://localhost:8000/v1').rstrip('/') if mode != 'local' else ''}
            session_id = str(uuid.uuid4())
            db.execute('INSERT INTO recording_streams (id, meeting_id, config) VALUES (?, ?, ?)',
                       (session_id, meeting_id, json.dumps(config)))
            db.commit()
            return {'session_id': session_id, 'model': model, 'mode': mode}

    async def recognize(self, config, content, duration):
        if config['mode'] == 'local':
            def infer():
                path = None
                try:
                    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as file:
                        file.write(content)
                        path = file.name
                    return whisper_service.transcribe_local(path, model_name=config['model'],
                        device=config['device'], language=config['language'], streaming=True)
                finally:
                    if path:
                        os.unlink(path)
            return await asyncio.to_thread(infer)
        # Credentials stay in settings, not in transcript checkpoints. Fail if
        # the provider changed mid-recording instead of sending a different key.
        if self.get_setting('whisper_base_url', '').rstrip('/') != config['url']:
            raise HTTPException(409, 'Провайдер STT изменён во время записи. Верните исходные настройки для завершения.')
        key = self.get_setting('whisper_api_key', '').strip()
        language = local_stt.normalize_language(config['language'])
        data = {'model': config['model'], 'response_format': 'verbose_json'}
        if language:
            data['language'] = language
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(config['url'] + '/audio/transcriptions',
                headers={'Authorization': 'Bearer ' + key} if key else {},
                files={'file': ('chunk.wav', content, 'audio/wav')}, data=data)
            response.raise_for_status()
        result = response.json()
        segments = result.get('segments') or []
        if not segments and result.get('text', '').strip():
            segments = [{'text': result['text'], 'start': 0, 'end': duration}]
        return {'segments': segments}

    async def accept_chunk(self, session_id, index, offset, content, duration):
        if index < 0 or not math.isfinite(offset) or offset < 0:
            raise HTTPException(400, 'Некорректный номер или время фрагмента.')
        lock = self.locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            with self.get_db() as db:
                session = db.execute('SELECT * FROM recording_streams WHERE id=?', (session_id,)).fetchone()
                if not session:
                    raise HTTPException(404, 'Потоковая запись не найдена.')
                audio_hash = hashlib.sha256(content).hexdigest()
                previous = db.execute('SELECT * FROM recording_stream_chunks WHERE session_id=? AND chunk_index=?', (session_id, index)).fetchone()
                if previous:
                    if previous['audio_hash'] != audio_hash or abs(previous['offset_seconds'] - offset) > 0.001:
                        raise HTTPException(409, 'Номер фрагмента уже занят другим аудио.')
                    return json.loads(previous['response'])
                if session['finalized']:
                    raise HTTPException(409, 'Запись уже завершена.')
                checkpoint = db.execute('SELECT COUNT(*) AS count, COALESCE(SUM(duration_seconds), 0) AS duration FROM recording_stream_chunks WHERE session_id=?', (session_id,)).fetchone()
                if checkpoint['count'] != index or abs(checkpoint['duration'] - offset) > 0.02:
                    raise HTTPException(409, 'Фрагменты должны приходить по порядку без пропусков.')
                config = json.loads(session['config'])
            # Muted/digital-silent chunks still advance the timeline, without
            # expensive automatic language detection on an empty signal.
            with wave.open(io.BytesIO(content), 'rb') as audio:
                silent = not any(audio.readframes(audio.getnframes()))
            result = {'segments': []} if silent else await self.recognize(config, content, duration)
            timed = []
            for segment in result.get('segments', []):
                text = segment.get('text', '').strip()
                start = float(segment.get('timestamp_start', segment.get('start', 0)) or 0)
                end = float(segment.get('timestamp_end', segment.get('end', duration)) or duration)
                start = min(duration, max(0, start))
                end = min(duration, max(start, end))
                if text and end > start:
                    timed.append((offset + start, offset + end, text))
            formatted = local_stt.format_result(timed, duration, config['language'])
            response = {'text': ' '.join(segment['text'] for segment in formatted['segments']),
                        'segments': formatted['segments'], 'model': config['model'],
                        'index': index, 'offset_seconds': offset, 'duration_seconds': duration}
            with self.get_db() as db:
                db.execute('BEGIN IMMEDIATE')
                if not db.execute('SELECT id FROM recording_streams WHERE id=? AND finalized=0', (session_id,)).fetchone():
                    raise HTTPException(409, 'Потоковая запись удалена или завершена.')
                db.execute('INSERT INTO recording_stream_chunks VALUES (?, ?, ?, ?, ?, ?)',
                    (session_id, index, audio_hash, offset, duration, json.dumps(response, ensure_ascii=False)))
                db.commit()
            return response

    def prepare_completion(self, db, meeting_id, session_id, chunk_count, duration):
        session = db.execute('SELECT * FROM recording_streams WHERE id=? AND meeting_id=?', (session_id, meeting_id)).fetchone()
        if not session:
            raise HTTPException(409, 'Транскрипт этой записи не найден.')
        if session['finalized']:
            meeting = db.execute('SELECT error_message FROM meetings WHERE id=?', (meeting_id,)).fetchone()
            if meeting and (meeting['error_message'] or '').startswith('Запись сброшена.'):
                raise HTTPException(409, 'Запись сброшена. Начните новую запись в Mini.')
        chunks = db.execute('SELECT * FROM recording_stream_chunks WHERE session_id=? ORDER BY chunk_index', (session_id,)).fetchall()
        received_duration = sum(chunk['duration_seconds'] for chunk in chunks)
        if len(chunks) != chunk_count or abs(received_duration - duration) > 0.02:
            raise HTTPException(409, 'Дождитесь распознавания последних фрагментов записи и повторите сохранение.')
        timed = []
        for chunk in chunks:
            for segment in json.loads(chunk['response'])['segments']:
                timed.append((segment['timestamp_start'], segment['timestamp_end'], segment['text']))
        result = local_stt.format_result(timed, received_duration, json.loads(session['config'])['language'])
        if not result['text'].strip():
            raise HTTPException(400, 'В записи не удалось распознать речь. Аудио сохранено; проверьте микрофон.')
        db.execute("UPDATE meetings SET transcript_text=?, transcript_segments=?, duration_seconds=?, status='generating', error_message='' WHERE id=?",
            (result['text'], json.dumps(result['segments'], ensure_ascii=False), received_duration, meeting_id))
        db.execute('UPDATE recording_streams SET finalized=1 WHERE id=?', (session_id,))
        return result

    def cancel(self, meeting_id, session_id):
        with self.get_db() as db:
            db.execute('BEGIN IMMEDIATE')
            session = db.execute('SELECT * FROM recording_streams WHERE id=? AND meeting_id=?', (session_id, meeting_id)).fetchone()
            if not session:
                raise HTTPException(404, 'Потоковая запись не найдена.')
            meeting = db.execute('SELECT status, audio_path FROM meetings WHERE id=?', (meeting_id,)).fetchone()
            if meeting['status'] in ('generating', 'completed'):
                raise HTTPException(409, 'Обработка встречи уже запущена.')
            if not meeting['audio_path'] or not os.path.isfile(meeting['audio_path']):
                raise HTTPException(400, 'Сначала сохраните аудио прерванной записи.')
            chunks = db.execute('SELECT response, duration_seconds FROM recording_stream_chunks WHERE session_id=? ORDER BY chunk_index', (session_id,)).fetchall()
            timed = [(s['timestamp_start'], s['timestamp_end'], s['text'])
                     for chunk in chunks for s in json.loads(chunk['response'])['segments']]
            result = local_stt.format_result(timed, sum(c['duration_seconds'] for c in chunks), json.loads(session['config'])['language'])
            db.execute("UPDATE meetings SET transcript_text=?, transcript_segments=?, duration_seconds=?, status='draft', error_message=? WHERE id=?",
                       (result['text'], json.dumps(result['segments'], ensure_ascii=False), result['duration'],
                        'Запись сброшена. Сохранены аудио и распознанная часть текста.', meeting_id))
            db.execute('UPDATE recording_streams SET finalized=1 WHERE id=?', (session_id,))
            db.commit()
        return {'meeting_id': meeting_id, 'status': 'draft'}

    def discard_meeting(self, db, meeting_id):
        db.execute('DELETE FROM recording_stream_chunks WHERE session_id IN (SELECT id FROM recording_streams WHERE meeting_id=?)', (meeting_id,))
        db.execute('DELETE FROM recording_streams WHERE meeting_id=?', (meeting_id,))
