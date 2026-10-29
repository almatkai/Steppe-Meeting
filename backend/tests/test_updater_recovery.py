"""No installed product, user database, network, or application port is used."""
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from update_installer import atomic_json, classify, helper_active, identity, node, retain_previous
from update_service import UpdateService

class RestartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='steppe-recovery-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.directory = self.root / ('a'*32)
        self.directory.mkdir()
        self.service = UpdateService(self.root, None, '0.3.0', lambda:'stable', lambda:[])

    def test_abandoned_download_and_ready_cleaned_without_recovery_claim(self):
        for stage in ('downloading','ready','deferred'):
            atomic_json(self.directory/'state.json', {'stage':stage,'job_id':self.directory.name})
            for name in ('download.part','ready.dmg'): (self.directory/name).write_bytes(b'owned')
            self.assertEqual(self.service.state()['stage'], 'idle')
            self.assertFalse((self.directory/'ready.dmg').exists())
            self.assertFalse((self.directory/'download.part').exists())
        atomic_json(self.directory/'state.json', {'stage':'cancelled'})
        self.assertEqual(self.service.state()['stage'], 'cancelled')

    def test_corrupt_or_missing_journal_never_breaks_poll(self):
        (self.directory/'state.json').write_text('{')
        self.assertEqual(self.service.state()['stage'], 'idle')
        atomic_json(self.directory/'state.json', {'stage':'restarting'})
        self.assertEqual(self.service.state()['error_code'], 'journal_invalid')
        self.assertTrue(self.service.state()['retry'])

    def test_live_pid_without_lock_is_stale_and_wrong_identity_not_helper(self):
        (self.root/'.steppe-update.lock').touch()
        config = dict(app=str(self.root/'TEMP.app'), helper_pid=os.getpid(), helper_identity=identity(os.getpid()))
        self.assertFalse(helper_active(self.directory, config))
        with (self.root/'.steppe-update.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertTrue(helper_active(self.directory, config))
            config['helper_identity'] = 'wrong process start'
            self.assertFalse(helper_active(self.directory, config))

    def test_active_helper_keeps_authentic_pending_health_stage(self):
        (self.root/'.steppe-update.lock').touch()
        config = dict(app=str(self.root/'TEMP.app'), helper_pid=os.getpid(), helper_identity=identity(os.getpid()))
        atomic_json(self.directory/'transaction.json', config)
        with (self.root/'.steppe-update.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(classify(self.directory, {'stage':'restarting'})['stage'], 'restarting')

    def test_later_health_retains_current_previous_and_retires_older_backup(self):
        app = self.root/'TEMP.app'; app.mkdir()
        current = dict(app=str(app), stage=str(self.root/('.steppe-update-'+self.directory.name+'.app')),
                       backup=str(self.root/('.steppe-backup-'+self.directory.name+'.app')))
        Path(current['backup']).mkdir()
        prior_dir = self.root/('b'*32); prior_dir.mkdir()
        previous = dict(app=str(app), stage=str(self.root/('.steppe-update-'+prior_dir.name+'.app')),
                        backup=str(self.root/('.steppe-backup-'+prior_dir.name+'.app')))
        old = Path(previous['backup']); old.mkdir(); previous['old_node'] = node(old)
        atomic_json(prior_dir/'transaction.json', previous)
        atomic_json(prior_dir/'state.json', {'stage':'completed'})
        with patch.dict(os.environ, STEPPE_NATIVE_APP=str(app)):
            retain_previous(self.directory, current)
        self.assertTrue(Path(current['backup']).exists())
        self.assertFalse(old.exists())

class RecoveryActionTests(unittest.TestCase):
    def test_explicit_recovery_exchanges_only_after_owned_processes_exit(self):
        import update_installer as installer
        for live in (False, True):
            with self.subTest(live=live), tempfile.TemporaryDirectory(prefix='steppe-rollback-test-') as temporary:
                root = Path(temporary).resolve(); directory = root/('c'*32); directory.mkdir()
                app = root/'TEMP.app'; app.mkdir(); (app/'version').write_text('new')
                backup = root/('.steppe-backup-'+directory.name+'.app'); backup.mkdir(); (backup/'version').write_text('old')
                config = dict(app=str(app), stage=str(root/('.steppe-update-'+directory.name+'.app')),
                    backup=str(backup), recovery_source=str(backup), new_node=node(app), old_node=node(backup),
                    old_version='0.2.0', pid=1, identity='native', backend_pid=2, backend_identity='backend')
                atomic_json(directory/'state.json', {'stage':'awaiting_exit'})
                with patch.dict(os.environ, STEPPE_NATIVE_APP=str(app)), patch.object(installer,'alive',return_value=False), \
                     patch.object(installer,'app_instances',return_value=[777] if live else []), \
                     patch.object(installer,'verify') as verify, patch.object(installer,'run') as launch:
                    installer.recover(config,directory)
                receipt = json.loads((directory/'state.json').read_text())
                self.assertEqual(receipt['stage'], 'recovery_required' if live else 'rolled_back')
                self.assertEqual((app/'version').read_text(), 'new' if live else 'old')
                self.assertEqual(launch.call_count, 0 if live else 1)

    def test_completed_requires_matching_native_receipt_and_verified_own_bundle(self):
        import update_installer as installer
        with tempfile.TemporaryDirectory(prefix='steppe-health-test-') as temporary:
            root = Path(temporary).resolve(); directory=root/('d'*32); directory.mkdir()
            app=root/'TEMP.app'; (app/'Contents/Resources/backend').mkdir(parents=True)
            old=root/('.steppe-update-'+directory.name+'.app'); old.mkdir()
            backup=root/('.steppe-backup-'+directory.name+'.app')
            config=dict(app=str(app),stage=str(old),backup=str(backup),new_node=node(app),old_node=node(old),version='0.3.0')
            atomic_json(directory/'transaction.json',config)
            env=dict(STEPPE_NATIVE_APP=str(app),STEPPE_NATIVE_PID='123',STEPPE_NATIVE_IDENTITY='owned',
                     STEPPE_UPDATE_RECEIPT='wrong',STEPPE_BUNDLED_RUNTIME='1')
            with patch.dict(os.environ,env), patch.object(installer,'__file__',str(app/'Contents/Resources/backend/update_installer.py')), \
                 patch.object(installer,'alive',return_value=True), patch.object(installer,'verify') as verify:
                self.assertEqual(classify(directory,{'stage':'restarting'},current_version='0.3.0')['stage'],'recovery_required')
                verify.assert_not_called()
                with patch.dict(os.environ,STEPPE_UPDATE_RECEIPT=directory.name):
                    self.assertEqual(classify(directory,{'stage':'restarting'},current_version='0.3.0')['stage'],'completed')
                verify.assert_called_once_with(app,'0.3.0')
            self.assertTrue(backup.exists())
            self.assertFalse(old.exists())


class BoundedStorageTests(unittest.TestCase):
    def test_unverifiable_stage_blocks_retries_without_deletion(self):
        from update_installer import check_storage
        with tempfile.TemporaryDirectory(prefix='steppe-storage-test-') as temporary:
            root = Path(temporary).resolve()
            app = root/'TEMP.app'; app.mkdir()
            jobs = root/'jobs'; jobs.mkdir()
            directory = jobs/('a'*32); directory.mkdir()
            unknown = root/('.steppe-update-'+('b'*32)+'.app'); unknown.mkdir()
            (unknown/'preserve').write_text('unknown owner')
            for _ in range(3):
                with self.assertRaises(ValueError):
                    check_storage(directory, app)
            self.assertEqual((unknown/'preserve').read_text(), 'unknown owner')
            self.assertEqual(len(list(root.glob('.steppe-update-*.app'))), 1)

    def test_only_validated_completed_backup_allows_next_stage(self):
        from update_installer import check_storage
        with tempfile.TemporaryDirectory(prefix='steppe-storage-test-') as temporary:
            root = Path(temporary).resolve(); app = root/'TEMP.app'; app.mkdir()
            jobs=root/'jobs'; jobs.mkdir(); prior=jobs/('b'*32); prior.mkdir()
            backup=root/('.steppe-backup-'+prior.name+'.app'); backup.mkdir()
            config=dict(app=str(app),backup=str(backup),stage=str(root/('.steppe-update-'+prior.name+'.app')),old_node=node(backup))
            atomic_json(prior/'transaction.json',config)
            atomic_json(prior/'state.json',{'stage':'completed'})
            with patch.dict(os.environ, STEPPE_NATIVE_APP=str(app)):
                check_storage(jobs/('a'*32),app)
                atomic_json(prior/'state.json',{'stage':'recovery_required'})
                with self.assertRaises(ValueError): check_storage(jobs/('a'*32),app)
            self.assertTrue(backup.exists())

    def test_verified_rollback_allows_one_retry_and_later_health_cleans_failed_copy(self):
        from update_installer import check_storage
        with tempfile.TemporaryDirectory(prefix='steppe-storage-test-') as temporary:
            root=Path(temporary).resolve(); app=root/'TEMP.app'; app.mkdir()
            jobs=root/'jobs'; jobs.mkdir(); previous=jobs/('b'*32); previous.mkdir()
            backup=root/('.steppe-backup-'+previous.name+'.app'); backup.mkdir()
            prior=dict(app=str(app), backup=str(backup), stage=str(root/('.steppe-update-'+previous.name+'.app')),
                       old_node=node(app), new_node=node(backup))
            atomic_json(previous/'transaction.json',prior)
            atomic_json(previous/'state.json',{'stage':'rolled_back'})
            current=jobs/('a'*32); current.mkdir()
            config=dict(app=str(app),backup=str(root/('.steppe-backup-'+current.name+'.app')),
                        stage=str(root/('.steppe-update-'+current.name+'.app')))
            with patch.dict(os.environ, STEPPE_NATIVE_APP=str(app)):
                check_storage(current,app)
                retain_previous(current,config)
            self.assertFalse(backup.exists())

if __name__ == '__main__': unittest.main()
