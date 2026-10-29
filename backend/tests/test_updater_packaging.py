"""Shipping guard regressions; TEMP bytes only, no packaged app execution."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updater_build_beta', Path(__file__).resolve().parents[2]/'scripts/build-beta.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class ShippingGuardTests(unittest.TestCase):
    def test_fixture_compile_environment_and_flags_are_rejected(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(sys, 'argv', ['build-beta.py']):
            build.reject_fixture_environment()
            for name in ('STEPPE_FIXTURE_ROOT', 'STEPPE_FIXTURE_PORT', 'STEPPE_FIXTURE_VERSION',
                         'CARGO_FEATURE_PACKAGED_UPDATER_FIXTURE'):
                with self.subTest(name=name), patch.dict(os.environ, {name: 'fixture'}):
                    with self.assertRaises(AssertionError): build.reject_fixture_environment()
            with patch.object(sys, 'argv', ['build-beta.py', '--features=packaged-updater-fixture']):
                with self.assertRaises(AssertionError): build.reject_fixture_environment()

    def test_binary_marker_rejected_before_shipping_resource_audit(self):
        with tempfile.TemporaryDirectory(prefix='steppe-shipping-guard-') as temporary:
            app = Path(temporary)/'TEMP.app'
            executable = app/'Contents/MacOS/steppe-desktop'
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b'fixture: STEPPE_PACKAGED_UPDATER_FIXTURE_ONLY')
            with self.assertRaisesRegex(AssertionError, 'Refusing to ship fixture binary'):
                build.audit(app, {})
