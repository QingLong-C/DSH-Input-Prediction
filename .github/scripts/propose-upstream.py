"""Publish only a review branch; never advance main or publish a release."""
import json
import os
from pathlib import Path
import subprocess


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    folder = Path(os.environ['ARTIFACT_DIR'])
    data = json.loads((folder / 'proposal.json').read_text())
    repo = os.environ['GITHUB_REPOSITORY']
    sha = data['commit']
    run('git', 'fetch', str(folder / 'source.bundle'), 'HEAD')
    assert run('git', 'rev-parse', 'FETCH_HEAD') == sha
    assert run('git', 'ls-remote', 'origin', 'refs/heads/main').split()[0] == data['base'], 'main changed; retry'
    run('git', 'merge-base', '--is-ancestor', data['base'], sha)
    # Immutable candidate branches preserve review history; do not overwrite a reviewed PR.
    branch = 'upstream-review/' + sha[:16]
    run('git', 'push', 'origin', sha + ':refs/heads/' + branch)
    run('gh', 'api', f'repos/{repo}/statuses/{sha}', '-f', 'context=Prediction regression',
        '-f', 'state=' + ('success' if data['passed'] else 'failure'),
        '-f', 'description=Build and deterministic regression; human accuracy review required',
        '-f', 'target_url=' + os.environ['GITHUB_SERVER_URL'] + '/' + repo + '/actions/runs/' + os.environ['GITHUB_RUN_ID'])
    body = folder / 'pr.md'
    body.write_text('''## 上游同步候选\n\n仅供审查，未修改 main，也未发布安装包。自动构建和回归结果见提交检查。\n\n### 合并前审查\n- [ ] 核对用户目标、已完成任务和助手提议的区分未退化。\n- [ ] 涉及预测、上下文、提示词或模型调用时，用 DeepSeek V4.1 Flash 运行 `scripts/live-deepseek-regression.mjs`，记录同一批案例的改动前后结果。\n- [ ] 检查有效建议是否减少，不能将全部留空视为准确性提升。\n- [ ] 确认没有失败回归、未解决冲突或未经审查的新权限。\n\n仓库要求至少一名审查者批准当前变更；合并后才重新构建并发布。真实模型测试需要凭据，不会在不可信 PR 中自动调用。\n''')
    url = run('gh', 'pr', 'create', '--repo', repo, '--base', 'main', '--head', branch,
              '--title', 'Review upstream update ' + data['version'], '--body-file', str(body))
    print(url)


if __name__ == '__main__':
    main()
