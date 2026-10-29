"""Real packaged Tauri/helper/backend gate. Never launches the installed app.

Requires the audited production build as a resource baseline. Compiles two native
fixture executables in a TEMP target directory; no checkout version changes.
No network release, installed-app port, UI automation or security bypass is used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
MARKER = b'STEPPE_PACKAGED_UPDATER_FIXTURE_ONLY'


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()


def run(args, *, env=None, timeout=120):
    process = subprocess.Popen(list(map(str, args)), cwd=ROOT, env=env,
                               start_new_session=True, stdout=LOG, stderr=LOG)
    try:
        if process.wait(timeout=timeout):
            raise RuntimeError(f'command failed: {args[0]} (see diagnostic log)')
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)


def processes():
    lines = subprocess.check_output(['/bin/ps', '-axo', 'pid=,pgid=,comm='], text=True).splitlines()
    return [line.strip().split(None, 2) for line in lines if len(line.strip().split(None, 2)) == 3]


def clean_owned(root):
    # Only exact executable paths under this mkdtemp root. Groups are signalled
    # only when the group leader itself is that owned executable.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid, group, executable in processes():
            if executable.startswith(str(root) + '/'):
                try:
                    os.killpg(int(group), sig) if pid == group else os.kill(int(pid), sig)
                except ProcessLookupError:
                    pass
        if sig == signal.SIGTERM:
            time.sleep(.5)


def fixture_bundle(root, baseline, version, port, name):
    html = root / 'html'
    html.mkdir(exist_ok=True)
    (html/'index.html').write_text((ROOT/'scripts/updater-fixture/index.html').read_text().replace('FIXTURE_PORT', str(port)))
    env = dict(os.environ, STEPPE_FIXTURE_ROOT=str(root), STEPPE_FIXTURE_PORT=str(port), STEPPE_FIXTURE_VERSION=version,
               TAURI_CONFIG=json.dumps({'version': version, 'build': {'frontendDist': str(html), 'beforeBuildCommand': ''}}))
    run(['cargo', 'build', '--manifest-path', ROOT/'src-tauri/Cargo.toml', '--release', '--locked',
         '--features', 'packaged-updater-fixture,tauri/custom-protocol', '--target-dir', ROOT/'src-tauri/target'], env=env, timeout=BUILD_TIMEOUT)
    app = root/name/'Steppe Meeting.app'
    app.parent.mkdir()
    run(['/usr/bin/ditto', baseline, app])
    binary = app/'Contents/MacOS/steppe-desktop'
    shutil.copy2(ROOT/'src-tauri/target/release/steppe-desktop', binary)
    assert MARKER in binary.read_bytes(), 'native fixture feature missing'
    info_path = app/'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    info.update(CFBundleShortVersionString=version, CFBundleVersion=version)
    info_path.write_bytes(plistlib.dumps(info))
    resources = app/'Contents/Resources'
    backend = resources/'backend'
    # Older local artifacts supply only runtime/templates. Always exercise this
    # reviewed source, not the backend that happened to ship in that artifact.
    for pattern in ('*.py', 'engine/*.py', 'engine/core/*.py', 'run_backend.sh'):
        for source in (ROOT/'backend').glob(pattern):
            destination = backend/source.relative_to(ROOT/'backend')
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    (backend/'desktop_server.py').rename(backend/'product_server.py')
    wrapper = (ROOT/'scripts/updater-fixture/backend.py').read_text().replace("Path(__file__).resolve().parents[3]", repr(str(root)))
    wrapper = wrapper.replace('ROOT = '+repr(str(root)), 'ROOT = Path('+repr(str(root))+')')
    (backend/'desktop_server.py').write_text(wrapper)
    # Transport-only adaptation in this signed TEMP helper. Transaction, verifier,
    # private auth, PID wait and recovery code are unchanged.
    installer = backend/'update_installer.py'
    installer.write_text(installer.read_text().replace('127.0.0.1:8008/', f'127.0.0.1:{port}/'))
    stamp = json.loads((resources/'build-info.json').read_text())
    stamp.update(version=version, fixture_only=True,
                 source_files={str(p.relative_to(resources)): sha(p) for p in backend.rglob('*') if p.is_file()})
    # requirements lock lives in runtime in the signed resources.
    stamp['source_files'].pop('backend/requirements-macos-arm64.lock', None)
    (resources/'build-info.json').write_text(json.dumps(stamp))
    run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', app])
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, default=ROOT/'build/packaged-updater-smoke.json')
    parser.add_argument('--build-timeout', type=int, default=1800)
    args = parser.parse_args()
    global BUILD_TIMEOUT
    BUILD_TIMEOUT = args.build_timeout
    assert sys.platform == 'darwin' and os.uname().machine == 'arm64'
    baseline = args.app.resolve(strict=True)
    assert (baseline.is_relative_to(ROOT/'src-tauri/target') or (baseline.parent.is_relative_to(Path(tempfile.gettempdir()).resolve()) and (baseline.parent/'fixture-owner').is_file())), 'Only build output or explicitly owned TEMP baseline accepted'
    assert MARKER not in (baseline/'Contents/MacOS/steppe-desktop').read_bytes(), 'Baseline must be shipping build'
    args.receipt.unlink(missing_ok=True)  # A stale PASS must never survive failure.
    with tempfile.TemporaryDirectory(prefix='steppe-packaged-updater-') as temporary:
        root = Path(temporary).resolve()
        (root/'fixture-owner').touch(mode=0o600)
        (root/'data').mkdir(mode=0o700)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        assert port != 8008
        started = time.monotonic()
        try:
            new_version = json.loads((ROOT/'package.json').read_text())['version']
            base, beta = new_version.rsplit('-beta.', 1)
            assert int(beta) > 0, 'Fixture requires a positive beta revision'
            old_version = f'{base}-beta.{int(beta)-1}'
            old = fixture_bundle(root, baseline, old_version, port, 'old')
            new = fixture_bundle(root, baseline, new_version, port, 'new')
            # The backend wrapper has a compiled TEMP root; both bundles have
            # identical production backend source except transport adapters.
            old_hash, new_hash = sha(old/'Contents/MacOS/steppe-desktop'), sha(new/'Contents/MacOS/steppe-desktop')
            assert old_hash != new_hash
            (root/'candidate.json').write_text(json.dumps({'version': new_version}))
            run(['/usr/bin/hdiutil', 'create', '-quiet', '-fs', 'HFS+', '-srcfolder', new.parent, root/'candidate.dmg'])
            install = root/'Steppe Meeting.app'
            run(['/usr/bin/ditto', old, install])
            # Wrapper root is compiled explicitly; not derived from .app depth.
            run(['/usr/bin/open', '-n', install], timeout=15)
            deadline = time.monotonic() + 240
            reports = []
            while time.monotonic() < deadline:
                reports = [json.loads(p.read_text()) for p in root.glob('native-*.json')]
                if any(r['value'].get('passed') is False for r in reports):
                    raise AssertionError(reports)
                if any(r['value'].get('label') == 'rollback' for r in reports):
                    break
                time.sleep(.2)
            else:
                raise TimeoutError('Packaged lifecycle did not finish; see diagnostics')
            assert (root/'browser-denied.json').is_file(), 'HTTP browser origin was not exercised'
            assert (root/'repeat-install.json').is_file(), 'concurrent IPC was not exercised'
            for label in ('old', 'main', 'mini', 'rollback'):
                assert any(r['value'].get('label') == label and r['value']['passed'] for r in reports), (label, reports)
            old_report = next(r for r in reports if r['value']['label']=='old')
            new_report = next(r for r in reports if r['value']['label']=='main')
            rollback = next(r for r in reports if r['value']['label']=='rollback')
            assert old_report['pid'] != new_report['pid'] != rollback['pid']
            assert old_report['value']['health']['pid'] != new_report['value']['health']['pid']
            for report in (old_report, new_report):
                assert json.loads((root/f"exit-{report['pid']}.json").read_text())['backend_stopped']
            assert all(r['tauri_version'] == r['version'] for r in reports), 'native Tauri package version mismatch'
            assert old_report['version'] == old_report['value']['health']['app_version'] == old_version
            assert new_report['version'] == new_report['value']['health']['app_version'] == new_version
            assert rollback['version'] == rollback['value']['health']['app_version'] == old_version
            health = new_report['value']['health']
            assert health['backend_dir'] == str(install/'Contents/Resources/backend')
            assert health['runtime']=='bundled' and health['update_receipt']=='a'*32
            journal = json.loads((root/'data/updates'/('a'*32)/'transaction.json').read_text())
            assert journal['pid'] == new_report['pid']  # explicit recovery handoff
            assert journal['backend_pid'] == health['pid']
            state = json.loads((root/'data/updates'/('a'*32)/'state.json').read_text())
            assert state['stage'] == 'rolled_back'
            assert sha(install/'Contents/MacOS/steppe-desktop') == old_hash
            assert (root/'data/updates').stat().st_mode & 0o777 == 0o700
            receipt = dict(result='PASS', old_version=old_version, new_version=new_version,
                           old_executable_sha256=old_hash, new_executable_sha256=new_hash,
                           dmg_sha256=sha(root/'candidate.dmg'), duration_seconds=round(time.monotonic()-started, 2),
                           rollback=state['stage'], private_directory_mode='0700', port=port, reports=reports,
                           scope='compiled TEMP fixture; production transport roots unchanged')
            args.receipt.parent.mkdir(exist_ok=True, parents=True)
            args.receipt.write_text(json.dumps(receipt, indent=2)+'\n')
            print('PASS:', args.receipt)
        finally:
            os.chmod(root, 0o700)
            clean_owned(root)
            for log in (root/'logs').glob('*') if (root/'logs').exists() else []:
                LOG.write(log.read_text(errors='replace'))
            LOG.flush()


if __name__ == '__main__':
    (ROOT/'build').mkdir(exist_ok=True)
    with (ROOT/'build/packaged-updater-smoke.log').open('w') as LOG:
        main()
