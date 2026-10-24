"""Exercise real Git merges in disposable repositories, without network access."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('sync_upstream', Path(__file__).with_name('sync-upstream.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-q', '-b', 'upstream')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.write('package.json', {'name': 'dsh-suggest-ghost', 'version': '0.5.1', 'description': 'Original',
                                   'scripts': {'build': 'build'}, 'dependencies': {'example': '1'},
                                   'files': ['lib', 'docs']})
        self.write('src/example.txt', 'upstream=1\n' + 'unchanged\n' * 12 + 'followup=off\n')
        self.write('.github/workflows/original.yml', 'old\n')
        self.base = self.commit('upstream base')
        self.git('checkout', '-q', '-b', 'main')
        package = self.read('package.json')
        package.update(version='0.5.1-cn.3', description='Chinese follow-ups', files=['lib', 'locale'])
        package['scripts']['test:cn'] = 'test chinese'
        self.write('package.json', package)
        self.write('SOURCE_BASE.json', {'upstream_commit': self.base, 'local_version': package['version']})
        self.write('src/example.txt', (self.repo / 'src/example.txt').read_text().replace('followup=off', 'followup=Chinese'))
        self.write('.github/workflows/original.yml', 'custom\n')
        self.commit('customization')

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.repo, stderr=subprocess.PIPE).decode().strip()

    def write(self, path, value):
        file = self.repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value, indent=2) + '\n' if isinstance(value, dict) else value)

    def read(self, path):
        return json.loads((self.repo / path).read_text())

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-qm', message)
        return self.git('rev-parse', 'HEAD')

    def advance(self, conflict=False):
        self.git('checkout', '-q', 'upstream')
        source = (self.repo / 'src/example.txt').read_text()
        source = source.replace('followup=off', 'followup=upstream') if conflict else source.replace('upstream=1', 'upstream=2')
        self.write('src/example.txt', source)
        package = self.read('package.json')
        package.update(version='0.5.2', description='New upstream description')
        package['dependencies']['example'] = '2'
        package['files'].append('assets')
        self.write('package.json', package)
        self.write('.github/workflows/original.yml', 'new upstream workflow\n')
        tip = self.commit('upstream update')
        self.git('checkout', '-q', 'main')
        return tip

    def test_no_update_is_clean_noop(self):
        result = sync.synchronize(self.repo, self.base)
        self.assertFalse(result['changed'])
        self.assertEqual(self.git('status', '--porcelain'), '')

    def test_merge_keeps_chinese_and_branding_but_updates_dependencies(self):
        tip = self.advance()
        result = sync.synchronize(self.repo, tip)
        self.assertTrue(result['changed'])
        self.assertEqual(result['version'], '0.5.2-cn.4')
        source = (self.repo / 'src/example.txt').read_text()
        self.assertIn('upstream=2', source)
        self.assertIn('followup=Chinese', source)
        package = self.read('package.json')
        self.assertEqual(package['dependencies']['example'], '2')
        self.assertEqual(package['description'], 'Chinese follow-ups')
        self.assertEqual(package['scripts']['test:cn'], 'test chinese')
        self.assertEqual(package['files'], ['lib', 'locale', 'assets'])
        self.assertEqual((self.repo / '.github/workflows/original.yml').read_text(), 'custom\n')
        self.assertEqual(self.read('SOURCE_BASE.json')['upstream_commit'], tip)
        self.commit('sync')
        self.assertFalse(sync.synchronize(self.repo, tip)['changed'])

    def test_conflict_does_not_advance_recorded_base(self):
        tip = self.advance(conflict=True)
        with self.assertRaises(RuntimeError):
            sync.synchronize(self.repo, tip)
        self.assertEqual(self.read('SOURCE_BASE.json')['upstream_commit'], self.base)
        self.assertTrue(self.git('ls-files', '-u'))

    def test_force_rebuild_increments_version_without_upstream_changes(self):
        result = sync.synchronize(self.repo, self.base, force=True)
        self.assertEqual(result['version'], '0.5.1-cn.4')
        self.assertTrue(result['changed'])

    def test_non_fast_forward_upstream_is_rejected(self):
        self.git('checkout', '--orphan', 'rewritten')
        self.write('new.txt', 'new root')
        tip = self.commit('rewritten root')
        self.git('checkout', '-q', 'main')
        with self.assertRaisesRegex(RuntimeError, 'ancestor'):
            sync.synchronize(self.repo, tip)
        self.assertEqual(self.git('status', '--porcelain'), '')

    def test_conflicting_dependency_changes_are_not_silently_overwritten(self):
        tip = self.advance()
        package = self.read('package.json')
        package['dependencies']['example'] = 'custom'
        self.write('package.json', package)
        self.commit('custom dependency')
        with self.assertRaisesRegex(RuntimeError, 'dependencies.example'):
            sync.synchronize(self.repo, tip)
        self.assertEqual(self.read('SOURCE_BASE.json')['upstream_commit'], self.base)


if __name__ == '__main__':
    unittest.main(verbosity=2)
