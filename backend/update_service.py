"""Pinned release downloads. HTTP never receives a path or installation capability."""
from __future__ import annotations
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import time
from urllib.parse import urlsplit
import httpx
from release_updates import compatible_asset, parse_version, REPOSITORY

MAX_SIZE = 2_000_000_000
HOSTS = {'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
TERMINAL = {'cancelled', 'error', 'completed', 'rolled_back', 'recovery_required'}


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    from update_installer import sync_directory
    sync_directory(path.parent)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


class UpdateService:
    def __init__(self, root, checker, current_version, channel, busy, *, transport=None):
        self.root = Path(root)
        self.checker, self.current_version, self.channel, self.busy = checker, current_version, channel, busy
        self.transport = transport
        self.selections = {}
        self.job = None
        self.task = None
        self.installing = False
        self.lock = asyncio.Lock()

    def directory(self, job=None):
        return self.root / (job or self.job)['job_id']

    def persist(self):
        atomic_json(self.directory() / 'state.json', self.job)

    def state(self):
        if not self.job:
            # Restart discards owned uninstalled payloads; never auto-installs.
            if self.root.exists():
                states = sorted(self.root.glob('*/state.json'), key=lambda p: p.stat().st_mtime, reverse=True)
                latest = None
                for path in states:
                    if path.parent.is_symlink() or not re.fullmatch(r'[0-9a-f]{32}', path.parent.name):
                        continue
                    from update_installer import read_json, classify
                    value = read_json(path)
                    if not value or not isinstance(value.get('stage'), str):
                        continue
                    value['job_id'] = path.parent.name
                    if value['stage'] in ('downloading', 'ready', 'deferred'):
                        for name in ('download.part', 'ready.dmg'):
                            (path.parent / name).unlink(missing_ok=True)
                        value.update(stage='idle', cancellable=False, autoEligible=False)
                        atomic_json(path, value)
                    elif value['stage'] not in TERMINAL or value['stage'] == 'recovery_required':
                        value = classify(path.parent, value, current_version=self.current_version)
                    if latest is None:
                        latest = value
                if latest is not None:
                    return latest
            return {'stage': 'idle', 'cancellable': False}
        busy = self.busy()
        if busy and self.job['stage'] in ('downloading', 'ready', 'deferred'):
            self.activity()
        result = {**self.job, 'busy': busy}

        # Helper owns subsequent transaction status after native handoff.
        if result['stage'] == 'awaiting_exit':
            from update_installer import read_json
            result = read_json(self.directory() / 'state.json') or dict(result, stage='error', retry=True, error_code='journal_invalid')
        return result

    def activity(self):
        if self.job and self.job['stage'] in ('downloading', 'ready', 'deferred') and self.job.get('autoEligible'):
            self.job['autoEligible'] = False
            self.persist()

    async def select(self, result):
        if result.get('status') != 'available' or result.get('platform', 'darwin') not in ('darwin', 'macos'):
            return result
        snapshot = self.checker._snapshot or {}
        releases = snapshot.get('releases', [])
        release = next((r for r in releases if r.get('tag_name') == result.get('tag_name')), None)
        if not release:
            return result
        selected = compatible_asset(release.get('assets', []), 'darwin', 'aarch64')
        asset = next((a for a in release.get('assets', []) if a.get('browser_download_url') == selected.get('download_url')), {})
        digest = asset.get('digest') or ''
        if not (selected.get('asset_name', '').endswith('.dmg') and re.fullmatch(r'sha256:[0-9a-f]{64}', digest)
                and type(asset.get('id')) is int and type(release.get('id')) is int
                and type(asset.get('size')) is int and 0 < asset['size'] <= MAX_SIZE):
            return {**result, 'installable': False, 'install_error': 'Релиз не содержит проверяемый DMG с SHA256 GitHub.'}
        token = secrets.token_hex(16)
        pin = dict(version=result['latest_version'], channel=result['channel'], platform='darwin', arch='aarch64',
                   release_id=release['id'], asset_id=asset['id'], size=asset['size'], digest=digest[7:],
                   url=selected['download_url'], expires=time.monotonic() + 900)
        self.selections = {k: v for k, v in self.selections.items() if v['expires'] > time.monotonic()}
        if len(self.selections) >= 64:
            self.selections.pop(next(iter(self.selections)))
        self.selections[token] = pin
        return {**result, 'selection_id': token, 'installable': True}

    async def begin(self, selection_id):
        async with self.lock:
            pin = self.selections.get(selection_id)
            if not pin or pin['expires'] < time.monotonic() or pin['channel'] != self.channel():
                raise ValueError('Выбор обновления устарел. Проверьте обновления снова.')
            if parse_version(pin['version']) <= parse_version(self.current_version):
                raise ValueError('Эта версия уже установлена или старше текущей.')
            if self.job and self.job['stage'] not in TERMINAL:
                if self.job['selection_id'] == selection_id:
                    return self.state()
                raise ValueError('Другое обновление уже выполняется.')
            native_app = os.environ.get('STEPPE_NATIVE_APP')
            if native_app:
                from update_installer import check_storage
                check_storage(self.root / 'pending', Path(native_app).resolve())
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(self.root, 0o700)
            job_id = secrets.token_hex(16)
            directory = self.root / job_id
            directory.mkdir(mode=0o700)
            atomic_json(directory / 'pin.json', pin)
            self.job = dict(job_id=job_id, selection_id=selection_id, version=pin['version'], channel=pin['channel'],
                            stage='downloading', bytes=0, total_bytes=pin['size'], percent=0, megabytes=0,
                            cancellable=True, error=None, error_code=None, retry=False, busy=[], autoEligible=not bool(self.busy()))
            self.persist()
            self.task = asyncio.create_task(self.download(pin))
            return self.state()

    async def download(self, pin):
        directory = self.directory()
        part = directory / 'download.part'
        try:
            if shutil.disk_usage(directory).free < pin['size'] * 4 + 512_000_000:
                raise ValueError('Недостаточно места для загрузки и резервной копии.')
            async with asyncio.timeout(900):
                async with httpx.AsyncClient(transport=self.transport, trust_env=False, follow_redirects=False,
                                             timeout=httpx.Timeout(30), headers={'User-Agent': 'Steppe-Meeting-updater', 'Accept-Encoding': 'identity'}) as client:
                    url = pin['url']
                    for redirect in range(6):
                        parsed = urlsplit(url)
                        if parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.port not in (None, 443) or parsed.username or parsed.password:
                            raise ValueError('GitHub перенаправил загрузку на недопустимый адрес.')
                        async with client.stream('GET', url) as response:
                            if response.is_redirect:
                                url = str(response.url.join(response.headers['location']))
                                continue
                            response.raise_for_status()
                            if response.status_code != 200:
                                raise ValueError('Неполный ответ загрузки.')
                            digest, count = hashlib.sha256(), 0
                            with part.open('xb') as stream:
                                async for chunk in response.aiter_bytes(256 * 1024):
                                    count += len(chunk)
                                    if count > pin['size']:
                                        raise ValueError('Размер DMG превышает размер релиза.')
                                    stream.write(chunk)
                                    digest.update(chunk)
                                    self.job.update(bytes=count, megabytes=round(count / 1_000_000, 2), percent=round(100 * count / pin['size'], 1))
                                    self.persist()
                                stream.flush()
                                os.fsync(stream.fileno())
                            if count != pin['size'] or digest.hexdigest() != pin['digest']:
                                raise ValueError('Размер или SHA256 DMG не совпадает с релизом.')
                            os.replace(part, directory / 'ready.dmg')
                            self.job.update(stage='ready', cancellable=True, retry=False)
                            self.persist()
                            return
                    raise ValueError('Слишком много перенаправлений GitHub.')
        except asyncio.CancelledError:
            self.job.update(stage='cancelled', cancellable=False)
        except Exception:
            self.job.update(stage='error', error_code='download_failed', error='Не удалось проверить и загрузить DMG. Проверьте сеть и свободное место.', retry=True, cancellable=False)
        finally:
            part.unlink(missing_ok=True)
            self.persist()

    async def cancel(self, job_id):
        async with self.lock:
            self.require(job_id)
            if not self.job['cancellable'] or self.installing:
                raise ValueError('Установка уже началась; отмена недоступна.')
            if self.task and not self.task.done():
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
            (self.directory() / 'ready.dmg').unlink(missing_ok=True)
            self.job.update(stage='cancelled', cancellable=False)
            self.persist()
            return self.state()

    def require(self, job_id):
        if not self.job or self.job['job_id'] != job_id:
            raise ValueError('Обновление не найдено. Проверьте обновления снова.')

    async def install(self, job_id):
        async with self.lock:
            if self.job is None:
                previous = self.state()
                if previous.get('job_id') == job_id and previous.get('stage') == 'recovery_required':
                    self.job = previous
            self.require(job_id)
            if self.job['stage'] == 'recovery_required' and not self.installing:
                self.installing = True
                try:
                    from update_installer import prepare_recovery
                    await asyncio.to_thread(prepare_recovery, self.directory())
                    self.job.update(stage='awaiting_exit', cancellable=False, error=None, error_code=None)
                except Exception:
                    self.installing = False
                    self.job.update(error_code='recovery_failed', retry=True)
                self.persist()
                return self.state()
            if self.installing or self.job['stage'] not in ('ready', 'deferred'):
                raise ValueError('Обновление ещё не готово или уже устанавливается.')
            pin = json.loads((self.directory() / 'pin.json').read_text())
            if pin['channel'] != self.channel() or parse_version(pin['version']) <= parse_version(self.current_version):
                raise ValueError('Выбор обновления устарел.')
            busy = self.busy()
            if busy:
                self.job.update(stage='deferred', busy=busy, error='Завершите запись и текущую обработку, затем нажмите «Установить» снова.')
                self.persist()
                return self.state()
            self.installing = True
            self.job.update(stage='preparing', cancellable=False, busy=[], error=None)
            self.persist()
            try:
                from update_installer import prepare
                await asyncio.to_thread(prepare, self.directory(), pin)
                self.job.update(stage='awaiting_exit')
                self.persist()
                return self.state()
            except Exception:
                self.installing = False
                self.job.update(stage='error', error_code='prepare_failed', error='Не удалось подготовить установку. Проверьте права доступа и целостность приложения.', retry=True)
                self.persist()
                return self.state()
