/**
 * `_ops` schema ↔ TS 类型 漂移冒烟（Gitea #17 的防腐断言）。
 *
 * #17 的本质不是「少写一个 zod 分支」，而是**两份互不约束的真相**：
 * `src/domain.ts` 的 `HotnessOp` 里有 `complete`，`src/hotness-store.ts` 的
 * `opsPayloadSchema` 里没有。TS 类型编译期擦除，zod schema 不看类型，
 * 所以「加了类型忘了 schema」这条错**没有任何静态检查会报**，运行时表现为
 * 客户端写了、宿主整批丢弃、日志一个字不说。
 *
 * 这个断言堵的就是这条路，做法是**从 `src/domain.ts` 现推导变体清单**（不手抄名单——
 * 手抄的名单自己就是第三份会漂移的真相），然后：
 *  1. 每个 TS 变体按声明的字段自动构造合法载荷，过真正的 `parseHotnessOps`，断言被接受；
 *  2. schema 源码里的 `z.literal` 名单与 TS 名单**集合相等**（两个方向都管：
 *     漏分支 → 断言 1 红；只加 schema 不加类型 = 死分支 → 断言 2 红）；
 *  3. 每个变体都得有消费方（`applyOps` 的 `case` 或 `consumeOps` 的 `op.op ===`），
 *     否则「收了但没人处理」同样是静默丢弃；
 *  4. 未知 op 被拒**且留痕**（`rejected` 有值、摘要有内容），空载荷是正常态**不留痕**
 *     ——第 4 项断言的是 #17 的另一半教训：丢弃可以，静默不行。
 *
 * 反向验证（确认它真的会红）：给 `src/domain.ts` 的 `HotnessOp` 加一个
 * `| { readonly op: 'zzz-probe'; readonly text: string }` 再跑本脚本，断言 1 与 2
 * 都应失败；改完记得回滚。
 *
 * 用法：`node scripts/ops-schema-coverage-smoke.mjs`（**不用** --experimental-strip-types，
 * 与 `inline-smoke.mjs` 同一原因：src 里的 `.js` 说明符指向 `.ts` 文件，裸 node 解析不了）。
 * 因此 `parseHotnessOps` 取自构建产物 `lib/`；产物比 src 旧时本脚本会打警告——
 * 断言的是「上次构建的那份代码」，改完 src 记得先 `node build.mjs`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hotnessSchemaVariants, parseHotnessOps } from '../lib/hotness-store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

// —— 0. 构建产物新鲜度：lib 比 src 旧就大声警告（不失败，避免和构建顺序打架）——
{
  const { statSync } = await import('node:fs');
  const srcM = statSync(join(root, 'src/hotness-store.ts')).mtimeMs;
  const libM = statSync(join(root, 'lib/hotness-store.js')).mtimeMs;
  if (libM < srcM) {
    process.stderr.write('⚠️  lib/hotness-store.js 比 src/hotness-store.ts 旧，先跑 `node build.mjs` 再看本脚本结论\n');
  }
}

// —— 1. 从 src/domain.ts 抽 HotnessOp 的变体清单（op 名 + 字段名/可选性/类型）——

/**
 * 解析 `export type HotnessOp = ...` 联合体的每个成员。
 * 只认本仓库这一种写法（`| { readonly op: 'x'; readonly y: T }` 一行一成员）；
 * 写法变了要**显式失败**，不能悄悄抽出空名单——空名单会让后面所有断言「全都对」。
 */
function parseOpUnion(source) {
  const start = source.indexOf('export type HotnessOp =');
  assert.ok(start >= 0, 'src/domain.ts 里找不到 `export type HotnessOp =`（改名或换写法了就同步本脚本）');
  const rest = source.slice(start + 'export type HotnessOp ='.length);
  const members = [];
  // 逐行吃 `|` 开头的成员行，遇到第一个非 `|` 非空行即联合体结束。
  for (const line of rest.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('|')) break;
    const body = trimmed.replace(/^\|\s*/, '').replace(/;\s*$/, '');
    const name = /op:\s*'([^']+)'/.exec(body)?.[1];
    assert.ok(name !== undefined, `HotnessOp 成员解析不出 op 名：${body}`);
    const fields = [];
    for (const field of body.matchAll(/readonly\s+(\w+)(\??):\s*([\w\[\]]+)/g)) {
      if (field[1] === 'op') continue;
      fields.push({ name: field[1], optional: field[2] === '?', type: field[3] });
    }
    members.push({ op: name, fields });
  }
  assert.ok(members.length >= 4, `HotnessOp 只解析出 ${members.length} 个变体，解析逻辑与声明写法脱节了`);
  return members;
}

/** 按 TS 声明造一条合法 op（可选字段不填：schema 侧它们是 optional）。 */
const SAMPLE_TEXT = '冒烟样本';
function sampleValueFor(field) {
  switch (field.type) {
    case 'string': return SAMPLE_TEXT;
    case 'boolean': return true;
    case 'number': return 1;
    default:
      // 新增字段用了本脚本不认识的类型：**必须失败**。让它默认造个值是另一种静默。
      assert.fail(`HotnessOp 字段 ${field.name}: ${field.type} 需要在本脚本里补样例取值`);
  }
}
function sampleOp(member) {
  const box = { op: member.op };
  for (const field of member.fields) {
    if (field.optional) continue;
    box[field.name] = sampleValueFor(field);
  }
  return box;
}

const domainSource = read('src/domain.ts');
const variants = parseOpUnion(domainSource);
const domainNames = variants.map((v) => v.op).sort();

