"""Check the actual installable archive and write a release manifest."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile

repo = Path.cwd()
folder = Path(os.environ['ARTIFACT_DIR'])
package = json.loads((repo / 'package.json').read_text())
version = package['version']
archive = folder / f'dsh-suggest-ghost-{version}.tgz'
with tarfile.open(archive) as tar:
    names = []
    for member in tar:
        if not member.isfile():
            raise RuntimeError('Unexpected non-file package entry: ' + member.name)
        path = Path(member.name).relative_to('package')
        if '..' in path.parts or path.is_absolute():
            raise RuntimeError('Invalid package path')
        assert tar.extractfile(member).read() == (repo / path).read_bytes(), str(path)
        names.append(str(path))
    assert {'lib/client.js', 'lib/index.js', 'locale/en.json', 'locale/zh.json', 'LICENSE'} <= set(names)
assert package['name'] == 'dsh-suggest-ghost'
assert package['exports']['./locale/*.json'] == './locale/*.json'
for language in ('en', 'zh'):
    assert json.loads((repo / f'locale/{language}.json').read_text())['meta']['title'] == 'DSH-Input Prediction'
metadata = json.loads((repo / 'SOURCE_BASE.json').read_text())
assert metadata['local_version'] == version
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
manifest = {'version': version, 'base': os.environ['BASE_SHA'],
            'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip(),
            'changed': os.environ['CHANGED'] == 'true', 'sha256': digest, 'files': len(names)}
(folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(folder / 'dsh-input-prediction-checksums.txt').write_text(f'{digest}  {archive.name}\n')
notes = f'''合并到 main 后，经构建和回归验证发布的版本。

- 上游提交：https://github.com/dsh-plugin-collection/dsh-suggest-ghost/commit/{metadata['upstream_commit']}
- 保留中文追问、DSH-Input Prediction 名称和默认仅回复后灰字建议。
- 已通过构建、中文回归、上游冒烟、长会话摘要和同步脚本测试；安装包 {len(names)} 个文件逐字节核对。
- 此版本由 GitHub Actions 验证，未自动执行 DSh 桌面客户端操作或模型调用。

下载 `.tgz` 后，在 DSh「插件 → 添加插件」中填写完整路径进行覆盖安装，再完整退出并重新打开 DSh。
'''
(folder / 'release-notes.md').write_text(notes)
print(json.dumps(manifest, indent=2))
