"""Updater exercises use only temporary downloads, bundles and owned processes."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from update_service import UpdateService, atomic_json
from update_installer import transact, alive, identity, verify, HELPER_VERSION
from release_updates import ReleaseChecker

PAYLOAD = b'dmg-content' * 100
URL = 'https://github.com/almatkai/Steppe-Meeting/releases/download/v0.3.0/Steppe_0.3.0_aarch64.dmg'

class Chunks(httpx.AsyncByteStream):
    def __init__(self, payload): self.payload = payload
    async def __aiter__(self):
        for start in range(0, len(self.payload), 19):
            await asyncio.sleep(0)
            yield self.payload[start:start+19]


class DownloadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='steppe-updater-test-')
        self.addCleanup(self.tmp.cleanup)
        self.channel = 'stable'
        self.busy = []
        self.payload = PAYLOAD
        self.requests = []
        def handler(req):
            self.requests.append(req)
            return httpx.Response(200, stream=Chunks(self.payload))
        self.checker = ReleaseChecker()
        self.asset = dict(id=52, size=len(PAYLOAD), state='uploaded', name='Steppe_0.3.0_aarch64.dmg',
                          browser_download_url=URL, digest='sha256:' + hashlib.sha256(PAYLOAD).hexdigest())
        self.checker._snapshot = {'releases': [dict(id=31, tag_name='v0.3.0', assets=[self.asset])]}
        self.service = UpdateService(Path(self.tmp.name), self.checker, '0.2.0', lambda: self.channel,
                                     lambda: self.busy, transport=httpx.MockTransport(handler))
        self.result = dict(status='available', latest_version='0.3.0', tag_name='v0.3.0', channel='stable')

    async def begin(self):
        selected = await self.service.select(self.result)
        state = await self.service.begin(selected['selection_id'])
        await self.service.task
        return state

    async def test_unidentified_staging_blocks_retry_before_another_download(self):
        app = Path(self.tmp.name)/'TEMP.app'; app.mkdir()
        orphan = app.parent/('.steppe-update-'+('c'*32)+'.app'); orphan.mkdir()
        selected = await self.service.select(self.result)
        with patch.dict(os.environ, STEPPE_NATIVE_APP=str(app)):
            for _ in range(3):
                with self.assertRaises(ValueError):
                    await self.service.begin(selected['selection_id'])
        self.assertIsNone(self.service.task)
        self.assertEqual(self.requests, [])
        self.assertTrue(orphan.exists())
        self.assertFalse(list(Path(self.tmp.name).glob('*/ready.dmg')))

    async def test_chunked_verified_atomic_ready_and_persisted_progress(self):
        await self.begin()
        state = self.service.state()
        self.assertEqual(state['stage'], 'ready')
        self.assertEqual((state['bytes'], state['percent']), (len(PAYLOAD), 100))
        self.assertEqual((self.service.directory()/'ready.dmg').read_bytes(), PAYLOAD)
        self.assertFalse((self.service.directory()/'download.part').exists())
        self.assertEqual(self.service.directory().stat().st_mode & 0o777, 0o700)
        self.assertNotIn('authorization', self.requests[0].headers)

    async def test_truncated_corrupt_oversize_fail_closed(self):
        for payload in (PAYLOAD[:-1], b'x' * len(PAYLOAD), PAYLOAD + b'x'):
            self.payload = payload
            await self.begin()
            self.assertEqual(self.service.state()['stage'], 'error')
            self.assertFalse((self.service.directory()/'ready.dmg').exists())
            self.assertFalse((self.service.directory()/'download.part').exists())

    async def test_digest_missing_and_wrong_repo_not_installable(self):
        for key, value in [('digest', None), ('browser_download_url', URL.replace('almatkai', 'evil'))]:
            with patch.dict(self.asset, {key: value}):
                result = await self.service.select(self.result)
                self.assertFalse(result['installable'])

    async def test_channel_expiry_and_downgrade_rejected(self):
        selected = await self.service.select(self.result)
        token = selected['selection_id']
        self.channel = 'beta'
        with self.assertRaises(ValueError): await self.service.begin(token)
        self.channel = 'stable'
        self.service.current_version = '0.3.0'
        with self.assertRaises(ValueError): await self.service.begin(token)
        self.service.current_version = '0.4.0'
        with self.assertRaises(ValueError): await self.service.begin(token)
        self.service.current_version = '0.2.0'
        self.service.selections[token]['expires'] = 0
        with self.assertRaises(ValueError): await self.service.begin(token)

    async def test_download_dedupe_and_cancel_cleanup(self):
        selected = await self.service.select(self.result)
        first, second = await asyncio.gather(*(self.service.begin(selected['selection_id']) for _ in range(2)))
        self.assertEqual(first['job_id'], second['job_id'])
        await self.service.cancel(first['job_id'])
        self.assertEqual(self.service.state()['stage'], 'cancelled')
        self.assertFalse((self.service.directory()/'ready.dmg').exists())

    async def test_busy_never_prepares_and_requires_explicit_retry(self):
        await self.begin()
        for reason in ('recording', 'generation', 'processing', 'request'):
            self.busy = [reason]
            with patch('update_installer.prepare') as prepare:
                result = await self.service.install(self.service.job['job_id'])
                self.assertEqual(result['stage'], 'deferred')
                prepare.assert_not_called()
        self.assertFalse(self.service.installing)

    async def test_install_dedup_and_not_cancellable(self):
        await self.begin()
        with patch('update_installer.prepare'):
            result = await self.service.install(self.service.job['job_id'])
        self.assertEqual(result['stage'], 'awaiting_exit')
        with self.assertRaises(ValueError): await self.service.install(self.service.job['job_id'])
        with self.assertRaises(ValueError): await self.service.cancel(self.service.job['job_id'])

    async def test_redirect_allowlist_no_request_to_arbitrary_host(self):
        requests = []
        def handler(req):
            requests.append(req)
            return httpx.Response(302, headers={'location':'https://evil.example/file'})
        self.service.transport = httpx.MockTransport(handler)
        await self.begin()
        self.assertEqual(len(requests), 1)
        self.assertEqual(self.service.state()['stage'], 'error')

    async def test_disk_space_fails_before_download(self):
        with patch('update_service.shutil.disk_usage', return_value=type('Usage', (), {'free':0})()):
            await self.begin()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.service.state()['stage'], 'error')


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='steppe-transaction-test-')
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.app = self.directory/'TEMP.app'
        self.stage = self.directory/'STAGE.app'
        self.backup = self.directory/'BACKUP.app'
        for bundle, version in [(self.app, 'old'), (self.stage, 'new')]:
            (bundle/'Contents').mkdir(parents=True)
            (bundle/'Contents/version').write_text(version)
        atomic_json(self.directory/'state.json', {'stage':'awaiting_exit'})
        self.config = dict(app=str(self.app), stage=str(self.stage), backup=str(self.backup), version='new',
                           pid=123, identity='owned', backend_pid=124, backend_identity='backend', helper_version=HELPER_VERSION)
        self.launches = []

    def execute(self, **kwargs):
        defaults = dict(is_alive=lambda *a:False, instances=lambda p:[],
                        verifier=lambda p,v:self.assertEqual((p/'Contents/version').read_text(), v),
                        launch=lambda p:self.launches.append(p), health=lambda:True, timeout=0)
        defaults.update(kwargs)
        transact(self.config, self.directory, **defaults)
        return json.loads((self.directory/'state.json').read_text())['stage']

    def test_actual_rename_success_retains_backup(self):
        self.assertEqual(self.execute(), 'completed')
        self.assertEqual((self.app/'Contents/version').read_text(), 'new')
        self.assertEqual((self.backup/'Contents/version').read_text(), 'old')
        self.assertEqual(self.launches, [self.app])

    def test_exchange_failure_preserves_old_bundle(self):
        def fail(*args): raise OSError('unsupported filesystem')
        self.assertEqual(self.execute(swap=fail), 'error')
        self.assertEqual((self.app/'Contents/version').read_text(), 'old')

    def test_backup_rename_failure_atomically_restores_old(self):
        def fail(*args): raise PermissionError('isolated failure')
        self.assertEqual(self.execute(rename=fail), 'rolled_back')
        self.assertEqual((self.app/'Contents/version').read_text(), 'old')

    def test_every_crash_cut_keeps_installed_path_and_previous_bundle(self):
        class PowerLoss(BaseException): pass
        for point in ('before_exchange', 'after_exchange', 'before_backup_rename',
                      'after_backup_rename', 'before_launch', 'before_completed', 'after_completed'):
            with self.subTest(point=point):
                # Restore fixtures between independently injected power cuts.
                import shutil
                for bundle in (self.app, self.stage, self.backup):
                    if bundle.exists(): shutil.rmtree(bundle)
                for bundle, version in ((self.app, 'old'), (self.stage, 'new')):
                    (bundle/'Contents').mkdir(parents=True)
                    (bundle/'Contents/version').write_text(version)
                def cut(name):
                    if name == point: raise PowerLoss()
                with self.assertRaises(PowerLoss): self.execute(cut=cut)
                self.assertTrue(self.app.is_dir())
                self.assertIn('old', [(p/'Contents/version').read_text() for p in
                                     (self.app, self.stage, self.backup) if p.exists()])

    def test_relaunch_failure_rolls_back(self):
        calls = []
        def launch(path):
            calls.append(path)
            if len(calls) == 1: raise OSError('launch failed')
        self.assertEqual(self.execute(launch=launch), 'rolled_back')
        self.assertEqual((self.app/'Contents/version').read_text(), 'old')

    def test_unhealthy_running_new_instance_keeps_backup_without_overwriting(self):
        self.assertEqual(self.execute(health=lambda:False, instances=lambda p:[123] if self.backup.exists() else []), 'recovery_required')
        self.assertTrue(self.backup.exists())
        self.assertEqual((self.app/'Contents/version').read_text(), 'new')

    def test_failed_health_with_exited_new_app_rolls_back(self):
        self.assertEqual(self.execute(health=lambda:False), 'rolled_back')
        self.assertEqual((self.app/'Contents/version').read_text(), 'old')

    def test_corrupted_staged_bundle_never_moves_original(self):
        (self.stage/'Contents/version').write_text('corrupt')
        self.assertEqual(self.execute(), 'error')
        self.assertFalse(self.backup.exists())

    def test_exact_owned_real_process_wait_timeout_never_moves(self):
        # Wait for Python's launcher/exec handoff before pinning its identity.
        process = subprocess.Popen([sys.executable, '-c', 'import time; print("ready", flush=True); time.sleep(10)'], stdout=subprocess.PIPE, text=True)
        self.assertEqual(process.stdout.readline().strip(), 'ready')
        process.stdout.close()
        self.addCleanup(lambda: (process.terminate(), process.wait()))
        self.config.update(pid=process.pid, identity=identity(process.pid))
        self.assertTrue(alive(process.pid, self.config['identity']))
        self.assertFalse(alive(process.pid, 'different executable/start'))
        self.assertEqual(self.execute(is_alive=alive), 'error')
        self.assertFalse(self.backup.exists())

    def test_owned_process_exits_then_real_bundle_transaction_runs(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time; print("ready", flush=True); time.sleep(.15)'], stdout=subprocess.PIPE, text=True)
        self.assertEqual(process.stdout.readline().strip(), 'ready')
        process.stdout.close()
        self.config.update(pid=process.pid, identity=identity(process.pid))
        try:
            self.assertEqual(self.execute(is_alive=alive, timeout=2), 'completed')
        finally:
            process.wait(timeout=2)
        self.assertTrue(self.backup.exists())

    def test_duplicate_app_instance_never_moves_original(self):
        self.assertEqual(self.execute(instances=lambda p:[777]), 'error')
        self.assertFalse(self.backup.exists())

    def test_post_move_verification_failure_restores_old(self):
        def verifier(path, version):
            if path == self.app:
                raise ValueError('damaged after copy')
        self.assertEqual(self.execute(verifier=verifier), 'rolled_back')
        self.assertEqual((self.app/'Contents/version').read_text(), 'old')

    def test_external_helper_interpreter_survives_transaction(self):
        import update_installer
        helper = self.directory/'update_installer.py'
        helper.write_bytes(Path(update_installer.__file__).read_bytes())
        code = """import json, pathlib, sys