// —— 2. 逐个变体过真解析：全部被接受（漏 schema 分支在这里立刻红）——
for (const member of variants) {
  const payload = JSON.stringify({ rev: 1, ops: [sampleOp(member)] });
  const parsed = parseHotnessOps(payload);
  assert.equal(
    parsed.rejected,
    undefined,
    `变体 "${member.op}" 被 opsPayloadSchema 拒绝：${parsed.rejected?.summary ?? ''}（#17 型漂移：加了类型没加 schema？）`,
  );
  assert.equal(parsed.ops.length, 1, `变体 "${member.op}" 没被放行（解析出 ${parsed.ops.length} 条）`);
  assert.equal(parsed.ops[0].op, member.op, `变体 "${member.op}" 解析后 op 名不符`);
}

// 全变体混批也必须整批放行（判据 1 只喂单条，混批能额外暴露 slice/长度上限类问题）
{
  const mixed = variants.map((m) => sampleOp(m));
  const parsed = parseHotnessOps(JSON.stringify({ rev: 1, ops: mixed, locale: 'zh' }));
  assert.equal(parsed.rejected, undefined, `混批被拒：${parsed.rejected?.summary ?? ''}`);
  assert.equal(parsed.ops.length, mixed.length, '混批条数不符');
  assert.equal(parsed.locale, 'zh', '捎带的 locale 没解析出来');
}

// —— 3. 名单集合相等（双向漂移都管；schema 侧名单从真 schema 现推导，不是手抄）——
const schemaNames = hotnessSchemaVariants().map((v) => v.op).sort();
assert.deepEqual(
  schemaNames,
  domainNames,
  `schema 放行 [${schemaNames}] ≠ HotnessOp 声明 [${domainNames}]`,
);
// 字段级漂移：TS 声明的必填字段必须也在 schema 的必填集里（少一个就是「类型有、schema 不认」）。
{
  const schemaByOp = new Map(hotnessSchemaVariants().map((v) => [v.op, v]));
  for (const member of variants) {
    const arm = schemaByOp.get(member.op);
    assert.ok(arm !== undefined, `schema 里没有 op 变体 "${member.op}"`);
    for (const field of member.fields) {
      if (field.optional) continue;
      assert.ok(
        arm.required.includes(field.name),
        `"${member.op}".${field.name} 在 TS 里必填，schema 里没有对应必填字段（两份声明已经分叉）`,
      );
    }
  }
}

// —— 4. 每个变体都有消费方（收了没人处理 = 换地方的静默丢弃）——
{
  const storeSource = read('src/hotness-store.ts');
  const hostSource = read('src/index.ts');
  for (const name of domainNames) {
    const applied = new RegExp(`case '${name}':`).test(storeSource);
    const consumed = new RegExp(`op\\.op === '${name}'`).test(hostSource);
    assert.ok(applied || consumed, `op "${name}" 没有任何消费方：既不在 applyOps 的 case 里，也不在 consumeOps 的 op.op 判断里`);
  }
}

// —— 5. 未知 op：拒绝 + 必须留痕（#17 的另一半教训）——
{
  const unknown = parseHotnessOps(JSON.stringify({ rev: 1, ops: [{ op: 'definitely-not-an-op', text: 'x' }] }));
  assert.equal(unknown.ops.length, 0, '未知 op 不该被放行');
  assert.ok(unknown.rejected !== undefined, '未知 op 被拒但没有 rejected 留痕（静默丢弃又回来了）');
  assert.equal(unknown.rejected.kind, 'schema');
  assert.ok(unknown.rejected.summary.length > 0, 'rejected.summary 是空的，日志里等于没打');
  assert.ok(unknown.rejected.summary.includes('op'), `rejected.summary 没指出是哪个字段被拒：${unknown.rejected.summary}`);
  assert.ok(unknown.rejected.bytes > 0, 'rejected.bytes 应当带上载荷长度');

  // 合法混着非法：整批丢弃（schema 是 discriminatedUnion，行为如此，断言它别被「改得宽容」悄悄改掉），
  // 而且丢弃原因仍要留痕——这条正是 #17 现场的样子：complete 没进枚举，连带 delete 一起没执行。
  const tainted = parseHotnessOps(JSON.stringify({ rev: 1, ops: [{ op: 'clear' }, { op: 'nope' }] }));
  assert.equal(tainted.ops.length, 0, '混着非法 op 的批次应当整批拒绝');
  assert.ok(tainted.rejected !== undefined, '整批拒绝必须留痕');
}

// —— 6. 空载荷是正常态：不留痕（host 每次消费后都写回空值，每次都 warn 就成了噪声）——
for (const empty of [undefined, '', 'null']) {
  const parsed = parseHotnessOps(empty);
  assert.deepEqual(parsed.ops, [], `空载荷 ${JSON.stringify(empty)} 应解析成空 ops`);
  assert.equal(parsed.rejected, undefined, `空载荷 ${JSON.stringify(empty)} 不该算作丢弃、不该留痕`);
}

// —— 7. JSON 解析失败：留痕，kind 与 schema 区分得开 ——
{
  const broken = parseHotnessOps('{"rev":1,"ops":[');
  assert.equal(broken.ops.length, 0);
  assert.ok(broken.rejected !== undefined, 'JSON 解析失败必须留痕');
  assert.equal(broken.rejected.kind, 'json', `应当标成 json 失败，实际 ${broken.rejected.kind}`);
}

console.log(`ops-schema-coverage smoke: ${variants.length} 个 op 变体全部放行（${domainNames.join(', ')}），未知 op 与空载荷的留痕分级正确`);
