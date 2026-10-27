"""macOS native startup/lifecycle smoke, with isolated data and no STT downloads.

Run after `pnpm exec tauri build --debug --bundles app`. Port 8008 must be free.
Only processes created by this script (including their reported backend PID)
are stopped. No real saved settings are read or changed.
"""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'src-tauri/target/debug/bundle/macos/Steppe Meeting.app'
BASE = 'http://127.0.0.1:8008/api/v1'


def get(path):
    with urlopen(BASE + path, timeout=2) as response:
        return json.load(response)


def ready(process, previous_pid=None):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f'process exited: {process.returncode}')
        try:
            health = get('/system/health')
            assert health['backend_dir'] == str(ROOT / 'backend'), health
            if health['pid'] != previous_pid:
                return health['pid']
        except (OSError, ValueError):
            pass
        time.sleep(.2)
    raise RuntimeError('backend did not become ready in 45 seconds')


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def quit_app(process):
    subprocess.run(['osascript', '-e', f'tell application "{APP}" to quit'], check=True, timeout=10)
    process.wait(timeout=10)


def main():
    assert APP.is_dir(), 'Build the .app first'
    with socket.socket() as probe:
        assert probe.connect_ex(('127.0.0.1', 8008)) != 0, 'Port 8008 is in use; no processes were changed'
    with tempfile.TemporaryDirectory(prefix='steppe-native-smoke-') as folder:
        env = {**os.environ, 'STEPPE_DATA_DIR': folder}
        owned_pids = []
        processes = []
        with open(Path(folder) / 'smoke.log', 'w') as log:
            def launch():
                process = subprocess.Popen([str(APP / 'Contents/MacOS/steppe-desktop')], cwd='/', env=env, stdout=log, stderr=log)
                processes.append(process)
                return process
            try:
                app = launch()
                backend = ready(app)
                owned_pids.append(backend)
                assert len(get('/system/whisper/status')['local']['catalog']) == 17
                assert get('/templates')
                assert Path(folder, 'meetings.db').is_file()
                print('PASS direct .app launch: backend ready, catalog and templates loaded, isolated DB', flush=True)
                # Existing environments need no downloads for this action.
                from urllib.request import Request
                request = Request(BASE + '/system/whisper/install-env', data=b'{"model":"small"}', headers={'Content-Type': 'application/json'})
                with urlopen(request, timeout=5) as response:
                    assert json.load(response)['status'] in ('already_installed', 'started')
                print('PASS model-specific environment action responds without downloading weights', flush=True)
                os.kill(backend, signal.SIGTERM)
                restarted = ready(app, previous_pid=backend)
                owned_pids.append(restarted)
                print('PASS API polling recovers a crashed backend without restarting the .app', flush=True)
                quit_app(app)
                assert not alive(restarted), 'Owned backend survived Quit'
                print('PASS Quit exits app and stops owned backend', flush=True)
                external = subprocess.Popen([str(ROOT / 'backend/run_backend.sh')], cwd='/', env=env, stdout=log, stderr=log)
                processes.append(external)
                assert ready(external) == external.pid
                app = launch()
                time.sleep(2)
                assert get('/system/health')['pid'] == external.pid
                quit_app(app)
                assert external.poll() is None, 'Quit killed a reused external backend'
                print('PASS existing same-checkout backend is reused and survives app Quit', flush=True)
            finally:
                for process in reversed(processes):
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=10)
                for pid in owned_pids:
                    if alive(pid):
                        os.kill(pid, signal.SIGTERM)


if __name__ == '__main__':
    main()
