"""Generate an independent Russian speech reference using installed offline Milena.

Run with backend/.venv/bin/python. Audio and synthesis provenance stay private.
No ASR runs here. Thresholds and phrases are fixed before recognition.
"""
import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from recording_cache import atomic_json, cache_dir, fingerprint, private_dir, retain_recording, load_input

# Original public test prose: never derived from user audio or an ASR transcript.
PARTS = [
    'Красный маяк освещает берег. Сегодня мы обсуждаем план небольшой городской библиотеки. '
    'Утром сотрудники открывают двери и проверяют читальный зал. На первом этаже стоят столы для посетителей. '
    'Рядом находится полка с книгами о природе и путешествиях. Каждый читатель может выбрать удобное место. '
    'Мы хотим сохранить спокойную обстановку и сделать поиск книг понятным. Для этого понадобится простой каталог и ясное расписание работы.',
    'Зелёный поезд пересекает долину. В середине встречи мы переходим к практическим вопросам. '
    'Нужно проверить освещение над столами и подготовить несколько новых указателей. После обеда волонтёры помогут расставить книги по разделам. '
    'Один человек отвечает за историю, другой занимается научной литературой. Детские рассказы будут храниться в отдельной комнате. '
    'Мы заранее записываем каждое решение, чтобы через неделю можно было спокойно проверить результат общей работы.',
    'В завершение разговора мы распределяем оставшиеся задачи. '
    'Марина подготовит список необходимых материалов, а Николай проверит состояние окон. В пятницу команда соберётся снова и обсудит первые изменения. '
    'Если посетители предложат полезные идеи, мы добавим их в следующий план. Наша цель состоит в том, чтобы библиотека оставалась удобным местом для чтения. '
    'На этом сегодняшняя встреча заканчивается. Спасибо всем участникам за внимание и помощь. Синий корабль возвращается домой.'
]
PHRASES = ['красный маяк освещает берег', 'зелёный поезд пересекает долину', 'синий корабль возвращается домой']


def main():
    root = private_dir(cache_dir() / 'independent-milena-v2')
    # This immutable specification is published before synthesis, let alone ASR.
    specification = {'schema': 1, 'source': 'Original prewritten Russian prose, independent of ASR and private recordings',
                     'parts': PARTS, 'script': ' '.join(PARTS), 'phrases': PHRASES,
                     'synthesis': {'executable': '/usr/bin/say', 'voice': 'Milena', 'rate_wpm': 135, 'gap_seconds': .3},
                     'thresholds': {'max_wer': .20, 'min_token_recall': .85, 'all_anchors': True,
                                    'min_decoded_duration': 60},
                     'limitation': 'Synthetic speech coverage only; no claim of complete human recording accuracy'}
    specpath = root / 'specification.json'
    if specpath.exists() and json.loads(specpath.read_text()) != specification:
        raise ValueError('Reference changed: use a new fixture version')
    atomic_json(specpath, specification)
    provenance = root / 'provenance.json'
    if provenance.exists():
        cached = json.loads(provenance.read_text())
        if cached['specification_sha256'] != fingerprint(specpath):
            raise ValueError('Cached reference specification failed integrity verification')
        load_input(cached['audio_sha256'])
        suite = json.loads((root / 'suite.json').read_text())
        if suite[0]['sha256'] != cached['audio_sha256']:
            raise ValueError('Cached suite does not match fixture')
        print(json.dumps({'suite': str(root / 'suite.json'), 'duration': cached['duration'], 'sha256': cached['audio_sha256'], 'cached': True}))
        return
    from faster_whisper.audio import decode_audio
    import numpy as np
    chunks, anchors, offset = [], [], 0
    with tempfile.TemporaryDirectory(dir=root, prefix='synthesis-') as temporary:
        for i, text in enumerate(PARTS):
            script = Path(temporary) / f'{i}.txt'
            script.write_text(text)
            audio = Path(temporary) / f'{i}.aiff'
            subprocess.run(['/usr/bin/say', '-v', 'Milena', '-r', '135', '-f', str(script), '-o', str(audio)], check=True, timeout=90)
            decoded = decode_audio(str(audio), sampling_rate=16000)
            anchor_start = offset if i < 2 else offset + max(0, len(decoded) - 8*16000)
            anchor_end = offset + min(len(decoded), 8*16000) if i < 2 else offset + len(decoded)
            anchors.append({'start': anchor_start / 16000, 'end': anchor_end / 16000,
                            'pattern': PHRASES[i].replace('ё', 'е'),
                            'provenance': 'Prewritten original script before any ASR; offline Milena; specification.json',
                            'reference_kind': 'prewritten-script'})
            chunks.extend([decoded, np.zeros(4800, dtype=np.float32)])
            offset += len(decoded) + 4800
        joined = np.concatenate(chunks[:-1])
        if len(joined) < 60*16000:
            raise ValueError('Actual synthesized speech must exceed one minute; never pad to pass')
        output = Path(temporary) / 'speech.wav'
        with wave.open(str(output), 'wb') as wav:
            wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            wav.writeframes((np.clip(joined, -1, 1)*32767).astype('<i2').tobytes())
        manifest = retain_recording(output, 'independent-milena-v2', {'model': 'wav2vec2-rukk', 'language': 'multi'})
    case = {'sha256': manifest['sha256'], 'model': 'wav2vec2-rukk', 'language': 'multi', 'min_duration': 60,
            'anchors': anchors, 'reference_text': specification['script'], 'reference_provenance': specification['source'],
            'max_wer': .20, 'min_token_recall': .85}
    atomic_json(root / 'suite.json', [case])
    atomic_json(root / 'provenance.json', {'specification_sha256': fingerprint(specpath), 'audio_sha256': manifest['sha256'],
                'samples': len(joined), 'sample_rate': 16000, 'duration': len(joined)/16000,
                'synthesis': specification['synthesis'], 'generator_sha256': fingerprint(Path(__file__))})
    print(json.dumps({'suite': str(root / 'suite.json'), 'duration': len(joined)/16000, 'sha256': manifest['sha256']}))


if __name__ == '__main__':
    main()
