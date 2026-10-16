"""Publish a tested artifact without executing code from the candidate bundle."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def run(*args, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=180)
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr}')
    return result


def main():
    folder = Path(os.environ['ARTIFACT_DIR'])
    manifest = json.loads((folder / 'manifest.json').read_text())
    version = manifest['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+-cn\.\d+', version):
        raise RuntimeError('Unexpected release version')
    for key in ('base', 'commit'):
        if not re.fullmatch(r'[0-9a-f]{40}', manifest[key]):
            raise RuntimeError('Invalid commit identifier')
    package = folder / f'dsh-suggest-ghost-{version}.tgz'
    if hashlib.sha256(package.read_bytes()).hexdigest() != manifest['sha256']:
        raise RuntimeError('Package checksum mismatch')
    repo = os.environ['GITHUB_REPOSITORY']
    tag = 'v' + version
    response = run('gh', 'api', f'repos/{repo}/releases/tags/{tag}', check=False)
    release = None
    if response.returncode == 0:
        release = json.loads(response.stdout)
        if not release['draft']:
            names = {asset['name'] for asset in release['assets'] if asset['state'] == 'uploaded'}
            if {package.name, 'dsh-input-prediction-checksums.txt'} <= names and not manifest['changed']:
                print('No upstream changes; current version is already published.')
                return
            raise RuntimeError('A published release already uses this version; refusing to replace it')
    elif '(HTTP 404)' not in response.stderr:
        raise RuntimeError('Cannot check existing release: ' + response.stderr)

    run('git', 'bundle', 'verify', str(folder / 'source.bundle'))
    run('git', 'fetch', str(folder / 'source.bundle'), 'HEAD')
    if run('git', 'rev-parse', 'FETCH_HEAD').stdout.strip() != manifest['commit']:
        raise RuntimeError('Candidate bundle does not match manifest')
    refs = {}
    for line in run('git', 'ls-remote', 'origin', 'refs/heads/main', 'refs/tags/' + tag).stdout.splitlines():
        sha, name = line.split()
        refs[name] = sha
    if refs.get('refs/heads/main') != manifest['base']:
        raise RuntimeError('main changed during testing; rerun on the new main instead of overwriting it')
    if manifest['changed']:
        run('git', 'merge-base', '--is-ancestor', manifest['base'], manifest['commit'])
    elif manifest['commit'] != manifest['base']:
        raise RuntimeError('Unexpected candidate for a no-change run')
    existing_tag = refs.get('refs/tags/' + tag)
    if existing_tag and existing_tag != manifest['commit']:
        raise RuntimeError('Release tag points to another commit')
    pushes = []
    if manifest['changed']:
        pushes.append(manifest['commit'] + ':refs/heads/main')
    if not existing_tag:
        pushes.append(manifest['commit'] + ':refs/tags/' + tag)
    if pushes:
        run('git', 'push', '--atomic', 'origin', *pushes)
    if release is None:
        run('gh', 'release', 'create', tag, '--repo', repo, '--verify-tag', '--draft',
            '--title', 'DSH-Input Prediction ' + version, '--notes-file', str(folder / 'release-notes.md'))
    run('gh', 'release', 'upload', tag, str(package), str(folder / 'dsh-input-prediction-checksums.txt'),
        '--repo', repo, '--clobber')
    # Verify the actual uploaded archive before making the draft public.
    downloaded = folder / 'download-check'
    downloaded.mkdir(exist_ok=True)
    run('gh', 'release', 'download', tag, '--repo', repo, '--pattern', package.name, '--dir', str(downloaded), '--clobber')
    if hashlib.sha256((downloaded / package.name).read_bytes()).hexdigest() != manifest['sha256']:
        raise RuntimeError('Uploaded package checksum mismatch')
    run('gh', 'release', 'edit', tag, '--repo', repo, '--draft=false', '--latest')
    print(f'https://github.com/{repo}/releases/tag/{tag}')


if __name__ == '__main__':
    main()
