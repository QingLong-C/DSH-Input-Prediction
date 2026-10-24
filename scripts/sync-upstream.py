"""Apply upstream changes using its recorded base, without replacing local customizations."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess

UPSTREAM = 'https://github.com/dsh-plugin-collection/dsh-suggest-ghost.git'
MISSING = object()
OWNED = {('name',), ('version',), ('description',), ('repository',), ('homepage',),
         ('bugs',), ('contributors',), ('screenshots',), ('scripts', 'test:cn'),
         ('scripts', 'test:sync')}
EXCLUDED = ['.github/**', 'README*', 'CHANGELOG*', 'docs/**', 'lib/**',
            'SOURCE_BASE.json', 'package.json', 'scripts/sync-upstream.py',
            'scripts/test-sync-upstream.py', 'scripts/verify-release.py']


def git(repo, *args, input=None, check=True):
    result = subprocess.run(['git', *args], cwd=repo, input=input, capture_output=True, timeout=120)
    if check and result.returncode:
        raise RuntimeError(f'git {args[0]} failed: {result.stderr.decode()} {result.stdout.decode()}')
    return result


def merge_package(base, ours, theirs, path=()):
    if path in OWNED or theirs == base or ours == theirs:
        return ours
    if ours == base:
        return theirs
    if all(isinstance(value, dict) for value in (base, ours, theirs)):
        result = {}
        for key in dict.fromkeys([*ours, *theirs, *base]):
            value = merge_package(base.get(key, MISSING), ours.get(key, MISSING),
                                  theirs.get(key, MISSING), path + (key,))
            if value is not MISSING:
                result[key] = value
        return result
    if path == ('files',) and all(isinstance(value, list) for value in (base, ours, theirs)):
        # Keep our removals (old screenshots/docs) and include genuinely new upstream assets.
        return [item for item in ours if item not in base or item in theirs] + [
            item for item in theirs if item not in base and item not in ours]
    raise RuntimeError('package.json conflict at ' + '.'.join(path))


def synchronize(repo, target, force=False):
    repo = Path(repo)
    if git(repo, 'status', '--porcelain').stdout.strip():
        raise RuntimeError('Synchronization requires a clean working tree')
    metadata = json.loads((repo / 'SOURCE_BASE.json').read_text())
    base = metadata['upstream_commit']
    target = git(repo, 'rev-parse', '--verify', target + '^{commit}').stdout.decode().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', base):
        raise RuntimeError('Invalid recorded upstream commit')
    if git(repo, 'merge-base', '--is-ancestor', base, target, check=False).returncode:
        raise RuntimeError('Recorded upstream commit is not an ancestor of the new tip; manual review required')
    ours = json.loads((repo / 'package.json').read_text())
    if base == target and not force:
        return {'changed': False, 'version': ours['version'], 'upstream': target}
    before = json.loads(git(repo, 'show', f'{base}:package.json').stdout)
    after = json.loads(git(repo, 'show', f'{target}:package.json').stdout)
    package = merge_package(before, ours, after)
    current = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)-cn\.(\d+)', ours['version'])
    new = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:[-+].*)?', after['version'])
    if not current or not new or tuple(map(int, new.groups())) < tuple(map(int, current.groups()[:3])):
        raise RuntimeError('Unexpected or decreasing package version; manual review required')
    package['version'] = '.'.join(new.groups()) + '-cn.' + str(int(current[4]) + 1)
    patch = git(repo, 'diff', '--binary', '--no-renames', base, target, '--', '.',
                *[':(exclude)' + path for path in EXCLUDED]).stdout
    if patch:
        git(repo, 'apply', '--3way', '--index', input=patch)
    metadata.setdefault('original_upstream_commit', base)
    metadata.update(upstream_commit=target, local_version=package['version'],
                    last_auto_sync=datetime.now(timezone.utc).isoformat())
    (repo / 'package.json').write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n')
    (repo / 'SOURCE_BASE.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    return {'changed': True, 'version': package['version'], 'upstream': target}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true', help='Rebuild and release even when upstream is unchanged')
    args = parser.parse_args()
    repo = Path.cwd()
    git(repo, 'fetch', '--no-tags', UPSTREAM, '+refs/heads/main:refs/remotes/sync-upstream/main')
    result = synchronize(repo, 'refs/remotes/sync-upstream/main', force=args.force)
    print(json.dumps(result, indent=2))
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            for key, value in result.items():
                output.write(f'{key}={str(value).lower() if isinstance(value, bool) else value}\n')


if __name__ == '__main__':
    main()
