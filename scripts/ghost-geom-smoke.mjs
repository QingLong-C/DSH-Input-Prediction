/**
 * 幽灵 overlay 定位几何冒烟测试。
 *
 * 复刻宿主 composer 的真实 DOM 契约（实测自 DSH 0.2.0-rc.2 的
 * `uV2eYG_scroll` / `uV2eYG_grow` / `uV2eYG_input` 三层结构）：
 *
 *   [data-input-scroll]  overflow-y:auto; max-height 336px   ← 滚动发生在这一层
 *   └─ .grow             position:relative                    ← offsetParent
 *      ├─ [data-composer-input]                               ← 编辑器，scrollTop 恒 0
 *      └─ [data-composer-placeholder]
 *
 * 被验证的不变量：overlay 是 `.grow` 的子节点，因此**随内容一起滚动**，
 * 定位公式只应为 `offsetTop + padding`，不含任何 scrollTop 项。
 *
 * 用法：node scripts/ghost-geom-smoke.mjs
 */

import { readFileSync } from 'node:fs';

const MAX_H = 336;   // --dsh-composer-text-max-height
const LINE_H = 24;   // line-height
const PAD_TOP = 4;
const PAD_LEFT = 14;

/**
 * 几何模型：给定草稿行数与滚动量，算出各层的**视口坐标**。
 *
 * 关键：`.grow` 是滚动容器的子节点，所以它和编辑器一起被滚动推上去——
 * 两者的视口 top 都等于 `growContentTop - scrollTop`。
 */
function layout(lines, scrollTop) {
  const contentH = lines * LINE_H;
  const viewportH = Math.min(contentH, MAX_H);
  const maxScroll = Math.max(0, contentH - viewportH);
  const st = Math.min(Math.max(scrollTop, 0), maxScroll);
  const growContentTop = 600;                 // 未滚动时 .grow 的视口 top（任意常量）
  const moved = growContentTop - st;          // 滚动后 .grow / 编辑器的视口 top
  return {
    scrollTop: st, maxScroll,
    grow: { top: moved },
    input: { top: moved, offsetTop: 0, offsetLeft: 0, scrollTop: 0,
             paddingTop: PAD_TOP, paddingLeft: PAD_LEFT },
    scroller: { top: growContentTop, height: viewportH, scrollTop: st },
  };
}

/** 当前实现：offsetTop + padding（无滚动项）。返回内容坐标系内的 css top。 */
const cssTopOf = (m) => m.input.offsetTop + m.input.paddingTop;

/** 幽灵的视口 top = 内容坐标 + .grow 的视口 top。 */
const ghostViewportTop = (m) => m.grow.top + cssTopOf(m);

/** 正文内容原点的视口 top。 */
const textViewportTop = (m) => m.input.top + m.input.paddingTop;

/** 旧实现：多减了一次编辑器 scrollTop（恒 0，故当年"碰巧"没暴露，但语义是错的）。 */
const legacyCssTopOf = (m) => m.input.offsetTop + m.input.paddingTop - m.input.scrollTop;

/** 被否掉的错误修法：拿滚动容器的 scrollTop 去补偿（会错位 2×scrollTop）。 */
const wrongCompensatedCssTopOf = (m) => m.input.offsetTop + m.input.paddingTop - m.scroller.scrollTop;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('【1】未滚动：短草稿的基线与正文对齐');
{
  const m = layout(1, 0);
  check('幽灵与正文原点重合', ghostViewportTop(m) === textViewportTop(m));
}

console.log('\n【2】滚动场景：幽灵必须始终与正文原点重合（这是核心不变量）');
{
  let allOk = true;
  const samples = [];
  for (let lines = 1; lines <= 60; lines += 1) {
    const maxScroll = Math.max(0, lines * LINE_H - MAX_H);
    for (let st = 0; st <= maxScroll; st += 7) {
      const m = layout(lines, st);
      const ok = ghostViewportTop(m) === textViewportTop(m);
      if (!ok) allOk = false;
      if (st > 0 && samples.length < 3) samples.push({ lines, st, drift: ghostViewportTop(m) - textViewportTop(m) });
    }
  }
  check('全部 (行数 × 滚动量) 组合均无漂移', allOk);
  if (samples.length > 0) {
    console.log(`     抽样：${samples.map(s => `lines=${s.lines},st=${s.st},drift=${s.drift}`).join('  ')}`);
  }
}

