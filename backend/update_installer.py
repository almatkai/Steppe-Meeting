"""macOS installer/helper v1. Only private native handoff calls prepare.

No shell, DMG executable, global signal, settings or runtime migration is used.
The helper and its interpreter live outside the application being replaced.
"""
from __future__ import annotations
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen
import hashlib


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)

def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_bundle(bundle):
    # Persist the complete staged tree before publishing the new directory entry.
    for root, directories, files in os.walk(bundle, topdown=False, followlinks=False):
        for name in files:
            path = Path(root) / name
            if path.is_symlink():
                continue
            with path.open('rb') as stream:
                os.fsync(stream.fileno())
        sync_directory(root)


def exchange(first, second):
    """Fail closed; never emulate atomic exchange with two renames."""
    if sys.platform != 'darwin':
        raise OSError(errno.ENOTSUP, 'Atomic bundle exchange requires macOS')
    library = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    function = getattr(library, 'renamex_np', None)
    if function is None:
        raise OSError(errno.ENOTSUP, 'renamex_np unavailable')
    function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(os.fsencode(first), os.fsencode(second), 2):  # RENAME_SWAP
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    sync_directory(Path(first).parent)


def node(path):
    stat = Path(path).stat(follow_symlinks=False)
    return [stat.st_dev, stat.st_ino]


