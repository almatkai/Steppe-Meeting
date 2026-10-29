import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from recording_cache import retain_recording,load_input,atomic_json

class CacheTests(unittest.TestCase):
    def test_retry_deduplicates_and_survives_source_deletion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); audio=root/'recording.webm'; audio.write_bytes(b'private finalized audio')
            original=audio.read_bytes()
            config={'model':'small','language':'ru','api_key':'secret','url':'private'}
            a=retain_recording(audio,'meeting',config,root=root/'cache')
            b=retain_recording(audio,'meeting',config,root=root/'cache')
            self.assertEqual(a,b);self.assertEqual(audio.read_bytes(),original)
            self.assertNotIn('secret',json.dumps(a));self.assertNotIn('url',a['config'])
            self.assertEqual(len(list((root/'cache/audio').iterdir())),1)
            audio.unlink();cached=load_input(a['sha256'],root/'cache')
            self.assertEqual(cached.read_bytes(),original)
            if os.name!='nt': self.assertEqual(cached.stat().st_mode & 0o777,0o400)
            cached.chmod(0o600);cached.write_bytes(b'corrupt')
            with self.assertRaises(ValueError):load_input(a['sha256'],root/'cache')

    def test_failed_publication_does_not_claim_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/'audio';p.write_bytes(b'audio')
            with patch('recording_cache.atomic_json',side_effect=OSError('disk full')):
                with self.assertRaises(OSError):retain_recording(p,'id',{},root=root/'cache')
            self.assertEqual(p.read_bytes(),b'audio')
            self.assertFalse((root/'cache/cases').exists())

    def test_nested_manifests_are_private_and_failed_write_can_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            atomic_json(root/'cases'/'sha'/'sources'/'case.json', {'ok': True})
            if os.name != 'nt':
                for directory in [root/'cases', root/'cases'/'sha', root/'cases'/'sha'/'sources']:
                    self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                self.assertEqual((root/'cases'/'sha'/'sources'/'case.json').stat().st_mode & 0o777, 0o600)
            audio = root/'input'; audio.write_bytes(b'retry input')
            with patch('recording_cache.atomic_json', side_effect=OSError('disk full')):
                with self.assertRaises(OSError): retain_recording(audio, 'retry', {}, root=root/'cache')
            result = retain_recording(audio, 'retry', {}, root=root/'cache')
            self.assertEqual(load_input(result['sha256'], root/'cache').read_bytes(), b'retry input')
            self.assertEqual(len(list((root/'cache'/'audio').iterdir())), 1)

    def test_opt_in_replay_cannot_pass_without_required_private_cases(self):
        script = Path(__file__).resolve().parents[2] / 'scripts/replay-recordings.py'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);suite=root/'suite.json'
            for content in (None, [], [{'sha256':'0'*64,'model':'small','anchors':[]} ]):
                if content is not None:suite.write_text(json.dumps(content))
                result=subprocess.run([sys.executable,str(script),'replay','--suite',str(suite)],
                    env={**os.environ,'STEPPE_DATA_DIR':tmp},capture_output=True,text=True)
                self.assertNotEqual(result.returncode,0,result.stdout)

if __name__=='__main__':unittest.main()