console.log('\n【3】反例守卫：错误公式必须被此测试判为错位（防止有人再"修"回去）');
{
  const m = layout(30, 120);
  const wrongDrift = (m.grow.top + wrongCompensatedCssTopOf(m)) - textViewportTop(m);
  // 幽灵本身已随内容滚动（-scrollTop），再减一次即双重补偿 → 漂移 -1×scrollTop。
  check('减去 scroller.scrollTop 的写法产生 -1×scrollTop 漂移',
    wrongDrift === -m.scrollTop, `实际 drift=${wrongDrift}, 期望=${-m.scrollTop}`);

  // 旧实现多减 input.scrollTop：因该值恒 0，历史代码"看起来对"，语义仍错。
  const legacyDrift = (m.grow.top + legacyCssTopOf(m)) - textViewportTop(m);
  check('旧写法在编辑器 scrollTop=0 时恰好对齐（故当年未暴露）', legacyDrift === 0);
}

console.log('\n【4】回归：旧 bug 的可观测症状（滚动后幽灵不再跟随正文）');
{
  const lines = 30;
  const st = 120;
  const m = layout(lines, st);
  // 旧实现用「编辑器 scrollTop」当滚动量，而它恒 0 —— 于是幽灵停在未滚动位置。
  const buggyGhostTop = m.grow.top + legacyCssTopOf(m) + st; // 模拟：完全没跟随
  const correctGhostTop = ghostViewportTop(m);
  const textTop = textViewportTop(m);
  console.log(`     正文 top=${textTop}  正确幽灵=${correctGhostTop}  旧 bug 幽灵=${buggyGhostTop}`);
  check('正确实现跟随正文', correctGhostTop === textTop);
  check('旧 bug 症状表现为错位（>0）', buggyGhostTop - textTop === st);
}

console.log('\n【5】自检容差：一行以内视为正常，超过一行判定失真');
{
  const lineHeight = LINE_H;
  const verdict = (drift) => Math.abs(drift) <= lineHeight;
  check('0px 漂移 → 通过', verdict(0) === true);
  check('1px 舍入 → 通过', verdict(1) === true);
  check('一行（24px）→ 通过', verdict(lineHeight) === true);
  check('超过一行（25px）→ 判定失真、不显示', verdict(lineHeight + 1) === false);
  check('大幅错位（120px）→ 判定失真、不显示', verdict(120) === false);
}

console.log('\n【6】显示顺序：必须先 display 再测量（否则自检死锁、幽灵永不出现）');
{
  /**
   * 复刻 `getBoundingClientRect()` 对 `display:none` 的行为：恒返回全 0。
   * 这是一个真实踩过的坑——先测量后显示时，verify() 每次都看到空矩形并拒绝，
   * display 永远停在 none，表现为「插件失效」且不报错。
   */
  const measure = (display, top) => (display === 'none' ? { top: 0, left: 0 } : { top, left: 0 });

  const verify = (rect, expectedTop, tolerance) => {
    if (Math.abs(rect.top - expectedTop) > tolerance) return false;
    return true;
  };

  const expectedTop = 604;
  const tolerance = 24;

  // 错误顺序：先测量（此时 display:none）再显示 —— 必然失败。
  const wrongRect = measure('none', expectedTop);
  check('错误顺序下测得空矩形 → 自检失败（死锁根因）',
    verify(wrongRect, expectedTop, tolerance) === false);

  // 正确顺序：先 display:block 再测量 —— 通过。
  const rightRect = measure('block', expectedTop);
  check('正确顺序下测得真实矩形 → 自检通过',
    verify(rightRect, expectedTop, tolerance) === true);
}

