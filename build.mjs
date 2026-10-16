/**
 * 构建脚本：
 *  1. tsc 编译 host 端（src/ → lib/，tsconfig.json 已排除 src/client）
 *  2. esbuild 打包 client 端单文件并包进 __ModuleLoader__.load 模板
 * 产物：lib/index.js（host）+ lib/client.js（浏览器端）
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

// 1. host 端：tsc
execSync('npx tsc -p tsconfig.json', { stdio: 'inherit' });

// 2. client 端：esbuild 打包（type-only imports 剥离；react 从宿主运行时解析）
const result = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  // 与 DSH 官方 client 插件一致：JSX 走 react/jsx-runtime（automatic），
  // 由 __ModuleLoader__ 的 require 从宿主解析；不用 transform 模式（会生成
  // 全局 React.createElement，宿主无全局 React 导致设置卡片渲染崩溃）。
  jsx: 'automatic',
  // react 由 __ModuleLoader__ 的 require 从宿主解析（前端运行时已提供）。
  // 其他依赖由 @deepseek-ai/dsh-client-ui-primitives 等库引入，同样从宿主解析。
  // 使用 packages: 'external' 让所有 node_modules 中的包都从外部解析。
  packages: 'external',
});

const body = result.outputFiles[0].text;
const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-suggest-ghost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${body}
		return module.exports;
	}
});
`;

mkdirSync('lib', { recursive: true });
writeFileSync('lib/client.js', wrapped);
console.log('✅ lib/index.js (host, tsc) + lib/client.js (browser, esbuild) 构建完成');
