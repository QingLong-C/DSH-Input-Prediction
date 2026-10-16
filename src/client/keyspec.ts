/**
 * 快捷键规格（spec）与 KeyboardEvent 互转工具。
 *
 * spec 格式：修饰键（按 Alt/Ctrl/Meta/Shift 固定顺序）+ '+' + 主键名，
 * 如 "Tab"、"Alt+Slash"、"Ctrl+Enter"、"Alt+S"、"F2"、"Up"。
 * 主键名集合由 KEY_CODES / keyCodeOf / keyNameOfCode 三者共同定义，
 * 设置卡片的录制端（keyEventToSpec）与幽灵的匹配端（parseAcceptKey）
 * 均引用本模块，保证写入的 spec 一定可被匹配。
 * @module dsh-suggest-ghost/client/keyspec
 */

/** 主键名（小写）-> KeyboardEvent.code 匹配表。 */
export const KEY_CODES: Readonly<Record<string, string>> = {
  tab: 'Tab',
  enter: 'Enter',
  slash: 'Slash',
  space: 'Space',
  comma: 'Comma',
  period: 'Period',
  minus: 'Minus',
  equal: 'Equal',
  semicolon: 'Semicolon',
  quote: 'Quote',
  backquote: 'Backquote',
  backslash: 'Backslash',
  bracketleft: 'BracketLeft',
  bracketright: 'BracketRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

/** 解析 spec 的主键名为 KeyboardEvent.code；支持字母/数字简写（"s" -> "KeyS"）。 */
export function keyCodeOf(spec: string): string | undefined {
  const parts = spec.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const key = parts[parts.length - 1];
  const direct = key === undefined ? undefined : KEY_CODES[key];
  if (direct !== undefined) return direct;
  if (key !== undefined && /^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (key !== undefined && /^[0-9]$/.test(key)) return `Digit${key}`;
  return undefined;
}

/** KeyboardEvent.code -> 主键显示名（keyCodeOf 的逆映射）。 */
export function keyNameOfCode(code: string): string | undefined {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  const arrows: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  };
  if (code in arrows) return arrows[code]!;
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (Object.values(KEY_CODES).includes(code)) return code;
  return undefined;
}

/** 纯修饰键的 event.key 集合（按下时等待后续主键，不成 spec）。 */
const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift', 'Fn', 'FnLock']);

/** 从键盘事件构造规范 spec；纯修饰键或不受支持的主键返回 undefined。 */
export function keyEventToSpec(event: KeyboardEvent): string | undefined {
  if (MODIFIER_KEYS.has(event.key)) return undefined;
  const key = keyNameOfCode(event.code);
  if (key === undefined) return undefined;
  const mods: string[] = [];
  if (event.altKey) mods.push('Alt');
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.metaKey) mods.push('Meta');
  if (event.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}