console.log('\n【7】placeholder 让位：不得重叠，也不得「幽灵没显示却把 placeholder 藏了」');
{
  /**
   * 宿主 placeholder 与幽灵**同原点**（实测同为 contentOrigin：input 1280/406，
   * placeholder 1284/420），所以两者只要同时可见就是重叠——用户截图里那层糊字。
   *
   * 让位规则必须同时满足两个条件才算数：
   *   ① `data-shown="1"`（幽灵逻辑上要显示）
   *   ② 未被 `display:none` 隐藏（幽灵**真的**画出来了）
   *
   * 只按 ① 会漏掉「display 已回退但属性还没来得及改」的窗口 → 重叠；
   * 只按「节点存在于 DOM」则会走向另一个极端：节点首次 show 后就常驻不移除，
   * 于是草稿清空、幽灵隐藏后 placeholder 仍被藏住 → 输入框一片空白（实测踩过）。
   */
  const evalState = ({ ghostDisplay, dataShown, nodeInDom = true }) => {
    const ghostVisible = ghostDisplay === 'block';
    // 规则命中条件：节点在 DOM 且 data-shown=1 且未 display:none。
    const ruleHits = nodeInDom && dataShown === '1' && ghostDisplay !== 'none';
    return { ghostVisible, placeholderVisible: !ruleHits };
  };

  // 旧顺序（先 display 后标记）在中间态制造重叠。
  const badSequence = [
    { step: 'display=block (先显示)', ...evalState({ ghostDisplay: 'block', dataShown: '0' }) },
    { step: 'data-shown=1 (后标记)', ...evalState({ ghostDisplay: 'block', dataShown: '1' }) },
  ];
  const badOverlap = badSequence.find(s => s.ghostVisible && s.placeholderVisible);

  // 现顺序（先标记后显示）：任何中间态都不重叠。
  const goodSequence = [
    { step: 'data-shown=1 (先标记)', ...evalState({ ghostDisplay: 'none', dataShown: '1' }) },
    { step: 'display=block (后显示)', ...evalState({ ghostDisplay: 'block', dataShown: '1' }) },
  ];
  const goodOverlap = goodSequence.find(s => s.ghostVisible && s.placeholderVisible);

  check('旧顺序存在重叠窗口（复现用户截图）', badOverlap !== undefined,
    badOverlap ? `在「${badOverlap.step}」重叠` : '');
  check('现顺序任何中间态都不重叠', goodOverlap === undefined,
    goodOverlap ? `在「${goodOverlap.step}」重叠` : '');

  // 反向护栏：幽灵隐藏时 placeholder 必须回来（曾因规则过宽而失效）。
  const hiddenState = evalState({ ghostDisplay: 'none', dataShown: '0' });
  check('幽灵隐藏 → placeholder 恢复可见（防规则过宽）',
    hiddenState.placeholderVisible === true);

  // 同一节点的完整生命周期矩阵：每一格都不允许同时可见。
  const lifecycle = [
    ['隐藏', { ghostDisplay: 'none', dataShown: '0' }],
    ['显示中', { ghostDisplay: 'block', dataShown: '1' }],
    ['再次隐藏', { ghostDisplay: 'none', dataShown: '0' }],
    ['节点移除', { ghostDisplay: 'none', dataShown: '0', nodeInDom: false }],
  ].map(([label, s]) => ({ label, ...evalState(s) }));
  check('生命周期任一点都不同时可见',
    lifecycle.every(s => !(s.ghostVisible && s.placeholderVisible)));
  check('幽灵隐藏后 placeholder 均有显示',
    lifecycle.filter(s => !s.ghostVisible).every(s => s.placeholderVisible));
}

console.log('\n【8】产物字节级护栏：检查真正下发的 bundle，而不是把逻辑再实现一遍');
{
  /**
   * 前面几组验证的是「我复述的模型」，这一组验证的是「实际产物」。
   * 起因：`src/client` 被根 tsconfig `exclude`，从未被类型检查，一个未声明标识符
   * `scrollHost` 直接进了 bundle，运行时每次 composer 新挂载都抛
   * `ReferenceError: scrollHost is not defined`，把第一次幽灵渲染整个吞掉——
   * 而 tsc/esbuild 全绿、源码看着也"对"。对这种类别，唯一可信的门禁是产物本身。
   */
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

  check('产物中不存在未声明标识符 scrollHost（ReferenceError 回归）',
    !/scrollHost/.test(bundle));

  check('render() 对非编辑器形态设了防护（workspaceTrigger 下不挂幽灵）',
    /if \(!isComposerElement\(composer\)\)/.test(bundle));

  // 让位规则必须「已标记显示 且 未被 display:none 隐藏」两个条件同时成立：
  // 少第一个 → 幽灵显示时与 placeholder 重叠（用户截图）；
  // 少第二个 → 幽灵隐藏后 placeholder 被永久藏住，输入框看起来空掉。
  const rule = bundle.match(/body:has\(#dsh-suggest-ghost-overlay[^']*\)\s*\[data-composer-placeholder\]/);
  check('让位规则同时要求 data-shown=1 与未被 display:none 隐藏',
    !!rule && rule[0].includes('[data-shown="1"]') && rule[0].includes(':not([style*="display: none"])'));

  check('让位规则不得退化为「节点存在即藏」（我今天犯过的过宽错误）',
    !/body:has\(#dsh-suggest-ghost-overlay\)\s*\[/.test(bundle));

  // 顺序护栏：先标记 data-shown 再 display:block，否则存在双绘窗口。
  const av = bundle.slice(bundle.indexOf('alignAndVerify()'));
  check('alignAndVerify 先写 data-shown 再置 display:block（防重叠窗口）',
    av.indexOf('dataset.shown = "1"') < av.indexOf('style.display = "block"'));
}

console.log(`\n结果：${pass} 通过, ${fail} 失败`);process.exit(fail === 0 ? 0 : 1);
