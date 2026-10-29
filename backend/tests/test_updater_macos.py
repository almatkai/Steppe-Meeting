"""Real macOS tools, TEMP bundles only. No HTTP or product app launch."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from update_installer import run, sha256, stage_image, verify

@unittest.skipUnless(sys.platform == 'darwin', 'macOS native integration')
class NativeImageTests(unittest.TestCase):
    def test_readonly_real_dmg_adhoc_arm64_verify_stage_and_reject_corruption(self):
        with tempfile.TemporaryDirectory(prefix='steppe-dmg-test-') as temporary:
            root = Path(temporary).resolve()
            source = root/'image'; source.mkdir()
            app = source/'Steppe Meeting.app'
            resources = app/'Contents/Resources'
            (resources/'runtime').mkdir(parents=True)
            (resources/'backend').mkdir()
            (app/'Contents/MacOS').mkdir()
            code = root/'stub.c'; code.write_text('#include <stdio.h>\n#include <stdlib.h>\nint main(void) { const char *p=getenv("STEPPE_DATA_DIR"); const char *r=getenv("STEPPE_UPDATE_RECEIPT"); if(p && r) { char b[4096]; snprintf(b,sizeof(b),"%s/receipt",p); FILE *f=fopen(b,"w"); if(f) {fputs(r,f); fclose(f);} } return 0; }\n')
            run(['/usr/bin/clang', '-arch','arm64',code,'-o',app/'Contents/MacOS/steppe-desktop'])
            (app/'Contents/Info.plist').write_bytes(plistlib.dumps(dict(CFBundleIdentifier='app.steppe.meeting',
                CFBundleName='Steppe Meeting',CFBundleExecutable='steppe-desktop',CFBundleShortVersionString='0.3.0',CFBundlePackageType='APPL')))
            backend = resources/'backend/fixture.py'; backend.write_text('# public dummy fixture\n')
            runtime = resources/'runtime/fixture'; runtime.write_bytes(b'public fixture')
            manifest = resources/'runtime/manifest.json'
            manifest.write_text(json.dumps({'files':{'fixture':sha256(runtime)}}))
            (resources/'build-info.json').write_text(json.dumps(dict(version='0.3.0',
                runtime_manifest_sha256=sha256(manifest),source_files={'backend/fixture.py':sha256(backend)})))
            run(['/usr/bin/codesign','--force','--deep','--sign','-',app])
            verify(app,'0.3.0')
            # Exercise the product's LaunchServices mechanism with a headless
            # TEMP executable and explicit isolated data/receipt environment.
            run(['/usr/bin/open','-n','--env','STEPPE_DATA_DIR='+str(root),
                 '--env','STEPPE_UPDATE_RECEIPT=temp-fixture',app], 15)
            deadline = time.monotonic() + 10
            while not (root/'receipt').exists() and time.monotonic() < deadline:
                time.sleep(.05)
            self.assertEqual((root/'receipt').read_text(), 'temp-fixture')
            with self.assertRaises(ValueError): verify(app,'0.4.0')
            job = root/'job'; job.mkdir()
            run(['/usr/bin/hdiutil','create','-quiet','-fs','HFS+','-srcfolder',source,job/'ready.dmg'])
            stage = root/'STAGE.app'
            stage_image(job, {'version':'0.3.0'}, stage)
            verify(stage,'0.3.0')
            self.assertFalse(os.path.ismount(job/'mount'))
            (stage/'Contents/Resources/runtime/fixture').write_bytes(b'corrupt')
            with self.assertRaises((ValueError, subprocess.CalledProcessError)): verify(stage,'0.3.0')

if __name__ == '__main__': unittest.main()