from update_installer import transact
root = pathlib.Path(sys.argv[1])
config = json.loads((root/'transaction.json').read_text())
transact(config, root, is_alive=lambda *args:False, instances=lambda path:[],
         verifier=lambda *args:None, launch=lambda path:None, health=lambda:True)
"""
        atomic_json(self.directory/'transaction.json', self.config)
        runner = self.directory/'runner.py'
        runner.write_text(code)
        result = subprocess.run([sys.executable, str(runner), str(self.directory)], cwd='/',
                                timeout=5, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.directory/'state.json').read_text())['stage'], 'completed')
        self.assertEqual((self.backup/'Contents/version').read_text(), 'old')

    def test_wrong_bundle_identity_rejected_before_native_tools(self):
        import plistlib
        (self.stage/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'evil'}))
        with self.assertRaises(ValueError), patch('update_installer.run') as run:
            verify(self.stage, 'new')
        run.assert_not_called()



class PackagingTests(unittest.TestCase):
    def test_updater_modules_are_packaged_and_audited_by_existing_globs(self):
        import runpy
        root = Path(__file__).resolve().parents[2]
        config = json.loads((root/'src-tauri/tauri.conf.json').read_text())
        self.assertEqual(config['bundle']['resources']['../backend/*.py'], 'backend/')
        inputs = runpy.run_path(str(root/'scripts/build-beta.py'))['inputs']()
        for name in ('backend/update_installer.py', 'backend/update_service.py', 'src-tauri/src/updater.rs'):
            self.assertIn(name, inputs)


class PrepareTests(unittest.TestCase):
    def test_corrupt_dmg_and_unwritable_parent_leave_original_intact(self):
        import update_installer
        with tempfile.TemporaryDirectory(prefix='steppe-prepare-test-') as temporary:
            root = Path(temporary)
            app = root/'TEMP.app'
            app.mkdir()
            job = root/'job'
            job.mkdir()
            (job/'ready.dmg').write_bytes(b'corrupted')
            env = dict(STEPPE_NATIVE_APP=str(app), STEPPE_NATIVE_PID='321', STEPPE_NATIVE_IDENTITY='owned')
            with patch.dict(os.environ, env), patch.object(update_installer, 'app_instances', return_value=[321]), patch.object(update_installer, 'alive', return_value=True):
                with self.assertRaises(ValueError):
                    update_installer.prepare(job, {'digest':'0'*64})
                self.assertTrue(app.exists())
                with patch.object(Path, 'open', side_effect=PermissionError('isolated read-only parent')):
                    with self.assertRaises(PermissionError):
                        update_installer.prepare(job, {'digest':'0'*64})
                self.assertTrue(app.exists())

if __name__ == '__main__': unittest.main()