def read_json(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def trusted_paths(directory, config):
    """Journal paths are data, never authority to touch an arbitrary bundle."""
    app = Path(os.environ['STEPPE_NATIVE_APP']).resolve(strict=True)
    if (Path(config['app']) != app or app.suffix != '.app'
            or not directory.name.isalnum() or len(directory.name) != 32):
        raise ValueError('Invalid native transaction')
    for key, prefix in (('stage', '.steppe-update-'), ('backup', '.steppe-backup-')):
        path = Path(config[key])
        if path != app.parent / (prefix + directory.name + '.app') or path.is_symlink():
            raise ValueError('Invalid owned transaction path')
    return app


def retain_previous(directory, config):
    """Only a later healthy transaction can retire an older owned backup."""
    app = trusted_paths(directory, config)
    for path in directory.parent.glob('*/transaction.json'):
        if path.parent == directory or path.parent.is_symlink():
            continue
        prior = read_json(path)
        receipt = read_json(path.parent / 'state.json')
        if not prior or not receipt or receipt.get('stage') not in ('completed', 'error', 'rolled_back', 'idle', 'cancelled'):
            continue
        try:
            if trusted_paths(path.parent, prior) != app:
                continue
            backup = Path(prior['backup'])
            expected_backup = prior.get('new_node') if receipt.get('stage') == 'rolled_back' else prior['old_node']
            if backup.exists() and node(backup) == expected_backup:
                shutil.rmtree(backup)
                sync_directory(app.parent)
            stage = Path(prior['stage'])
            if (stage.exists() and node(stage) == prior.get('new_node')
                    and node(stage) != config.get('old_node')):
                shutil.rmtree(stage)
                sync_directory(app.parent)
            for name in ('ready.dmg', 'download.part'):
                (path.parent / name).unlink(missing_ok=True)
        except (OSError, ValueError, KeyError):
            continue
    (directory / 'ready.dmg').unlink(missing_ok=True)


def helper_active(directory, config):
    # PID alone (or a stale ready file) is not ownership. A real helper must
    # match its executable/start identity AND still hold the transaction lock.
    try:
        if not alive(config['helper_pid'], config['helper_identity']):
            return False
        with (Path(config['app']).parent / '.steppe-update.lock').open('r') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return False
            except BlockingIOError:
                return True
    except (KeyError, OSError, TypeError, ValueError, subprocess.SubprocessError):
        return False


def classify(directory, state, *, current_version=None):
    """Observe journals only. Never run an installer from startup metadata."""
    config = read_json(directory / 'transaction.json')
    if not config:
        return dict(state, stage='error', cancellable=False, retry=True,
                    error_code='journal_invalid', error='Журнал установки недоступен. Проверьте обновления снова.')
    if helper_active(directory, config):
        return state
    try:
        app = Path(config['app'])
        # This backend can confirm only its own native launch receipt, version,
        # bundled source, and exact native process. No HTTP assertion is trusted.
        authentic = (os.environ.get('STEPPE_UPDATE_RECEIPT') == directory.name
                     and os.environ.get('STEPPE_BUNDLED_RUNTIME') == '1'
                     and os.environ.get('STEPPE_NATIVE_APP') == str(app)
                     and current_version == config['version']
                     and Path(__file__).resolve().parent == app / 'Contents/Resources/backend'
                     and alive(int(os.environ['STEPPE_NATIVE_PID']), os.environ['STEPPE_NATIVE_IDENTITY']))
        if authentic:
            trusted_paths(directory, config)
            verify(app, config['version'])
            if node(app) != config['new_node']:
                raise ValueError('Unexpected installed bundle')
            stage, backup = Path(config['stage']), Path(config['backup'])
            if not backup.exists() and stage.exists() and node(stage) == config['old_node']:
                os.rename(stage, backup)
                sync_directory(app.parent)
            state = dict(state, stage='completed', error=None, error_code=None, retry=False, cancellable=False)
            atomic_json(directory / 'state.json', state)
            try:
                retain_previous(directory, config)
            except OSError:
                pass  # Cleanup failure cannot invalidate a healthy receipt.
            return state
        old_at_app = node(app) == config['old_node']
        return dict(state, stage='error' if old_at_app else 'recovery_required', retry=True,
                    cancellable=False, error_code='interrupted' if old_at_app else 'recovery_required',
                    error='Установка прервана. Повторите загрузку.' if old_at_app else
                    'Предыдущая версия сохранена. Закройте приложение перед восстановлением.')
    except (KeyError, OSError, ValueError, TypeError, subprocess.SubprocessError):
        return dict(state, stage='recovery_required', retry=True, cancellable=False,
                    error_code='journal_invalid', error='Не удалось проверить журнал установки.')


HELPER_VERSION = 1


def run(args, timeout=120):
    return subprocess.run([str(a) for a in args], check=True, capture_output=True, timeout=timeout).stdout


def identity(pid):
    value = run(['/bin/ps', '-p', str(pid), '-o', 'lstart=', '-o', 'comm='], 5).decode().strip()
    return value or None


def alive(pid, expected):
    try:
        return identity(pid) == expected
    except subprocess.CalledProcessError:
        return False


def app_instances(app):
    executable = str(app / 'Contents/MacOS/steppe-desktop')
    lines = run(['/bin/ps', '-axo', 'pid=,comm='], 5).decode().splitlines()
    return [int(line.strip().split(None, 1)[0]) for line in lines if line.strip().split(None, 1)[-1] == executable]


def verify(app, version):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if (info.get('CFBundleIdentifier') != 'app.steppe.meeting' or info.get('CFBundleName') != 'Steppe Meeting'
            or info.get('CFBundleShortVersionString') != version or info.get('CFBundleExecutable') != 'steppe-desktop'):
        raise ValueError('Неверная версия или идентификатор приложения.')
    run(['/usr/bin/lipo', app / 'Contents/MacOS/steppe-desktop', '-verify_arch', 'arm64'])
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
    resources = app / 'Contents/Resources'
    stamp = json.loads((resources / 'build-info.json').read_text())
    if stamp['version'] != version:
        raise ValueError('Версия манифеста не совпадает.')
    # Runtime checksums are produced by this repository's packaging pipeline.
    manifest = resources / 'runtime/manifest.json'
    if sha256(manifest) != stamp['runtime_manifest_sha256']:
        raise ValueError('Повреждён манифест Python.')
    for relative, digest in json.loads(manifest.read_text())['files'].items():
        target = (manifest.parent / relative).resolve()
        if not target.is_relative_to(manifest.parent.resolve()) or sha256(target) != digest:
            raise ValueError('Повреждён встроенный runtime.')
    # Signed resources bind backend/helper/source bytes; additionally check the
    # complete source list supplied by the build stamp when available.
    for relative, digest in stamp['source_files'].items():
        if relative.startswith('backend/'):
            target = resources / ('runtime/requirements.lock' if relative == 'backend/requirements-macos-arm64.lock' else relative)
            if not target.resolve().is_relative_to(resources.resolve()) or not target.is_file() or sha256(target) != digest:
                raise ValueError('Исходники не совпадают с манифестом.')



def stage_image(directory, pin, stage):
    mount = directory / 'mount'
    mount.mkdir(mode=0o700)
    mounted = False
    try:
        run(['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, directory / 'ready.dmg'])
        mounted = True
        source = mount / 'Steppe Meeting.app'
        if source.is_symlink() or not source.resolve().is_relative_to(mount.resolve()):
            raise ValueError('Недопустимый bundle на диске.')
        verify(source, pin['version'])
        run(['/usr/bin/ditto', source, stage])
        verify(stage, pin['version'])
        sync_bundle(stage)
    except BaseException:
        if stage.exists():
            shutil.rmtree(stage)
        raise
    finally:
        if mounted or os.path.ismount(mount):
            run(['/usr/bin/hdiutil', 'detach', mount], 30)

def check_storage(directory, app):
    """Preserve unidentified trees, but prevent retries from multiplying them."""
    known_backups, known_stages, failed_copies = set(), set(), set()
    for journal in directory.parent.glob('*/transaction.json'):
        config, state = read_json(journal), read_json(journal.parent / 'state.json')
        try:
            if not config or not state or state.get('stage') not in ('completed', 'rolled_back'):
                continue
            if trusted_paths(journal.parent, config) == app:
                backup, stage = Path(config['backup']), Path(config['stage'])
                expected = config.get('new_node') if state['stage'] == 'rolled_back' else config['old_node']
                if backup.exists() and node(backup) == expected:
                    known_backups.add(backup)
                    if state['stage'] == 'rolled_back':
                        failed_copies.add(backup)
                if state['stage'] == 'rolled_back' and stage.exists() and node(stage) == config.get('new_node'):
                    known_stages.add(stage)
                    failed_copies.add(stage)
        except (OSError, ValueError, KeyError):
            continue
    stages = [p for p in app.parent.glob('.steppe-update-*.app') if p not in known_stages]
    unknown = [p for p in app.parent.glob('.steppe-backup-*.app') if p not in known_backups]
    # Permit a retry after verified rollback. A later healthy install retires
    # that failed candidate; two consecutive failed candidates require review.
    if stages or unknown or len(failed_copies) > 1:
        raise ValueError('Предыдущая установка не завершена. Требуется восстановление или ручная проверка сохранённых файлов.')


def prepare(directory, pin):
    app = Path(os.environ['STEPPE_NATIVE_APP']).resolve()
    pid = int(os.environ['STEPPE_NATIVE_PID'])
    if app.suffix != '.app' or app_instances(app) != [pid] or not alive(pid, os.environ['STEPPE_NATIVE_IDENTITY']):
        raise ValueError('Закройте другую копию приложения.')
    if Path(sys.executable).resolve().is_relative_to(app):
        raise ValueError('Python helper должен находиться вне приложения.')
    lock = (app.parent / '.steppe-update.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if sha256(directory / 'ready.dmg') != pin['digest']:
            raise ValueError('Контрольная сумма DMG изменилась.')
        stage = app.parent / ('.steppe-update-' + directory.name + '.app')
        backup = app.parent / ('.steppe-backup-' + directory.name + '.app')
        if stage.exists() or backup.exists():
            raise ValueError('Незавершённая предыдущая установка.')
        if shutil.disk_usage(app.parent).free < pin['size'] * 4 + 512_000_000:
            raise ValueError('Недостаточно места для установки.')
        check_storage(directory, app)
        stage_image(directory, pin, stage)
        config = dict(helper_version=HELPER_VERSION, app=str(app), stage=str(stage), backup=str(backup),
                      version=pin['version'], old_version=plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleShortVersionString'],
                      old_node=node(app), new_node=node(stage), pid=pid, identity=identity(pid), backend_pid=os.getpid(),
                      backend_identity=identity(os.getpid()))
        sync_directory(app.parent)
        atomic_json(directory / 'transaction.json', config)
        # Copy just trusted helper modules, using the already extracted portable
        # interpreter. No file from the incoming disk image is executed here.
        for name in ('update_installer.py',):
            shutil.copy2(Path(__file__).with_name(name), directory / name)
        child = subprocess.Popen([sys.executable, str(directory / 'update_installer.py'), str(directory), str(lock.fileno())],
                                 pass_fds=(lock.fileno(),), start_new_session=True, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if (directory / 'helper-ready').exists():
                config.update(helper_pid=child.pid, helper_identity=identity(child.pid))
                atomic_json(directory / 'transaction.json', config)
                return
            if child.poll() is not None:
                break
            time.sleep(.05)
        raise ValueError('Helper не запустился.')
    finally:
        lock.close()


def prepare_recovery(directory):
    config = read_json(directory / 'transaction.json')
    if not config:
        raise ValueError('Missing recovery journal')
    app = trusted_paths(directory, config)
    if helper_active(directory, config):
        raise ValueError('Helper still active')
    previous = Path(config['backup'])
    if not previous.exists():
        previous = Path(config['stage'])
    if node(previous) != config['old_node'] or node(app) != config['new_node']:
        raise ValueError('Recovery identity mismatch')
    verify(previous, config['old_version'])
    pid = int(os.environ['STEPPE_NATIVE_PID'])
    if app_instances(app) != [pid] or not alive(pid, os.environ['STEPPE_NATIVE_IDENTITY']):
        raise ValueError('Another instance is active')
    lock = (app.parent / '.steppe-update.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Helper uses a dedicated recovery operation; failed live bundle is
        # exchanged only after both exact owned processes have exited normally.
        config.update(recover=True, recovery_source=str(previous), pid=pid,
                      identity=identity(pid), backend_pid=os.getpid(), backend_identity=identity(os.getpid()))
        atomic_json(directory / 'transaction.json', config)
        shutil.copy2(Path(__file__), directory / 'update_installer.py')
        (directory / 'helper-ready').unlink(missing_ok=True)
        child = subprocess.Popen([sys.executable, str(directory / 'update_installer.py'), str(directory), str(lock.fileno())],
                                 pass_fds=(lock.fileno(),), start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if (directory / 'helper-ready').exists():
                config.update(helper_pid=child.pid, helper_identity=identity(child.pid))
                atomic_json(directory / 'transaction.json', config)
                return
            if child.poll() is not None:
                break
            time.sleep(.05)
        raise ValueError('Recovery helper did not start')
    finally:
        lock.close()


def recover(config, directory):
    app, previous = Path(config['app']), Path(config['recovery_source'])
    state = read_json(directory / 'state.json') or {}
    try:
        deadline = time.monotonic() + 60
        while alive(config['pid'], config['identity']) or alive(config['backend_pid'], config['backend_identity']):
            if time.monotonic() >= deadline:
                raise TimeoutError('Owned processes did not exit')
            time.sleep(.1)
        trusted_paths(directory, config)
        if app_instances(app) or node(app) != config['new_node'] or node(previous) != config['old_node']:
            raise ValueError('Recovery identity changed')
        verify(previous, config['old_version'])
        exchange(app, previous)
        state.update(stage='rolled_back', error_code='rolled_back', retry=True, cancellable=False,
                     error='Предыдущая версия восстановлена.')
        atomic_json(directory / 'state.json', state)
        run(['/usr/bin/open', '-n', app], 15)
    except Exception:
        state.update(stage='recovery_required', error_code='recovery_failed', retry=True,
                     error='Восстановление не завершено. Закройте другие копии и повторите.')
        atomic_json(directory / 'state.json', state)


def transact(config, directory, *, is_alive=alive, instances=app_instances, verifier=verify,
             rename=os.rename, swap=exchange, launch=None, health=None, timeout=60, cut=lambda point: None):
    app, stage, backup = (Path(config[k]) for k in ('app', 'stage', 'backup'))
    state_path = directory / 'state.json'
    state = json.loads(state_path.read_text())
    def status(stage_name, error=None):
        state.update(stage=stage_name, cancellable=False, error=error,
                     error_code=stage_name if error else None, retry=bool(error))
        atomic_json(state_path, state)
    def start(path):
        run(['/usr/bin/open', '-n', '--env', 'STEPPE_UPDATE_RECEIPT=' + directory.name, path], 15)
    launch = launch or start
    def healthy():
        try:
            with urlopen('http://127.0.0.1:8008/api/v1/system/health', timeout=1) as response:
                value = json.loads(response.read(8192))
            return (value.get('service') == 'steppe-meeting' and value.get('runtime') == 'bundled'
                    and value.get('app_version') == config['version']
                    and value.get('backend_dir') == str(app / 'Contents/Resources/backend')
                    and value.get('update_receipt') == directory.name and bool(instances(app)))
        except Exception:
            return False
    health = health or healthy
    moved_old = moved_new = False
    try:
        deadline = time.monotonic() + timeout
        while (is_alive(config['pid'], config['identity']) or is_alive(config['backend_pid'], config['backend_identity'])):
            if time.monotonic() >= deadline:
                raise TimeoutError('Приложение не завершилось; установка отменена.')
            time.sleep(.1)
        if instances(app):
            raise ValueError('Другая копия приложения ещё работает.')
        verifier(stage, config['version'])
        status('replacing')
        cut('before_exchange')
        swap(app, stage)
        moved_old = moved_new = True
        cut('after_exchange')
        status('backup_created')
        cut('before_backup_rename')
        rename(stage, backup)  # Installed path is untouched; old lives at stage until this succeeds.
        sync_directory(app.parent)
        cut('after_backup_rename')
        verifier(app, config['version'])
        status('restarting')
        cut('before_launch')
        # Receipt binds health to this transaction and is passed only to the new
        # application process, never via a mutable HTTP request.
        os.environ['STEPPE_UPDATE_RECEIPT'] = directory.name
        launch(app)
        deadline = time.monotonic() + timeout
        while not health():
            if time.monotonic() >= deadline:
                raise TimeoutError('Новая версия не подтвердила готовность.')
            time.sleep(.2)
        cut('before_completed')
        status('completed')  # Backup intentionally retained for recovery.
        cut('after_completed')
        if os.environ.get('STEPPE_NATIVE_APP') == str(app):
            try:
                retain_previous(directory, config)
            except (OSError, ValueError, KeyError):
                pass  # Never roll back healthy software because cleanup failed.
    except Exception:
        if moved_old and not instances(app):
            try:
                previous = backup if backup.exists() else stage
                swap(app, previous)
                launch(app)
                status('rolled_back', 'Обновление не запустилось. Предыдущая версия восстановлена.')
            except Exception:
                status('recovery_required', 'Требуется восстановление из резервной копии приложения.')
        else:
            status('recovery_required' if moved_old else 'error', 'Установка не завершена. Предыдущая версия сохранена.')


if __name__ == '__main__':
    directory = Path(sys.argv[1])
    lock_fd = int(sys.argv[2])  # Keep cross-instance lock alive through transaction.
    config = json.loads((directory / 'transaction.json').read_text())
    if config['helper_version'] != HELPER_VERSION:
        raise SystemExit(2)
    (directory / 'helper-ready').touch(mode=0o600)
    # Wait for backend to atomically publish native handoff before writing state.
    deadline = time.monotonic() + 15
    while json.loads((directory / 'state.json').read_text())['stage'] != 'awaiting_exit':
        if time.monotonic() > deadline:
            raise SystemExit(3)
        time.sleep(.05)
    if config.get('recover'):
        recover(config, directory)
    else:
        transact(config, directory)
