#!/usr/bin/env node
/**
 * keyspec 快捷键映射回归测试（`src/client/keyspec.ts`）。
 *
 * 钉住 keyCodeOf / keyNameOfCode / keyEventToSpec 的映射性质：
 * 1. keyCodeOf：spec -> KeyboardEvent.code
 * 2. keyNameOfCode：KeyboardEvent.code -> 显示名
 * 3. keyEventToSpec：KeyboardEvent -> spec
 *
 * 覆盖：单键、修饰键组合、字母/数字简写、特殊键、边界情况。
 *
 * 用法：node --experimental-strip-types scripts/keyspec-smoke.mjs
 */
import assert from 'node:assert/strict';
import { keyCodeOf, keyNameOfCode, keyEventToSpec } from '../src/client/keyspec.ts';

console.log('【keyspec 快捷键映射冒烟测试】\n');

// ─── keyCodeOf ───────────────────────────────────────────────────────────

// 1. 单键：Tab
{
  assert.equal(keyCodeOf('Tab'), 'Tab');
  console.log('✅ keyCodeOf("Tab") → "Tab"');
}

// 2. 单键：Enter
{
  assert.equal(keyCodeOf('Enter'), 'Enter');
  console.log('✅ keyCodeOf("Enter") → "Enter"');
}

// 3. 修饰键组合：Alt+S
{
  assert.equal(keyCodeOf('Alt+S'), 'KeyS');
  console.log('✅ keyCodeOf("Alt+S") → "KeyS"');
}

// 4. 修饰键组合：Ctrl+Enter
{
  assert.equal(keyCodeOf('Ctrl+Enter'), 'Enter');
  console.log('✅ keyCodeOf("Ctrl+Enter") → "Enter"');
}

// 5. 修饰键组合：Shift+Tab
{
  assert.equal(keyCodeOf('Shift+Tab'), 'Tab');
  console.log('✅ keyCodeOf("Shift+Tab") → "Tab"');
}

// 6. 字母简写：s -> KeyS
{
  assert.equal(keyCodeOf('s'), 'KeyS');
  console.log('✅ keyCodeOf("s") → "KeyS"');
}

// 7. 数字简写：1 -> Digit1
{
  assert.equal(keyCodeOf('1'), 'Digit1');
  console.log('✅ keyCodeOf("1") → "Digit1"');
}

// 8. 特殊键：F1
{
  assert.equal(keyCodeOf('F1'), 'F1');
  console.log('✅ keyCodeOf("F1") → "F1"');
}

// 9. 特殊键：ArrowUp
{
  assert.equal(keyCodeOf('Up'), 'ArrowUp');
  console.log('✅ keyCodeOf("Up") → "ArrowUp"');
}

// 10. 无效键：undefined
{
  assert.equal(keyCodeOf('InvalidKey'), undefined);
  console.log('✅ keyCodeOf("InvalidKey") → undefined');
}

// 11. 空字符串：undefined
{
  assert.equal(keyCodeOf(''), undefined);
  console.log('✅ keyCodeOf("") → undefined');
}

// 12. 多修饰键：Ctrl+Alt+Delete
{
  assert.equal(keyCodeOf('Ctrl+Alt+Delete'), undefined); // Delete 不在 KEY_CODES 中
  console.log('✅ keyCodeOf("Ctrl+Alt+Delete") → undefined（Delete 不支持）');
}

// ─── keyNameOfCode ───────────────────────────────────────────────────────

// 13. KeyS -> S
{
  assert.equal(keyNameOfCode('KeyS'), 'S');
  console.log('✅ keyNameOfCode("KeyS") → "S"');
}

// 14. Digit1 -> 1
{
  assert.equal(keyNameOfCode('Digit1'), '1');
  console.log('✅ keyNameOfCode("Digit1") → "1"');
}

// 15. ArrowUp -> Up
{
  assert.equal(keyNameOfCode('ArrowUp'), 'Up');
  console.log('✅ keyNameOfCode("ArrowUp") → "Up"');
}

// 16. Tab -> Tab
{
  assert.equal(keyNameOfCode('Tab'), 'Tab');
  console.log('✅ keyNameOfCode("Tab") → "Tab"');
}

// 17. F1 -> F1
{
  assert.equal(keyNameOfCode('F1'), 'F1');
  console.log('✅ keyNameOfCode("F1") → "F1"');
}

// 18. 无效 code -> undefined
{
  assert.equal(keyNameOfCode('InvalidCode'), undefined);
  console.log('✅ keyNameOfCode("InvalidCode") → undefined');
}

// ─── keyEventToSpec ──────────────────────────────────────────────────────

// 19. 单键：Tab
{
  const event = { key: 'Tab', code: 'Tab', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), 'Tab');
  console.log('✅ keyEventToSpec(Tab) → "Tab"');
}

// 20. 修饰键组合：Alt+S
{
  const event = { key: 's', code: 'KeyS', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), 'Alt+S');
  console.log('✅ keyEventToSpec(Alt+S) → "Alt+S"');
}

// 21. 修饰键组合：Ctrl+Enter
{
  const event = { key: 'Enter', code: 'Enter', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), 'Ctrl+Enter');
  console.log('✅ keyEventToSpec(Ctrl+Enter) → "Ctrl+Enter"');
}

// 22. 修饰键组合：Shift+Tab
{
  const event = { key: 'Tab', code: 'Tab', altKey: false, ctrlKey: false, metaKey: false, shiftKey: true };
  assert.equal(keyEventToSpec(event), 'Shift+Tab');
  console.log('✅ keyEventToSpec(Shift+Tab) → "Shift+Tab"');
}

// 23. 多修饰键：Ctrl+Alt+S
{
  const event = { key: 's', code: 'KeyS', altKey: true, ctrlKey: true, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), 'Alt+Ctrl+S');
  console.log('✅ keyEventToSpec(Ctrl+Alt+S) → "Alt+Ctrl+S"');
}

// 24. 纯修饰键：Alt -> undefined
{
  const event = { key: 'Alt', code: 'AltLeft', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), undefined);
  console.log('✅ keyEventToSpec(Alt) → undefined（纯修饰键）');
}

// 25. 不支持的键：Delete -> undefined
{
  const event = { key: 'Delete', code: 'Delete', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), undefined);
  console.log('✅ keyEventToSpec(Delete) → undefined（不支持）');
}

console.log('\n✅ keyspec 25 组用例全部通过');
