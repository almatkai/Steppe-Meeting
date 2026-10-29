"""Offline private recording cache/replay. See docs/local-stt-regression.md."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import platform
import re
import socket
import sys
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from recording_cache import retain_recording, load_input, cache_dir, atomic_json, fingerprint
from engine import whisper_service as stt


def normalize_text(text):
    return re.findall(r"[а-яa-z0-9]+", text.casefold().replace('ё', 'е'))


def reference_metrics(case, result):
    """Ordered edit distance and LCS recall against a pre-existing reference."""
    if 'reference_text' not in case:
        return None
    if not case.get('reference_provenance'):
        raise ValueError('Full reference requires provenance')
    ref = normalize_text(case['reference_text'])
    hyp = normalize_text(' '.join(s['text'] for s in result['segments']))
    if not ref:
        raise ValueError('Empty full reference')
    distance = list(range(len(hyp) + 1))
    lcs = [0] * (len(hyp) + 1)
    for i, token in enumerate(ref, 1):
        following, common = [i], [0]
        for j, other in enumerate(hyp, 1):
            following.append(min(distance[j]+1, following[-1]+1, distance[j-1]+(token != other)))
            common.append(lcs[j-1]+1 if token == other else max(lcs[j], common[-1]))
        distance, lcs = following, common
    wer, recall = distance[-1]/len(ref), lcs[-1]/len(ref)
    return {'reference_tokens': len(ref), 'hypothesis_tokens': len(hyp), 'edit_distance': distance[-1],
            'wer': wer, 'token_recall': recall, 'max_wer': case['max_wer'],
            'min_token_recall': case['min_token_recall'],
            'pass': wer <= case['max_wer'] and recall >= case['min_token_recall']}


def evaluate_result(case, result, decoded_duration):
    """Lexical evidence must occur at its original time, not just somewhere in a file."""
    checks = []
    for anchor in case['anchors']:
        if not anchor.get('provenance'):
            raise ValueError('Required lexical anchors need independent/human provenance')
        start, end = anchor['start'], anchor['end']
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= decoded_duration + .02):
            raise ValueError('Anchor outside decoded audio')
        text = ' '.join(s['text'] for s in result['segments']
                        if s['timestamp_start'] < end and s['timestamp_end'] > start).casefold().replace('ё', 'е')
        checks.append(bool(re.search(anchor['pattern'], text)))
    valid = bool(checks) and math.isfinite(result['duration'])
    valid = valid and abs(result['duration'] - decoded_duration) < .02
    valid = valid and result['duration'] >= case.get('min_duration', 0)
    previous = -1
    for segment in result['segments']:
        start, end = segment['timestamp_start'], segment['timestamp_end']
        valid = valid and math.isfinite(start) and math.isfinite(end)
        valid = valid and 0 <= start < end <= decoded_duration + .02 and start >= previous
        previous = start
    return checks, valid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    cache = sub.add_parser('cache')
    cache.add_argument('--audio', type=Path, required=True)
    cache.add_argument('--source-id', required=True)
    cache.add_argument('--model', required=True, choices=stt.STT_MODELS_CATALOG)
    cache.add_argument('--language', default='multi')
    replay = sub.add_parser('replay')
    replay.add_argument('--suite', type=Path, required=True)
    replay.add_argument('--model', choices=stt.STT_MODELS_CATALOG, help='Explicit diagnostic model override; does not change app settings')
    replay.add_argument('--language', help='Explicit diagnostic language override')
    replay.add_argument('--model-dir', type=Path, help='Existing offline weights directory for the explicit --model')
    args = parser.parse_args()
    if args.command == 'replay' and args.model_dir:
        if not args.model or not args.model_dir.is_dir():
            parser.error('--model-dir requires --model and an existing directory')
        model_path = args.model_dir.resolve()
        stt.get_model_path = lambda model_id: model_path
        if not stt.is_model_downloaded(args.model):
            parser.error('Offline model directory is incomplete or invalid')
    if args.command == 'cache':
        print(retain_recording(args.audio, args.source_id, {'mode':'local', 'model':args.model, 'language':args.language, 'device':'auto'})['sha256'])
        return
    suite = json.loads(args.suite.read_text())
    if not isinstance(suite, list) or not suite:
        raise ValueError('Suite must contain required real cases; empty/missing is not a pass')
    failed = []
    for original_case in suite:
        case = dict(original_case)
        if args.model:
            case['model'] = args.model
        if args.language:
            case['language'] = args.language
        sha = case['sha256']
        audio_path = load_input(sha)
        anchors = case['anchors']
        if not anchors or any(not a.get('provenance') for a in anchors):
            raise ValueError('Required lexical anchors need independent/human provenance')
        t = time.monotonic()
        with patch.object(socket.socket, 'connect', side_effect=AssertionError('Offline replay attempted network')):
            result = stt.transcribe_local(str(audio_path), case['model'], language=case.get('language','multi'), streaming=case.get('streaming',False))
        inferred = time.monotonic()
        from faster_whisper.audio import decode_audio
        from faster_whisper.vad import get_speech_timestamps, VadOptions
        decoded = decode_audio(str(audio_path)); spans = get_speech_timestamps(decoded,VadOptions(min_silence_duration_ms=500))
        measured = time.monotonic()
        checks, valid = evaluate_result(case, result, len(decoded)/16000)
        info = stt.get_model_info(case['model'])
        package_names = ['faster-whisper', 'av', 'ctranslate2']
        package_names += {'wav2vec2-ctc':['torch'], 'vosk':['vosk'],
                          'gigaam-mlx':['mlx', 'gigaam-multilingual-mlx']}.get(info['engine'], [])
        runtime = {'python':sys.executable, 'version':platform.python_version(),
                   'packages':{name:importlib.metadata.version(name) for name in package_names}}
        model_files = {name:fingerprint(stt.get_model_path(case['model'])/name) for name in info['required_files']}
        options = {'engine':info['engine'], 'device':'auto', 'language':case.get('language','multi')}
        if info['engine'] == 'faster-whisper':
            options.update(beam_size=1 if case.get('streaming',False) else 5, compute_type='int8',
                vad_filter=True, vad_parameters={'min_silence_duration_ms':500},
                condition_on_previous_text=info.get('transcription_options',{}).get('condition_on_previous_text',True))
        elif info['engine'] == 'wav2vec2-ctc':
            options.update(decoder='greedy-ctc', sample_rate=16000, max_chunk_seconds=20,
                           vad_parameters={'min_speech_duration_ms':100, 'max_speech_duration_s':20,
                                           'min_silence_duration_ms':500, 'speech_pad_ms':200})
        report = {'schema':1,'sha256':sha,'model':case['model'],'model_files':model_files,'runtime':runtime,
            'options':options, 'requested_model':original_case['model'],
            'suite_sha256':fingerprint(args.suite), 'anchors':anchors,
            'same_model_anchor_reference':any(case['model'] in a['provenance'] for a in anchors),
            'streaming':case.get('streaming',False),'language':case.get('language','multi'),
            'source_files':{name:fingerprint(Path(stt.__file__).parent/name) for name in ('whisper_service.py','local_stt.py','stt_catalog.py')},
            'samples':len(decoded),'sample_rate':16000,'inference_seconds':round(inferred-t,3),
            'measurement_decode_vad_seconds':round(measured-inferred,3),
            'vad':[{'start':s['start']/16000,'end':s['end']/16000} for s in spans],
            'anchor_checks':checks,'timestamps_valid':valid,'result':result,
            'reference_metrics':reference_metrics(case, result),
            'anchor_evidence':[{'reference_kind':a.get('reference_kind', 'recognizer-derived; requires independent review'),
                                'same_recognizer':case['model'] in a['provenance']} for a in anchors]}
        identity = {key:report[key] for key in ('model_files','runtime','options','streaming','language','source_files','suite_sha256')}
        run_key = hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()[:16]
        atomic_json(cache_dir()/'reports'/sha/f'{run_key}.json',report)
        ok = all(checks) and valid and (report['reference_metrics'] is None or report['reference_metrics']['pass'])
        print(sha, 'PASS' if ok else 'FAIL', 'anchors',checks,'duration',result['duration'],'segments',len(result['segments']),
              'same-model reference' if report['same_model_anchor_reference'] else 'reference requires review',flush=True)
        if report['reference_metrics'] is not None: print('Reference metrics', report['reference_metrics'], flush=True)
        if not ok: failed.append(sha)
    if failed: raise AssertionError('Real speech regression failed: '+','.join(failed))

if __name__ == '__main__':
    main()
