window.__ModuleLoader__.load({
	id: "dsh-suggest-ghost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// src/client/history.ts
var normalizeCache = /* @__PURE__ */ new Map();
function clearNormalizeCache() {
  normalizeCache.clear();
}
function normalizeForMatch(text) {
  const cached = normalizeCache.get(text);
  if (cached !== void 0) return cached;
  const result = text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248)).replace(/\u3000/g, " ").toLowerCase().replace(/\s+/g, " ").trim();
  normalizeCache.set(text, result);
  return result;
}
function commonPrefixLength(a, b) {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}
var TIME_TOKEN_RE = /^[+\d].*|^[a-z]+\d+.*|^\d{1,2}:\d{2}.*|^\d+月.*|^\d{1,2}日.*|^[上下]周.*|^今天.*|^明天.*|^后天.*|^今.*|^明.*|^后.*/i;
function stripCommandPrefix(draft) {
  const head = /^\/([A-Za-z][\w-]*)((?:\s+[\s\S]*)?)$/.exec(draft);
  if (head === null) return draft;
  const rest = (head[2] ?? "").replace(/^\s+/, "");
  if (rest === "") return "";
  const firstToken = /^\S+/.exec(rest);
  if (firstToken === null) return rest;
  if (TIME_TOKEN_RE.test(firstToken[0])) {
    return rest.slice(firstToken[0].length).replace(/^\s+/, "");
  }
  return rest;
}
var HISTORY_WEIGHTS = {
  /** 新近度（0–1，最新≈1）；跨会话候选固定 0。 */
  recency: 1,
  /** 会话内出现次数 / 候选内最大次数（0–1）。 */
  localFreq: 0.45,
  /** 全局热度频次 / 热度表最大频次（0–1；无热度信号时为 0）。 */
  hotFreq: 0.3,
  /** 后缀信息量：min(后缀长, 60) / 60，偏好有内容的补全而非 1 字符碎片。 */
  suffixLen: 0.1
};
var SUFFIX_LEN_CAP = 60;
function historySuggestion(history, draft, opts = { minChars: 1, maxEntries: 0 }) {
  const normDraft = normalizeForMatch(draft);
  if (normDraft === "" || normDraft.length < opts.minChars) return void 0;
  const entries = opts.maxEntries > 0 ? history.slice(-opts.maxEntries) : history;
  const byNorm = /* @__PURE__ */ new Map();
  entries.forEach((raw, idx) => {
    const norm = normalizeForMatch(raw);
    if (norm === "") return;
    const prev = byNorm.get(norm);
    if (prev === void 0) {
      byNorm.set(norm, { text: raw, norm, bestIdx: idx, localCount: 1 });
    } else {
      prev.localCount += 1;
      if (idx > prev.bestIdx) {
        prev.bestIdx = idx;
        prev.text = raw;
      }
    }
  });
  if (opts.extraCandidates !== void 0) {
    for (const item of opts.extraCandidates) {
      const norm = normalizeForMatch(item.text);
      if (norm === "" || byNorm.has(norm)) continue;
      byNorm.set(norm, { text: item.text, norm, bestIdx: -1, localCount: 0 });
    }
  }
  let maxLocal = 0;
  for (const c of byNorm.values()) if (c.localCount > maxLocal) maxLocal = c.localCount;
  let maxHot = 0;
  if (opts.hotCounts !== void 0) {
    for (const h of opts.hotCounts.values()) if (h > maxHot) maxHot = h;
  }
  let best;
  let bestScore = 0;
  let bestRecency = -1;
  for (const c of byNorm.values()) {
    if (c.norm === normDraft) continue;
    if (!c.norm.startsWith(normDraft)) continue;
    const recency = c.bestIdx < 0 ? 0 : (c.bestIdx + 1) / Math.max(entries.length, 1);
    const localFreq = maxLocal > 0 ? c.localCount / maxLocal : 0;
    const hotCount = opts.hotCounts?.get(c.norm) ?? 0;
    const hotFreq = maxHot > 0 ? hotCount / maxHot : 0;
    const suffixLen = Math.min(Math.max(c.norm.length - normDraft.length, 0), SUFFIX_LEN_CAP) / SUFFIX_LEN_CAP;
    const score = HISTORY_WEIGHTS.recency * recency + HISTORY_WEIGHTS.localFreq * localFreq + HISTORY_WEIGHTS.hotFreq * hotFreq + HISTORY_WEIGHTS.suffixLen * suffixLen;
    if (best === void 0 || score > bestScore || score === bestScore && recency > bestRecency) {
      best = c;
      bestScore = score;
      bestRecency = recency;
    }
  }
  return best?.text;
}

// src/client/chunk.ts
var segmenter;
try {
  const ctor = Intl.Segmenter;
  segmenter = typeof ctor === "function" ? new ctor("zh", { granularity: "word" }) : void 0;
} catch {
  segmenter = void 0;
}
function charClassOf(ch) {
  if (/\s/.test(ch)) return "space";
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) return "cjk";
  if (/[\w]/.test(ch)) return "word";
  return "punct";
}
function nextAcceptChunkFallback(text) {
  if (text === "") return "";
  let i = 0;
  while (i < text.length && charClassOf(text[i]) === "space") i++;
  if (i < text.length) {
    const cls = charClassOf(text[i]);
    let run = 0;
    while (i < text.length && charClassOf(text[i]) === cls) {
      i++;
      run++;
      if (cls === "cjk" && run >= 2) break;
    }
    while (i < text.length && charClassOf(text[i]) === "space") i++;
  }
  return text.slice(0, Math.max(i, 1));
}
function nextAcceptChunk(text) {
  if (text === "") return "";
  if (segmenter === void 0) return nextAcceptChunkFallback(text);
  const parts = [...segmenter.segment(text)];
  let firstWord = 0;
  while (firstWord < parts.length && !parts[firstWord].isWordLike) firstWord++;
  if (firstWord >= parts.length) return text;
  let end = firstWord + 1;
  while (end < parts.length && !parts[end].isWordLike) end++;
  return parts.slice(0, end).map((p) => p.segment).join("");
}

// src/client/keyspec.ts
var KEY_CODES = {
  tab: "Tab",
  enter: "Enter",
  slash: "Slash",
  space: "Space",
  comma: "Comma",
  period: "Period",
  minus: "Minus",
  equal: "Equal",
  semicolon: "Semicolon",
  quote: "Quote",
  backquote: "Backquote",
  backslash: "Backslash",
  bracketleft: "BracketLeft",
  bracketright: "BracketRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`]))
};
function keyCodeOf(spec) {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return void 0;
  const key = parts[parts.length - 1];
  const direct = key === void 0 ? void 0 : KEY_CODES[key];
  if (direct !== void 0) return direct;
  if (key !== void 0 && /^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (key !== void 0 && /^[0-9]$/.test(key)) return `Digit${key}`;
  return void 0;
}
function keyNameOfCode(code) {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  const arrows = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right"
  };
  if (code in arrows) return arrows[code];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (Object.values(KEY_CODES).includes(code)) return code;
  return void 0;
}
var MODIFIER_KEYS = /* @__PURE__ */ new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "Fn", "FnLock"]);
function keyEventToSpec(event) {
  if (MODIFIER_KEYS.has(event.key)) return void 0;
  const key = keyNameOfCode(event.code);
  if (key === void 0) return void 0;
  const mods = [];
  if (event.altKey) mods.push("Alt");
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.metaKey) mods.push("Meta");
  if (event.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

// src/client/settings-card.tsx
var import_react2 = require("react");

// src/client/useGhostT.ts
var import_react = require("react");
var noopSubscribe = () => () => {
};
function useGhostT(locale) {
  const subscribe = (0, import_react.useCallback)(
    (onStoreChange) => locale === void 0 ? noopSubscribe() : locale.subscribe(onStoreChange),
    [locale]
  );
  const getActive = (0, import_react.useCallback)(
    () => locale === void 0 ? "zh" : locale.getSnapshot().active,
    [locale]
  );
  const active = (0, import_react.useSyncExternalStore)(subscribe, getActive, getActive);
  if (active === "en") return "en";
  if (active?.startsWith("zh")) return "zh";
  return "zh";
}

// src/client/styles.ts
var STYLE_ID = "dsh-suggest-ghost-card-css";
var COMPONENTS = [
  /* ==================== 表单根 ==================== */
  /* 裸表单，无卡片容器（对齐官方 SettingsForm） */
  ".sgc-settings-form{display:flex;flex-direction:column}",
  /* ==================== Section 分组 ==================== */
  ".sgc-section{padding:16px 0}",
  ".sgc-section-heading{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}",
  ".sgc-section-fields{display:flex;flex-direction:column}",
  /* 两列并排网格（对齐 dsh-later 的 grid 布局） */
  ".sgc-section-fieldsGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}",
  /* ==================== 字段 ==================== */
  ".sgc-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
  ".sgc-fieldHead{display:flex;align-items:center;gap:8px}",
  ".sgc-label-group{display:flex;align-items:center;gap:4px;flex:1;min-width:0}",
  ".sgc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}",
  /* ==================== 输入框 ==================== */
  ".sgc-input{box-sizing:border-box;width:100%;min-height:36px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}",
  ".sgc-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
  ".sgc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
  ".sgc-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}",
  ".sgc-inputReadOnly{opacity:.6;cursor:not-allowed}",
  /* ==================== 快捷键按钮 ==================== */
  ".sgc-key{box-sizing:border-box;width:100%;appearance:none;font:inherit;text-align:left;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);min-height:36px;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md,8px);padding:0 12px;font-size:13px;line-height:1.5}",
  ".sgc-key:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:none}",
  ".sgc-key:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
  ".sgc-keyCapturing,.sgc-keyCapturing:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
  /* ==================== 帮助按钮 ==================== */
  ".sgc-help-btn{width:24px;height:24px;padding:0;flex:none;display:inline-flex;align-items:center;justify-content:center;background:none;border:none;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-tertiary)}",
  ".sgc-help-btn:hover,.sgc-help-btnOpen{color:var(--dsw-alias-label-secondary)}",
  ".sgc-help-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}",
  /* ==================== 帮助展开区 ==================== */
  ".sgc-help{margin:0;padding:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
  ".sgc-help p{margin:0}",
  /* ==================== Toggle 行（布尔字段） ==================== */
  ".sgc-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px}",
  ".sgc-toggle-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}",
  ".sgc-toggle-switch{position:relative;width:36px;height:20px;flex:none;background:var(--dsw-alias-bg-module-platform);border-radius:999px;cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);border:none;padding:0}",
  '.sgc-toggle-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary)}',
  '.sgc-toggle-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}',
  '.sgc-toggle-switch[aria-checked="true"]::after{transform:translateX(16px)}',
  ".sgc-toggle-switch:disabled{opacity:0.4;cursor:default}",
  ".sgc-toggle-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
  ".sgc-toggle-description{margin:0;padding:0 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
  /* ==================== 只读/策略字段提示 ==================== */
  ".sgc-configOnly{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:11px;line-height:1.4}",
  ".sgc-invalid{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}",
  ".sgc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
  ".sgc-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}",
  /* ==================== 底部操作栏 ==================== */
  ".sgc-footer{justify-content:flex-end;align-items:center;gap:8px;padding-top:16px;display:flex}",
  ".sgc-status{flex:1;min-width:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5}",
  ".sgc-discard,.sgc-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);padding:5px 14px;font-size:13px;line-height:1.5}",
  ".sgc-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:none}",
  ".sgc-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
  ".sgc-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
  ".sgc-save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
  ".sgc-save:disabled,.sgc-discard:disabled{opacity:.4;cursor:default}",
  ".sgc-save:focus-visible,.sgc-discard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
  /* ==================== 热度管理分组 ==================== */
  /* 折叠式 section 标题按钮：外观对齐 .sgc-section-heading（13px/600/primary），可点击展开 */
  ".sgc-sectionBtn{appearance:none;width:100%;font:inherit;background:none;border:0;text-align:left;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5;padding:0}",
  ".sgc-sectionBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}",
  ".sgc-sectionBtnText{min-width:0}",
  ".sgc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".sgc-chevronOpen{transform:rotate(180deg)}",
  ".sgc-hotList{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;max-height:320px;overflow-y:auto}",
  ".sgc-hotRow{display:flex;align-items:center;gap:8px;padding:6px 10px;min-width:0}",
  ".sgc-hotRow+.sgc-hotRow{border-top:1px solid var(--dsw-alias-border-l2)}",
  ".sgc-hotRow:hover{background:var(--dsw-alias-bg-layer-2)}",
  ".sgc-hotPinFlag{flex:none;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 7px;font-size:11px;font-weight:500;line-height:16px;white-space:nowrap}",
  ".sgc-hotText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}",
  ".sgc-hotCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}",
  ".sgc-hotBtn{flex:none;appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:none;border-radius:6px;padding:2px 8px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary)}",
  ".sgc-hotBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
  ".sgc-hotBtn:disabled{opacity:.4;cursor:default}",
  ".sgc-hotBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
  ".sgc-hotBtnDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
  ".sgc-hotAdd{display:flex;gap:8px;margin-top:8px}",
  ".sgc-hotAdd .sgc-input{flex:1;min-width:0;min-height:30px;height:30px;font-size:12px}",
  ".sgc-hotMeta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0 0}",
  ".sgc-hotDanger{color:var(--dsw-alias-state-error-primary)}"
].join("\n");
function injectStyles() {
  if (typeof document === "undefined") return () => void 0;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) {
    return () => void 0;
  }
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-suggest-ghost";
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = COMPONENTS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}

// src/client/settings-card.tsx
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var GHOST_FIELDS = [
  // —— LLM 下一条建议 ——
  {
    key: "maxInputBytes",
    label: { zh: "\u8F93\u5165\u5B57\u8282\u4E0A\u9650", en: "Input byte cap" },
    hint: {
      zh: "\u6700\u7EC8\u6846\u67B6\u5316\u7528\u6237\u63D0\u793A\u7684\u6700\u5927 UTF-8 \u5B57\u8282\u6570",
      en: "Max UTF-8 bytes of the final framed user prompt"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxOutputTokens",
    label: { zh: "\u8F93\u51FA\u4EE4\u724C\u4E0A\u9650", en: "Output token cap" },
    hint: {
      zh: "\u5EFA\u8BAE\u751F\u6210\u7684\u6700\u5927\u8F93\u51FA token\uFF08\u63A8\u7406\u6A21\u578B\u7559\u8DB3\u9884\u7B97\uFF0C\u5982 512\uFF09",
      en: "Max output tokens per suggestion (leave headroom for reasoning models, e.g. 512)"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxSuggestionChars",
    label: { zh: "\u5EFA\u8BAE\u5B57\u7B26\u4E0A\u9650", en: "Suggestion character cap" },
    hint: { zh: "\u5E7D\u7075\u6587\u672C\u53EF\u89C1\u5B57\u7B26\u6570\u4E0A\u9650", en: "Max visible characters of the ghost text" },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxRecentTurns",
    label: { zh: "\u53C2\u8003\u56DE\u5408\u6570", en: "Recent turns referenced" },
    hint: {
      zh: "\u8F6C\u5F55\u5C3E\u90E8\u4FDD\u7559\u7684\u6700\u8FD1\u5B8C\u6210\u56DE\u5408\u6570\uFF08\u9ED8\u8BA4 3\uFF1B\u65E7\u56DE\u5408\u7531\u300C\u957F\u4F1A\u8BDD\u6458\u8981\u300D\u4FDD\u7559\u5173\u952E\u4FE1\u606F\uFF09",
      en: "Completed turns kept from the transcript tail (default 3; older turns preserved via summary)"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxTranscriptChars",
    label: { zh: "\u8F6C\u5F55\u5B57\u7B26\u9884\u7B97", en: "Transcript character budget" },
    hint: {
      zh: "\u53D1\u9001\u7ED9\u5EFA\u8BAE\u6A21\u578B\u7684\u8F6C\u5F55\u5B57\u7B26\u4E0A\u9650",
      en: "Max transcript characters sent to the suggestion model"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "contextSummaryEnabled",
    label: { zh: "\u957F\u4F1A\u8BDD\u6458\u8981", en: "Long session summary" },
    hint: {
      zh: "\u5F00\u542F\u540E\uFF0C\u88AB\u88C1\u526A\u7684\u65E7\u6D88\u606F\u4F1A\u63D0\u53D6\u6458\u8981\u4FDD\u7559\u5173\u952E\u4E0A\u4E0B\u6587\uFF08\u96F6\u989D\u5916 LLM \u6210\u672C\uFF09",
      en: "When on, trimmed old messages are summarized to preserve key context (zero extra LLM cost)"
    },
    kind: "boolean",
    section: "llm",
    writable: true
  },
  {
    key: "contextSummaryChars",
    label: { zh: "\u6458\u8981\u5B57\u7B26\u9884\u7B97", en: "Summary character budget" },
    hint: {
      zh: "\u4E0A\u4E0B\u6587\u6458\u8981\u7684\u6700\u5927\u5B57\u7B26\u6570\uFF08\u4EC5\u957F\u4F1A\u8BDD\u6458\u8981\u5F00\u542F\u65F6\u751F\u6548\uFF09",
      en: "Max characters for the context summary (only when long session summary is on)"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "timeoutMs",
    label: { zh: "\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", en: "Timeout (ms)" },
    hint: {
      zh: "\u8F85\u52A9 LLM \u8BF7\u6C42\u7AEF\u5230\u7AEF\u622A\u6B62\u65F6\u95F4",
      en: "End-to-end deadline for the auxiliary LLM request"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "acceptKey",
    label: { zh: "\u91C7\u7EB3\u5FEB\u6377\u952E", en: "Accept shortcut" },
    hint: {
      zh: "\u70B9\u51FB\u540E\u6309\u4E0B\u7EC4\u5408\u952E\uFF1B\u652F\u6301 Tab\u3001\u5B57\u6BCD/\u6570\u5B57\u3001F1-F12\u3001\u65B9\u5411\u952E\u7B49\uFF08\u4E24\u4E2A\u529F\u80FD\u5171\u7528\uFF09",
      en: "Click, then press a key combo; supports Tab, letters/digits, F1-F12, arrows, etc. (shared by both features)"
    },
    kind: "key",
    section: "llm",
    writable: true
  },
  {
    key: "llmEnabled",
    label: { zh: "\u542F\u7528 LLM \u5EFA\u8BAE", en: "Enable LLM suggestions" },
    hint: {
      zh: "\u5173\u95ED\u540E\u6BCF\u56DE\u5408\u4E0D\u518D\u8C03\u7528\u5EFA\u8BAE\u6A21\u578B\uFF08\u7701 token\uFF09\uFF1B\u5386\u53F2\u524D\u7F00\u8865\u5168\u4E0E\u70ED\u5EA6\u4E0D\u53D7\u5F71\u54CD",
      en: "When off, no suggestion model call per turn (saves tokens); history completion and hotness are unaffected"
    },
    kind: "boolean",
    section: "llm",
    writable: true
  },
  {
    key: "provider",
    label: { zh: "Provider", en: "Provider" },
    hint: {
      zh: "\u663E\u5F0F\u8DEF\u7531\uFF1B\u7559\u7A7A\u7EE7\u627F\u4E3B\u8BF7\u6C42\u8DEF\u7531",
      en: "Explicit routing; leave empty to inherit the main request route"
    },
    kind: "text",
    section: "llm",
    writable: true
  },
  {
    key: "model",
    label: { zh: "Model", en: "Model" },
    hint: {
      zh: "\u663E\u5F0F\u8DEF\u7531\uFF1B\u7559\u7A7A\u7EE7\u627F\u4E3B\u8BF7\u6C42\u8DEF\u7531",
      en: "Explicit routing; leave empty to inherit the main request route"
    },
    kind: "text",
    section: "llm",
    writable: true
  },
  // —— 历史前缀补全 ——
  {
    key: "historyEnabled",
    label: { zh: "\u542F\u7528\u5386\u53F2\u8865\u5168", en: "Enable history completion" },
    hint: {
      zh: "\u8349\u7A3F\u975E\u7A7A\u65F6\u6309\u5386\u53F2\u6D88\u606F\u524D\u7F00\u8865\u5168\uFF08\u6253\u5206\u5236\uFF1A\u6700\u8FD1\u4F18\u5148 + \u9891\u6B21/\u70ED\u5EA6\u52A0\u6743\uFF09",
      en: "Completes the draft from history-message prefixes while typing (scored: recency first, weighted by frequency/heat)"
    },
    kind: "boolean",
    section: "history",
    writable: true
  },
  {
    key: "historyCrossSession",
    label: { zh: "\u8DE8\u4F1A\u8BDD\u641C\u7D22", en: "Cross-session search" },
    hint: {
      zh: "\u5173=\u5019\u9009\u4EC5\u5F53\u524D\u4F1A\u8BDD\uFF1B\u5F00=\u5E76\u5165\u5176\u4ED6\u4F1A\u8BDD\u7684\u9AD8\u9891\u5386\u53F2\u3002\u70ED\u5EA6\u9891\u6B21\u6253\u5206\u4E0D\u53D7\u6B64\u5F00\u5173\u5F71\u54CD",
      en: "Off = candidates from this session only; on = merge frequent history from other sessions. Hotness frequency scoring is unaffected by this switch"
    },
    kind: "boolean",
    section: "history",
    writable: true
  },
  {
    key: "historyMaxEntries",
    label: { zh: "\u6700\u5927\u5386\u53F2\u6761\u76EE", en: "Max history entries" },
    hint: {
      zh: "\u6700\u591A\u53C2\u8003\u7684\u5386\u53F2\u6761\u76EE\u6570\uFF080 = \u4E0D\u9650\uFF09",
      en: "How many history entries to consider at most (0 = unlimited)"
    },
    kind: "number",
    section: "history",
    writable: true
  },
  {
    key: "historyMinChars",
    label: { zh: "\u6700\u5C11\u8F93\u5165\u5B57\u7B26", en: "Minimum typed characters" },
    hint: {
      zh: "\u8349\u7A3F\u8F93\u5165\u591A\u5C11\u5B57\u7B26\u540E\u624D\u89E6\u53D1\u8865\u5168\uFF08\u907F\u514D\u8FC7\u65E9\u5F39\u6846\uFF09",
      en: "How many characters must be typed before completion kicks in (avoids popping up too early)"
    },
    kind: "number",
    section: "history",
    writable: true
  },
  {
    key: "wordAccept",
    label: { zh: "\u9010\u8BCD\u91C7\u7EB3", en: "Word-by-word accept" },
    hint: {
      zh: "\u5E7D\u7075\u663E\u793A\u65F6\u6309 \u2192 \u6BCF\u6B21\u91C7\u7EB3\u4E00\u4E2A\u8BCD\uFF08\u4E2D\u6587\u6309\u8BCD\u5178\u5206\u8BCD\uFF09\uFF1BTab \u59CB\u7EC8\u6574\u6761\u91C7\u7EB3\u3002\u5BF9\u4E24\u79CD\u5EFA\u8BAE\u6A21\u5F0F\u90FD\u751F\u6548",
      en: "While the ghost shows, \u2192 accepts one word at a time (Chinese segments via dictionary); Tab always accepts the whole text. Applies to both suggestion modes"
    },
    kind: "boolean",
    section: "history",
    writable: true
  },
  // —— 停顿续写 ——
  {
    key: "inlineEnabled",
    label: { zh: "\u505C\u987F\u7EED\u5199", en: "Pause completion" },
    hint: {
      zh: "\u8F93\u5165\u505C\u987F\u540E\u7531 LLM \u7EED\u5199\u8349\u7A3F\uFF08\u5386\u53F2\u8865\u5168\u672A\u547D\u4E2D\u65F6\u751F\u6548\uFF09",
      en: "LLM continues the draft after a typing pause (when history completion misses)"
    },
    kind: "boolean",
    section: "inline",
    writable: true
  },
  {
    key: "inlineDelayMs",
    label: { zh: "\u505C\u987F\u65F6\u957F", en: "Pause duration" },
    hint: {
      zh: "\u505C\u6B62\u8F93\u5165\u591A\u4E45\u540E\u89E6\u53D1\u7EED\u5199\uFF08\u6BEB\u79D2\uFF09",
      en: "How long to pause before triggering completion (ms)"
    },
    kind: "number",
    section: "inline",
    writable: true
  },
  {
    key: "inlineMinChars",
    label: { zh: "\u6700\u5C11\u8F93\u5165\u5B57\u7B26", en: "Minimum typed characters" },
    hint: {
      zh: "\u8349\u7A3F\u8F93\u5165\u591A\u5C11\u5B57\u7B26\u540E\u624D\u89E6\u53D1\u7EED\u5199",
      en: "How many characters must be typed before completion triggers"
    },
    kind: "number",
    section: "inline",
    writable: true
  },
  {
    key: "inlineMaxChars",
    label: { zh: "\u7EED\u5199\u957F\u5EA6\u4E0A\u9650", en: "Completion length cap" },
    hint: {
      zh: "\u7EED\u5199\u53EF\u89C1\u5B57\u7B26\u4E0A\u9650\uFF08\u8D85\u51FA\u6309\u8BCD\u8FB9\u754C\u622A\u65AD\uFF09",
      en: "Max visible characters of the completion (truncated at word boundary)"
    },
    kind: "number",
    section: "inline",
    writable: true
  },
  // —— 语言设置 ——
  {
    key: "languageMode",
    label: { zh: "\u5EFA\u8BAE\u8BED\u8A00", en: "Suggestion language" },
    hint: {
      zh: "\u81EA\u52A8\uFF1A\u7ED3\u5408\u754C\u9762\u8BED\u8A00\u4E0E\u6D88\u606F\u5185\u5BB9\u63A8\u65AD\uFF1B\u6307\u5B9A\uFF1A\u59CB\u7EC8\u4F7F\u7528\u6240\u9009\u8BED\u8A00",
      en: "Auto: infer from UI locale and message content; Specified: always use the selected language"
    },
    kind: "select",
    section: "language",
    writable: true,
    options: [
      { value: "auto", label: { zh: "\u81EA\u52A8", en: "Auto" } },
      { value: "zh", label: { zh: "\u7B80\u4F53\u4E2D\u6587", en: "Simplified Chinese" } },
      { value: "zh-TW", label: { zh: "\u7E41\u9AD4\u4E2D\u6587", en: "Traditional Chinese" } },
      { value: "en", label: { zh: "English", en: "English" } },
      { value: "ja", label: { zh: "\u65E5\u672C\u8A9E", en: "Japanese" } },
      { value: "ko", label: { zh: "\uD55C\uAD6D\uC5B4", en: "Korean" } },
      { value: "ru", label: { zh: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439", en: "Russian" } },
      { value: "fr", label: { zh: "Fran\xE7ais", en: "French" } },
      { value: "de", label: { zh: "Deutsch", en: "German" } },
      { value: "es", label: { zh: "Espa\xF1ol", en: "Spanish" } }
    ]
  },
  {
    key: "uiLocaleWeight",
    label: { zh: "\u754C\u9762\u8BED\u8A00\u6743\u91CD", en: "UI language weight" },
    hint: {
      zh: "\u81EA\u52A8\u6A21\u5F0F\u4E0B\u754C\u9762\u8BED\u8A00\u7684\u5F71\u54CD\u529B\uFF080-500\uFF09\uFF1B\u503C\u8D8A\u5927\u8D8A\u503E\u5411\u754C\u9762\u8BED\u8A00\uFF0C0 = \u5B8C\u5168\u5FFD\u7565\u754C\u9762\u8BED\u8A00",
      en: "Influence of the UI locale in auto mode (0-500); higher = stronger preference for UI language, 0 = ignore UI locale entirely"
    },
    kind: "number",
    section: "language",
    writable: true
  }
];
var zhStrings = {
  /** 只读提示 */
  readOnly: "\u5F53\u524D\u90E8\u7F72\u4E0D\u53EF\u5199\uFF08\u5185\u5B58\u6A21\u5F0F\uFF09",
  /** 策略字段（非 volatile）只能改配置文件 */
  configOnly: "\u7B56\u7565\u5B57\u6BB5\uFF1Ahost \u7AEF\u672A\u5F00\u653E\u5199\u5165\uFF0C\u8BF7\u6539 cordis.patch.yml",
  /** 显示设置 section（仅详情页显示） */
  sectionDisplay: "\u663E\u793A\u8BBE\u7F6E",
  showInSettings: "\u5728\u8BBE\u7F6E\u4E2D\u663E\u793A",
  showInSettingsHint: "\u5728\u8BBE\u7F6E\u5BF9\u8BDD\u6846\u4E2D\u663E\u793A\u672C\u63D2\u4EF6\u7684\u8BBE\u7F6E\u9875\uFF08\u5237\u65B0\u9875\u9762\u540E\u751F\u6548\uFF09",
  /** 分组标题 */
  sectionLlm: "LLM \u4E0B\u4E00\u6761\u5EFA\u8BAE",
  sectionHistory: "\u5386\u53F2\u524D\u7F00\u8865\u5168",
  sectionInline: "\u505C\u987F\u7EED\u5199",
  sectionLanguage: "\u8BED\u8A00\u8BBE\u7F6E",
  /** 帮助按钮无障碍标签（label 为字段名） */
  helpFor: (label) => `${label}\u8BF4\u660E`,
  /** footer 状态与按钮 */
  saved: "\u5DF2\u4FDD\u5B58",
  discard: "\u653E\u5F03\u4FEE\u6539",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  save: "\u4FDD\u5B58",
  /** 数字字段校验错误 */
  invalidNumber: "\u8BF7\u8F93\u5165\u6570\u5B57",
  /** 快捷键控件 */
  keyCapturing: "\u6309\u4E0B\u7EC4\u5408\u952E\u2026\uFF08Esc \u53D6\u6D88\uFF09",
  keyEmpty: "\u70B9\u51FB\u8BBE\u7F6E\u5FEB\u6377\u952E",
  // —— 热度管理 ——
  sectionHotness: "\u70ED\u5EA6\u7BA1\u7406\uFF08\u8DE8\u4F1A\u8BDD\u9AD8\u9891\u77ED\u8BED\uFF09",
  hotHint: "\u5373\u65F6\u751F\u6548\uFF0C\u65E0\u9700\u4FDD\u5B58\u3002\u5220\u9664\u53EA\u6E05\u5F53\u524D\u7EDF\u8BA1\uFF08\u518D\u6B21\u8F93\u5165\u4F1A\u91CD\u65B0\u8BA1\u5165\uFF09\uFF1B\u56FA\u5B9A\u540E\u4E0D\u53C2\u4E0E\u6DD8\u6C70\u3001\u8DE8\u4F1A\u8BDD\u5019\u9009\u6052\u7F6E\u9876\u3002",
  hotSearch: "\u5728\u4E0B\u65B9\u5217\u8868\u4E2D\u8FC7\u6EE4\u2026",
  hotEmpty: "\u6682\u65E0\u70ED\u5EA6\u6761\u76EE\u2014\u2014\u6B63\u5E38\u4F7F\u7528\u51E0\u4E2A\u56DE\u5408\u540E\u81EA\u52A8\u7D2F\u79EF\u3002",
  hotNoMatch: "\u6CA1\u6709\u5339\u914D\u7684\u6761\u76EE\uFF08\u4EC5\u8FC7\u6EE4\u5F53\u524D\u663E\u793A\u7684 top-K\uFF09\u3002",
  hotAdd: "\u6DFB\u52A0",
  hotAddPlaceholder: "\u624B\u5DE5\u65B0\u589E\u4E00\u6761\u5019\u9009\u77ED\u8BED\u2026",
  hotPin: "\u56FA\u5B9A",
  hotUnpin: "\u53D6\u6D88\u56FA\u5B9A",
  hotPinnedBadge: "\u5DF2\u56FA\u5B9A",
  hotDelete: "\u5220\u9664",
  hotClear: "\u6E05\u7A7A\u5168\u90E8",
  hotClearConfirm: "\u786E\u8BA4\u6E05\u7A7A\uFF1F",
  hotMeta: (total, shown) => total > shown ? `\u5171 ${total} \u6761\uFF0C\u663E\u793A\u70ED\u5EA6\u6700\u9AD8\u7684 ${shown} \u6761` : `\u5171 ${total} \u6761`
};
var enStrings = {
  readOnly: "Not writable in this deployment (in-memory mode)",
  configOnly: "Strategy field: not writable from the UI \u2014 edit cordis.patch.yml",
  sectionDisplay: "Display",
  showInSettings: "Show in settings",
  showInSettingsHint: "Show this plugin's settings page in the settings dialog (refresh to take effect)",
  sectionLlm: "LLM next suggestion",
  sectionHistory: "History prefix completion",
  sectionInline: "Pause completion",
  sectionLanguage: "Language settings",
  helpFor: (label) => `About ${label}`,
  saved: "Saved",
  discard: "Discard changes",
  saving: "Saving\u2026",
  save: "Save",
  invalidNumber: "Enter a number",
  keyCapturing: "Press a key combo\u2026 (Esc to cancel)",
  keyEmpty: "Click to set a shortcut",
  // —— Hotness management ——
  sectionHotness: "Hotness management (frequent cross-session phrases)",
  hotHint: "Takes effect immediately, no save needed. Delete only clears the current tally (typing it again re-counts); pinned entries are exempt from eviction and always lead cross-session candidates.",
  hotSearch: "Filter the list below\u2026",
  hotEmpty: "No entries yet \u2014 they accumulate automatically after a few turns of normal use.",
  hotNoMatch: "No matching entries (filters the displayed top-K only).",
  hotAdd: "Add",
  hotAddPlaceholder: "Manually add a candidate phrase\u2026",
  hotPin: "Pin",
  hotUnpin: "Unpin",
  hotPinnedBadge: "Pinned",
  hotDelete: "Delete",
  hotClear: "Clear all",
  hotClearConfirm: "Confirm clear?",
  hotMeta: (total, shown) => total > shown ? `${total} total, showing the top ${shown} by heat` : `${total} total`
};
var GHOST_STRINGS = { zh: zhStrings, en: enStrings };
function displayValue(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  return v === void 0 || v === null ? "" : String(v);
}
function KeyField({ id, value, disabled, t, onChange }) {
  const [capturing, setCapturing] = (0, import_react2.useState)(false);
  (0, import_react2.useEffect)(() => {
    if (!capturing) return;
    const onKey = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(false);
        return;
      }
      const spec = keyEventToSpec(event);
      if (spec !== void 0) {
        onChange(spec);
        setCapturing(false);
      }
    };
    const cancel = () => setCapturing(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    };
  }, [capturing, onChange]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      id,
      className: capturing ? "sgc-key sgc-keyCapturing" : "sgc-key",
      disabled,
      onClick: () => setCapturing((c) => !c),
      children: capturing ? t.keyCapturing : value === "" ? t.keyEmpty : value
    }
  );
}
function HotnessSection({ scope, pushRaw, writable, busy, lang, t, uiLocale }) {
  const [search, setSearch] = (0, import_react2.useState)("");
  const [adding, setAdding] = (0, import_react2.useState)("");
  const [confirmClear, setConfirmClear] = (0, import_react2.useState)(false);
  const opsRev = (0, import_react2.useRef)(0);
  (0, import_react2.useEffect)(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 3e3);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);
  const disabled = !writable || busy;
  let hot = [];
  let total = 0;
  if (typeof pushRaw === "string" && pushRaw !== "" && pushRaw !== "null") {
    try {
      const parsed = JSON.parse(pushRaw);
      if (Array.isArray(parsed.hot)) hot = parsed.hot;
      if (typeof parsed.total === "number") total = parsed.total;
    } catch {
    }
  }
  if (!Number.isFinite(total) || total < hot.length) total = hot.length;
  const sendOps = (ops) => {
    if (!writable) return;
    opsRev.current += 1;
    const payload = { rev: opsRev.current, ops };
    if (uiLocale) payload.locale = uiLocale;
    void scope.set("_ops", JSON.stringify(payload));
  };
  const needle = search.trim().toLowerCase();
  const visible = needle === "" ? hot : hot.filter((entry) => entry.text.toLowerCase().includes(needle));
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-hint", children: t.hotHint }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        className: "sgc-input",
        type: "text",
        "aria-label": t.hotSearch,
        placeholder: t.hotSearch,
        value: search,
        disabled,
        onChange: (e) => setSearch(e.target.value)
      }
    ),
    hot.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-hint", children: t.hotEmpty }) : visible.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-hint", children: t.hotNoMatch }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-hotList", role: "list", children: visible.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-hotRow", role: "listitem", children: [
      entry.pinned === true && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-hotPinFlag", children: t.hotPinnedBadge }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-hotText", title: entry.text, children: entry.text }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "sgc-hotCount", children: [
        "\xD7",
        entry.count
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "sgc-hotBtn",
          disabled,
          onClick: () => sendOps([{ op: "pin", text: entry.text, pinned: entry.pinned !== true }]),
          children: entry.pinned === true ? t.hotUnpin : t.hotPin
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "sgc-hotBtn sgc-hotBtnDanger",
          disabled,
          onClick: () => sendOps([{ op: "delete", text: entry.text }]),
          children: t.hotDelete
        }
      )
    ] }, entry.text)) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-hotAdd", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          className: "sgc-input",
          type: "text",
          "aria-label": t.hotAddPlaceholder,
          placeholder: t.hotAddPlaceholder,
          value: adding,
          disabled,
          onChange: (e) => setAdding(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter" && adding.trim() !== "" && !disabled) {
              sendOps([{ op: "add", text: adding.trim(), pinned: true }]);
              setAdding("");
            }
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "sgc-hotBtn",
          disabled: disabled || adding.trim() === "",
          onClick: () => {
            sendOps([{ op: "add", text: adding.trim(), pinned: true }]);
            setAdding("");
          },
          children: t.hotAdd
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-hotMeta", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-hint", children: t.hotMeta(total, hot.length) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: `sgc-hotBtn sgc-hotBtnDanger${confirmClear ? " sgc-hotConfirming" : ""}`,
          disabled: disabled || hot.length === 0,
          onClick: () => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            setConfirmClear(false);
            sendOps([{ op: "clear" }]);
          },
          children: confirmClear ? t.hotClearConfirm : t.hotClear
        }
      )
    ] })
  ] });
}
function SuggestGhostCard({ scope, locale, surface }) {
  (0, import_react2.useEffect)(() => injectStyles(), []);
  const lang = useGhostT(locale);
  const t = GHOST_STRINGS[lang];
  const [snap, setSnap] = (0, import_react2.useState)(scope.getSnapshot());
  (0, import_react2.useEffect)(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  const [edits, setEdits] = (0, import_react2.useState)({});
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [saved, setSaved] = (0, import_react2.useState)(false);
  const [helpOpen, setHelpOpen] = (0, import_react2.useState)({});
  const [hotOpen, setHotOpen] = (0, import_react2.useState)(false);
  const SHOW_SETTINGS_KEY = "dsh-suggest-ghost:show-settings-section";
  const [showSettings, setShowSettings] = (0, import_react2.useState)(() => {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(SHOW_SETTINGS_KEY) === "true";
  });
  const toggleShowSettings = () => {
    const next = !showSettings;
    setShowSettings(next);
    if (typeof localStorage !== "undefined") {
      if (next) localStorage.setItem(SHOW_SETTINGS_KEY, "true");
      else localStorage.removeItem(SHOW_SETTINGS_KEY);
    }
  };
  if (snap.status === "unavailable") return null;
  const value = snap.value ?? {};
  const writable = snap.writable && snap.status === "ready";
  const isDirty = Object.keys(edits).some((k) => GHOST_FIELDS.find((f) => f.key === k)?.writable === true);
  const fieldValue = (key) => {
    if (key in edits) return String(edits[key]);
    return displayValue(value[key]);
  };
  const fieldInvalid = (f) => {
    if (f.kind !== "number" || !(f.key in edits)) return false;
    const raw = String(edits[f.key]).trim();
    return raw === "" || Number.isNaN(Number(raw));
  };
  const anyInvalid = GHOST_FIELDS.some(fieldInvalid);
  const setField = (key, raw) => {
    setEdits((prev) => ({ ...prev, [key]: raw }));
  };
  const save = async () => {
    if (anyInvalid) return;
    setBusy(true);
    try {
      for (const [key, raw] of Object.entries(edits)) {
        const def = GHOST_FIELDS.find((f) => f.key === key);
        if (!def.writable) continue;
        let final = raw;
        if (def.kind === "number") final = Number(raw);
        else if (def.kind === "boolean") final = raw === true || raw === "true";
        else if (def.kind === "key") {
          const trimmed = String(raw).trim();
          if (trimmed === "") continue;
          final = trimmed;
        }
        await scope.set(key, final);
      }
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2e3);
    } finally {
      setBusy(false);
    }
  };
  const discard = () => setEdits({});
  const renderField = (f) => {
    const invalid = fieldInvalid(f);
    const editable = writable && f.writable;
    const fieldId = `sgc-field-${f.key}`;
    const helpId = `sgc-help-${f.key}`;
    const helpOpenNow = helpOpen[f.key] === true;
    const helpAria = t.helpFor(f.label[lang]);
    if (f.kind === "boolean") {
      const checked = fieldValue(f.key) === "true";
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-toggle-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-label-group", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "sgc-toggle-label", htmlFor: fieldId, children: f.label[lang] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              id: fieldId,
              role: "switch",
              "aria-checked": checked,
              "aria-label": f.label[lang],
              className: "sgc-toggle-switch",
              disabled: !editable || busy,
              onClick: () => setField(f.key, !checked)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: invalid ? "sgc-invalid" : "sgc-toggle-description", children: invalid ? t.invalidNumber : f.hint[lang] }),
        !f.writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-configOnly", children: t.configOnly })
      ] }, f.key);
    }
    const inputClass = [
      invalid ? "sgc-input sgc-inputInvalid" : "sgc-input",
      f.writable ? "" : "sgc-inputReadOnly"
    ].filter(Boolean).join(" ");
    const control = f.kind === "key" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      KeyField,
      {
        id: fieldId,
        value: fieldValue(f.key),
        disabled: !editable || busy,
        t,
        onChange: (spec) => setField(f.key, spec)
      }
    ) : f.kind === "select" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "select",
      {
        className: inputClass,
        id: fieldId,
        value: fieldValue(f.key),
        disabled: !editable || busy,
        onChange: (e) => setField(f.key, e.target.value),
        children: (f.options ?? []).map((opt) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: opt.value, children: opt.label[lang] }, opt.value))
      }
    ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        className: inputClass,
        id: fieldId,
        type: "text",
        ...f.kind === "number" ? { inputMode: "numeric" } : {},
        ...invalid ? { "aria-invalid": true } : {},
        value: fieldValue(f.key),
        disabled: !editable || busy,
        onChange: (e) => setField(f.key, e.target.value)
      }
    );
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-field", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-fieldHead", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-label-group", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "sgc-label", htmlFor: fieldId, children: f.label[lang] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            className: helpOpenNow ? "sgc-help-btn sgc-help-btnOpen" : "sgc-help-btn",
            "aria-label": helpAria,
            "aria-expanded": helpOpenNow,
            "aria-controls": helpId,
            onClick: () => setHelpOpen((prev) => ({ ...prev, [f.key]: !helpOpenNow })),
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconInfoOutlineRegular, { size: 12 })
          }
        )
      ] }) }),
      control,
      invalid && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-invalid", role: "status", children: t.invalidNumber }),
      helpOpenNow && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { id: helpId, role: "region", "aria-label": helpAria, className: "sgc-help", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: f.hint[lang] }) }),
      !f.writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-configOnly", children: t.configOnly })
    ] }, f.key);
  };
  const llmFields = GHOST_FIELDS.filter((f) => f.section === "llm");
  const historyFields = GHOST_FIELDS.filter((f) => f.section === "history");
  const inlineFields = GHOST_FIELDS.filter((f) => f.section === "inline");
  const languageFields = GHOST_FIELDS.filter((f) => f.section === "language");
  const SECTION_LAYOUT = {
    llm: "stack",
    history: "stack",
    inline: "stack",
    language: "grid"
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-settings-form", children: [
    !writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-readOnly", role: "status", children: t.readOnly }),
    surface === "detail" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-display", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-display", children: t.sectionDisplay }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-section-fields", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-toggle-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-label-group", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "sgc-toggle-label", htmlFor: "sgc-show-settings", children: t.showInSettings }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              id: "sgc-show-settings",
              role: "switch",
              "aria-checked": showSettings,
              "aria-label": t.showInSettings,
              className: "sgc-toggle-switch",
              onClick: toggleShowSettings
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-toggle-description", children: t.showInSettingsHint })
      ] }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-llm", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-llm", children: t.sectionLlm }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SECTION_LAYOUT.llm === "grid" ? "sgc-section-fields sgc-section-fieldsGrid" : "sgc-section-fields", children: llmFields.map(renderField) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-history", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-history", children: t.sectionHistory }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SECTION_LAYOUT.history === "grid" ? "sgc-section-fields sgc-section-fieldsGrid" : "sgc-section-fields", children: historyFields.map(renderField) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-inline", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-inline", children: t.sectionInline }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SECTION_LAYOUT.inline === "grid" ? "sgc-section-fields sgc-section-fieldsGrid" : "sgc-section-fields", children: inlineFields.map(renderField) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-language", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-language", children: t.sectionLanguage }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SECTION_LAYOUT.language === "grid" ? "sgc-section-fields sgc-section-fieldsGrid" : "sgc-section-fields", children: languageFields.map(renderField) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-hotness", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "button",
        {
          type: "button",
          id: "sgc-section-hotness",
          className: "sgc-sectionBtn",
          "aria-expanded": hotOpen,
          "aria-controls": "sgc-hotness-body",
          onClick: () => setHotOpen((o) => !o),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-sectionBtnText", children: t.sectionHotness }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: 14, className: hotOpen ? "sgc-chevron sgc-chevronOpen" : "sgc-chevron" })
          ]
        }
      ),
      hotOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { id: "sgc-hotness-body", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        HotnessSection,
        {
          scope,
          pushRaw: value._push,
          writable,
          busy,
          lang,
          t,
          uiLocale: locale?.getSnapshot?.()?.active
        }
      ) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-footer", children: [
      saved && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-status", role: "status", children: t.saved }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "sgc-discard", disabled: !isDirty || busy, onClick: discard, children: t.discard }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "sgc-save", disabled: !writable || busy || !isDirty || anyInvalid, onClick: () => void save(), children: busy ? t.saving : t.save })
    ] })
  ] });
}

// src/client/index.ts
var currentSessionIdOf = (snapshot) => Object.values(snapshot.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id;
function unwrapSettingsDoc(response) {
  let node = response;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof node !== "object" || node === null) return void 0;
    const record = node;
    if (Array.isArray(record.namespaces)) return record;
    if (record.ok === true) {
      node = record.value;
      continue;
    }
    if ("result" in record) {
      node = record.result;
      continue;
    }
    if ("value" in record) {
      node = record.value;
      continue;
    }
    return void 0;
  }
  return void 0;
}
var PROJECTION_KEY = "suggestGhost";
var OVERLAY_ID = "dsh-suggest-ghost-overlay";
var DEFAULT_ACCEPT_KEY = "Tab";
var SETTINGS_NAMESPACE = "suggest-ghost";
var SETTINGS_SECTION_ID = "suggest-ghost";
var SECTION_LABELS = { zh: "\u8F93\u5165\u9884\u6D4B", en: "Input prediction" };
var PULL_MAX_ATTEMPTS = 5;
var PULL_RETRY_BASE_MS = 200;
var name = "dsh-suggest-ghost";
var inject = ["conversation", "sessions", "remote", "remote.settings", "slots", "locale"];
var COMPOSER_SELECTOR = "[data-input-scroll] textarea, [data-input-scroll] [data-composer-input]";
function isComposerElement(el) {
  if (el === null) return false;
  const composer = el.closest("[data-input-scroll]") !== null && (el.matches("textarea") || el instanceof HTMLElement && el.isContentEditable);
  return composer;
}
function isComposerTarget(target) {
  return target instanceof Element && isComposerElement(target);
}
function caretAtComposerEnd(el) {
  if (el instanceof HTMLTextAreaElement) {
    return el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
  }
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return false;
  if (el.textContent === "") return true;
  const range = selection.getRangeAt(0);
  let last = el.lastChild;
  while (last !== null && last.lastChild !== null) last = last.lastChild;
  if (range.endContainer === last) {
    return range.endOffset === (last.textContent?.length ?? 0);
  }
  return range.endContainer === el && range.endOffset === el.childNodes.length;
}
function parseAcceptKey(spec) {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return void 0;
  const mods = new Set(parts.slice(0, -1));
  const keyCode = keyCodeOf(spec);
  if (keyCode === void 0) return void 0;
  return (event) => event.code === keyCode && event.altKey === mods.has("alt") && event.ctrlKey === mods.has("ctrl") && event.metaKey === mods.has("meta") && event.shiftKey === mods.has("shift");
}
var GhostOverlay = class {
  el;
  composer = null;
  /**
   * 滚动容器（`[data-input-scroll]`）。
   *
   * 定位**不用**它（overlay 随内容自动滚动），保留它只为了挂 `scroll` 监听：
   * 滚动会使内容相对视口位移，需要触发一次重对齐与自检。
   */
  scroller = null;
  onScroll;
  onResize;
  styleTag;
  /** 尺寸变化观察者：composer 自动增高/附件行出现/字体回流都会改变内容起点。 */
  resizeObserver = null;
  /** 正在显示的内容（供 ResizeObserver 回调重对齐后重新自检）。 */
  current = null;
  constructor() {
    this.el = document.createElement("div");
    this.el.id = OVERLAY_ID;
    this.el.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "white-space:pre-wrap",
      "word-break:break-word",
      // 不设 overflow:hidden：它会贴着盒子边界裁掉 text-shadow 光晕（明显切割感）；
      // 换行安全已由 pre-wrap + break-word 保证，盒子高度自适应无需纵向裁剪。
      // 对齐官方 composer placeholder 的色阶（label-caption，全透明度），
      // 而非更重的 label-secondary：保证「幽灵」比正文明显更淡。
      "color:var(--dsw-alias-label-caption, #9aa0a6)",
      // 轻微同色泛光（贴身 1px + 8px 柔光晕）：与原生 placeholder 区分，
      // 提示这是「可采纳的建议」而非占位文案；同色晕不改变色相、暗/亮主题通用。
      "text-shadow:0 0 1px var(--dsw-alias-label-caption, #9aa0a6), 0 0 8px var(--dsw-alias-label-caption, #9aa0a6)",
      "z-index:1",
      // 初值：不绘制。用 display（而非旧版的 visibility）——见下方 show()/hide()
      // 与类注释，display 让节点彻底退出渲染，避免任何过渡期双绘。
      "display:none"
    ].join(";");
    this.onScroll = () => this.alignAndVerify();
    this.onResize = () => this.alignAndVerify();
    this.styleTag = document.createElement("style");
    this.styleTag.dataset.pluginCss = "dsh-suggest-ghost";
    this.styleTag.textContent = [
      // ── 让位规则：幽灵**正在显示**时，placeholder 必须让位 ──
      //
      // 判据同时要求 `data-shown="1"` **且** overlay 未被 `display:none` 隐藏。
      // 只写 `data-shown` 不够：`hide()` / 自检失败路径会把 display 置回 none，
      // 若此时仍据 `data-shown` 或「节点存在」去隐藏 placeholder，就会出现
      // 「幽灵没显示、占位文案也没了」——草稿清空后输入框一片空白（实测过）。
      // 反过来只据「节点存在」同样错：节点在首次 show 后就常驻 DOM 不移除。
      //
      // `:not([style*="display: none"])` 读的是内联 style（本插件唯一写 display
      // 的地方），故与自身写入的状态严格同步，无属性时序竞态。
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-placeholder]{display:none!important}',
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) textarea::placeholder{visibility:hidden!important}',
      // 兜底：编辑器自带 data-placeholder 属性的伪元素（部分宿主形态）以及
      // 依赖 `[data-placeholder]` 出文案的 ::before/::after 实现。
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-input][data-placeholder]::before{content:none!important}',
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-input][data-placeholder]::after{content:none!important}'
    ].join("\n");
    if (typeof document !== "undefined") document.head.appendChild(this.styleTag);
  }
  /** 当前绑定的输入框（未绑定时为 null）。 */
  get currentTextarea() {
    return this.composer;
  }
  /** 绑定到当前输入框（若变化则重建对齐）。 */
  attach(composer) {
    if (this.composer === composer) return;
    this.detach();
    this.composer = composer;
    this.scroller = composer.closest("[data-input-scroll]");
    const parent = composer.parentElement;
    if (parent !== null) parent.appendChild(this.el);
    composer.addEventListener("scroll", this.onScroll, { passive: true });
    this.scroller?.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(composer);
      if (this.scroller !== null) this.resizeObserver.observe(this.scroller);
      if (parent !== null) this.resizeObserver.observe(parent);
    }
    this.alignAndVerify();
  }
  detach() {
    if (this.composer !== null) {
      this.composer.removeEventListener("scroll", this.onScroll);
      this.composer = null;
    }
    if (this.scroller !== null) {
      this.scroller.removeEventListener("scroll", this.onScroll);
      this.scroller = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.current = null;
    this.el.dataset.shown = "0";
    this.el.style.display = "none";
    window.removeEventListener("resize", this.onResize);
    this.el.remove();
  }
  /**
   * 对齐 overlay 到输入框内容区（含 padding 起点）。
   *
   * ## 为什么**不做**滚动补偿（实测结论，勿回退）
   *
   * overlay 挂在 `.grow` 上，而 `.grow` 是滚动容器 `[data-input-scroll]` 的**子
   * 节点**——即 overlay 位于「被滚动的内容」坐标系里。滚动容器滚动时 `.grow`
   * 整体一起位移（实测 `scrollTop=120` 时 `.grow` 的 rect.top 同步上移 120），
   * 因此 overlay **自动跟随内容滚动，无需任何 scrollTop 项**。
   *
   * 实测反证（`.grow` 上的探针元素，`scrollTop=120`）：
   *  - `rect 差 - scrollTop` → 幽灵落在 `64`，正文在 `184`：**漂移 `-scrollTop`**；
   *  - `rect 差 + scrollTop` → 幽灵恒定不动，漂移 `+scrollTop`；
   *  - `offsetTop + paddingTop`（**本实现**）→ 与正文逐像素重合（5 个滚动位置全对）。
   *
   * 另注：rect 差在这里恒为 0（`.grow` 与编辑器一起移动、同点），用它会把真实的
   * 内容偏移丢掉；`offsetTop/offsetLeft` 相对 `offsetParent`，与滚动无关，才是
   * 「内容坐标系」里的正确坐标。
   */
  align() {
    const ta = this.composer;
    if (ta === null) return;
    const style = getComputedStyle(ta);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const originLeft = ta.offsetLeft + borderLeft + padLeft;
    const originTop = ta.offsetTop + borderTop + padTop;
    const fullWidth = ta.clientWidth - padLeft - padRight;
    let left = originLeft;
    let top = originTop;
    let width = fullWidth > 0 ? fullWidth : ta.clientWidth;
    const taRect = ta.getBoundingClientRect();
    const originViewportX = taRect.left + borderLeft + padLeft;
    const originViewportY = taRect.top + borderTop + padTop;
    const end = this.current !== null && this.current.kind === "history" ? this.draftEndRect() : null;
    if (end !== null) {
      left = originLeft + (end.right - originViewportX);
      const lineHeight = parseFloat(style.lineHeight);
      const lineOffset = Number.isFinite(lineHeight) && lineHeight > 0 && end.height > 0 ? Math.max(0, (lineHeight - end.height) / 2) : 0;
      top = originTop + (end.top - originViewportY) - lineOffset;
      width = Math.max(0, fullWidth - (left - originLeft));
    }
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.width = `${width}px`;
    const TEXT_LAYOUT_PROPS = [
      "font-family",
      "font-size",
      "font-style",
      "font-variant",
      "font-weight",
      "font-stretch",
      "font-feature-settings",
      "font-kerning",
      "font-variant-ligatures",
      "font-variant-east-asian",
      "font-variant-caps",
      "font-variant-numeric",
      "font-variant-alternates",
      "font-variant-position",
      "font-size-adjust",
      "font-synthesis",
      "font-optical-sizing",
      "line-height",
      "letter-spacing",
      "word-spacing",
      "white-space",
      "overflow-wrap",
      "word-break",
      "tab-size",
      "text-indent",
      "direction",
      "writing-mode",
      "text-rendering",
      "text-size-adjust",
      "-webkit-text-size-adjust",
      "-webkit-font-smoothing",
      "-moz-osx-font-smoothing"
    ];
    for (const prop of TEXT_LAYOUT_PROPS) {
      this.el.style.setProperty(prop, style.getPropertyValue(prop));
    }
    this.el.style.boxSizing = "border-box";
  }
  /**
   * 对齐后做几何自检：定位明显失真时宁可不显示，也绝不糊在正文上。
   *
   * ## 判据（依据实测，不是推测）
   *
   * overlay 是 `.grow` 的子节点，随内容一起滚动——所以「幽灵跑到滚动视口外」是
   * **正常且正确**的（正文也一起滚出去了，被滚动容器裁掉）。因此**不能**用
   * 「必须落在滚动视口内」当判据：实测 `scrollTop=384` 时幽灵与正文同在
   * `top=-80`，两者都被裁掉，这是正确的。
   *
   * 真正要防的是**定位失真**：overlay 没有落在编辑器内容原点上（例如宿主要
   * 在 `.grow` 与编辑器之间插入带 padding/border 的新层，或 `.grow` 不再是
   * offsetParent）。此时幽灵会浮在别的内容上——就是用户报告的重叠。
   *
   * 判据：幽灵左上角与「编辑器在 offsetParent 内的内容原点」之差必须在一个
   * 行高量级内。偏差超过一行，说明坐标系假设已被宿主破坏，放弃显示。
   */
  /**
   * 量出草稿在编辑器里的**真实行尾**（最后一行最后一个字符之后的位置）。
   *
   * 必须逐文本节点取、且只取**最后一个非空文本节点的末字符**矩形：
   * `range.selectNodeContents(editor)` 返回的是**块级 `<p>` 的整行矩形**，
   * 多行时其 `right` 是第一行的行尾——拿它当"草稿末尾"会算出几百像素的假重叠
   * （本仓库实测踩过两次）。
   */
  draftEndRect() {
    const ta = this.composer;
    if (ta === null) return null;
    const walker = document.createTreeWalker(ta, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node;
      if (text.nodeValue && text.nodeValue.length > 0) last = text;
    }
    if (last === null) return null;
    const end = last.nodeValue.length;
    const range = document.createRange();
    range.setStart(last, Math.max(0, end - 1));
    range.setEnd(last, end);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 ? rect : null;
  }
  /** 记录一次自检失败的原因（留在 `data-reject` 上供现场取证）并判为不显示。 */
  rejectAs(reason) {
    this.el.dataset.reject = reason;
    return false;
  }
  /**
   * 几何自检：定位明显失真时宁可不显示，也绝不糊在正文上。
   *
   * ## 两种形态判据不同（历史补全已改为锚定，不再检查原点）
   *
   *  - **历史补全**：幽灵的左上角必须正好落在 DOM 量出的草稿行尾（±4px）。
   *    另外要求 caret 本身落在编辑器自己的盒子里——这是为了拦住「量到游离/陈旧
   *    节点」的情形：游离节点的矩形是**全 0**，若不拦，锚点会被算到屏幕左上角。
   *  - **LLM 建议**（草稿为空、整段从内容原点起）：仍按原点判据，并额外确认
   *    占位文字**确实已让位**——否则幽灵就是叠在占位文案上（用户第一张截图）。
   *
   * 失败原因写进 `data-reject`：把「偶发重叠」变成「偶发没幽灵 + 一条可读证据」。
   */
  verify() {
    const ta = this.composer;
    if (ta === null) return false;
    const host = this.el.offsetParent;
    if (!(host instanceof HTMLElement)) return false;
    const ghostRect = this.el.getBoundingClientRect();
    const taRect = ta.getBoundingClientRect();
    const style = getComputedStyle(ta);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const lineHeight = parseFloat(style.lineHeight);
    const tolerance = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24;
    if (this.current !== null && this.current.kind === "history") {
      const end = this.draftEndRect();
      if (end === null) return this.rejectAs("no-caret");
      if (end.right < taRect.left || end.right > taRect.right + 1 || end.top < taRect.top - 1 || end.top > taRect.bottom + 1) {
        return this.rejectAs("caret-outside-editor");
      }
      const dx = Math.round(ghostRect.left - end.right);
      const lineOff = Number.isFinite(lineHeight) && lineHeight > 0 && end.height > 0 ? Math.max(0, (lineHeight - end.height) / 2) : 0;
      const dy = Math.round(ghostRect.top - end.top);
      if (Math.abs(dx) > 4 || dy > 4 || dy < -(lineOff + 4)) {
        return this.rejectAs(`anchor-drift dx=${dx} dy=${dy}`);
      }
    } else {
      if (Math.abs(ghostRect.top - (taRect.top + borderTop + padTop)) > tolerance) return this.rejectAs("origin-drift-y");
      if (Math.abs(ghostRect.left - (taRect.left + borderLeft + padLeft)) > tolerance) return this.rejectAs("origin-drift-x");
      const placeholder = document.querySelector("[data-composer-placeholder]");
      if (placeholder !== null && getComputedStyle(placeholder).display !== "none") {
        return this.rejectAs("placeholder-visible");
      }
    }
    if (!(host.contains(ta) || host === ta.parentElement)) return this.rejectAs("host-mismatch");
    delete this.el.dataset.reject;
    return true;
  }
  /**
   * 对齐 + 自检；自检失败则隐藏（保持 current 以便下次事件重试）。
   *
   * ## 两条顺序约束（都踩过坑，勿调换）
   *
   * 1. **必须先 `display:block` 再测量**：`getBoundingClientRect()` 对
   *    `display:none` 的元素恒返回全 0，先测量会把每次首帧都判为「空矩形 →
   *    不可显示」，`display` 永远停在 `none`——表现为幽灵彻底不出现。
   *
   * 2. **必须在显示之前就 `data-shown="1"`**：placeholder 的隐藏规则
   *    （`body:has(#…[data-shown="1"]) [data-composer-placeholder]{display:none}`）
   *    挂在 `data-shown` 上。若先 `display:block` 再标 `data-shown`，中间就存在
   *    一个「幽灵已可见、placeholder 还没隐藏」的窗口——两者同原点，直接重叠
   *    （实测：该窗口内 placeholder 的 computed display 仍是 block）。
   *
   * 注意两者是**不同元素上的两个开关**，互不冲突：
   *  - `data-shown` 打在 overlay 自身（控制 placeholder 是否让位）；
   *  - `display` 打在 overlay 自身（控制幽灵是否绘制）。
   * 因此正确顺序是：**先标 `data-shown` 让位 → 再 `display:block` → 测量自检
   * → 不合格则把两者一起回退**。
   */
  alignAndVerify() {
    if (this.current === null) return;
    this.align();
    this.el.dataset.shown = "1";
    this.el.style.display = "block";
    if (!this.verify()) {
      this.el.style.display = "none";
      this.el.dataset.shown = "0";
      return;
    }
  }
  /** 显示幽灵内容（对齐由滚动/尺寸事件持续维护）；隐藏 placeholder 避免重叠。 */
  show(content) {
    this.el.textContent = "";
    if (content.kind === "llm") {
      this.el.textContent = content.text;
    } else {
      const suffix = document.createElement("span");
      suffix.textContent = content.suffix;
      this.el.append(suffix);
    }
    this.current = content;
    this.alignAndVerify();
  }
  hide() {
    this.current = null;
    this.el.style.display = "none";
    this.el.textContent = "";
    this.el.dataset.shown = "0";
    delete this.el.dataset.reject;
  }
  dispose() {
    this.detach();
    this.styleTag.remove();
  }
};
var remoteOf = (ctx) => ctx.get("remote");
var sectionLabel = (locale) => {
  const active = locale === void 0 ? "zh" : locale.getSnapshot().active;
  return active === "en" ? SECTION_LABELS.en : SECTION_LABELS.zh;
};
function applyInner(ctx) {
  applyBody(ctx);
}
function applyBody(ctx) {
  const sessions = ctx.get("sessions");
  if (sessions === void 0) return;
  const overlay = new GhostOverlay();
  let lastSessionId;
  let bound = null;
  let shown = null;
  let composing = false;
  let settings = {
    historyEnabled: true,
    historyCrossSession: false,
    historyMaxEntries: 50,
    historyMinChars: 1,
    wordAccept: true,
    suggestion: null,
    hot: null,
    history: [],
    historySessionId: null,
    suggestionSessionId: null
  };
  let settingsEpoch = 0;
  let hotCountsCache = null;
  let ghostContentCache = null;
  const resolve = (currentId) => {
    const id = currentId;
    if (id === void 0) {
      bound = null;
      lastSessionId = void 0;
      return;
    }
    if (id === lastSessionId && bound !== null) return;
    const actx = sessions.scope(id);
    if (actx === void 0) return;
    const session = sessions.sessionOf(actx);
    if (session === void 0) return;
    const conversation = actx.get("conversation");
    if (conversation === void 0) return;
    const input = conversation.input.for(actx);
    if (input === void 0) return;
    lastSessionId = id;
    bound = {
      session,
      input,
      projectionFace: session.projections.faceOf(PROJECTION_KEY)
    };
    pullHistory(id);
  };
  const ghostContent = (currentId) => {
    if (bound === null) return { content: null, key: null };
    if (composing) return { content: null, key: null };
    const snapshot = bound.session.getSnapshot();
    const draft = bound.input.state.getSnapshot().draft;
    if (ghostContentCache !== null && ghostContentCache.draft === draft && ghostContentCache.settingsEpoch === settingsEpoch && ghostContentCache.composing === composing && ghostContentCache.running === snapshot.running && ghostContentCache.currentId === currentId) {
      return { content: ghostContentCache.result, key: ghostContentCache.key };
    }
    const result = computeGhostContent(draft, snapshot, currentId);
    let key = null;
    if (result !== null) {
      key = result.kind === "llm" ? `llm:${result.text}` : `hist:${result.prefix}|${result.suffix}`;
    }
    ghostContentCache = { draft, settingsEpoch, composing: false, running: snapshot.running, currentId, result, key };
    return { content: result, key };
  };
  const computeGhostContent = (draft, snapshot, currentId) => {
    if (settings.historyEnabled && draft.trim() !== "") {
      const contentDraft = stripCommandPrefix(draft);
      if (contentDraft.trim() === "") return null;
      const history = settings.historySessionId !== null && settings.historySessionId === currentId ? settings.history : [];
      const hot = settings.hot;
      if (hotCountsCache === null || hotCountsCache.src !== hot) {
        const map = hot !== null && hot.length > 0 ? new Map(hot.map((h) => [normalizeForMatch(h.text), h.count])) : void 0;
        hotCountsCache = { src: hot, map };
      }
      const hotCounts = hotCountsCache.map;
      const full = historySuggestion(history, contentDraft, {
        minChars: settings.historyMinChars,
        maxEntries: settings.historyMaxEntries,
        hotCounts,
        extraCandidates: settings.historyCrossSession ? hot ?? void 0 : void 0
      });
      if (full === void 0) return null;
      const common = commonPrefixLength(contentDraft, full);
      return { kind: "history", prefix: draft, suffix: full.slice(common), full };
    }
    const suggestion = settings.suggestion;
    if (suggestion === null || suggestion === void 0) return null;
    const stale = snapshot.running || settings.suggestionSessionId !== null && settings.suggestionSessionId !== currentId;
    if (stale) return null;
    return { kind: "llm", text: suggestion.text, acceptKey: suggestion.acceptKey };
  };
  let cachedComposer = null;
  let validatedComposer = null;
  const render = () => {
    const currentId = currentSessionIdOf(sessions.list.getSnapshot());
    resolve(currentId);
    retryPendingPull();
    const { content, key } = ghostContent(currentId);
    if (content === null) {
      if (shown !== null) {
        overlay.hide();
        shown = null;
      }
      return;
    }
    if (key === null) return;
    if (shown !== null && shown.key === key) return;
    const attached = overlay.currentTextarea;
    let composer = attached !== null && attached.isConnected ? attached : cachedComposer !== null && cachedComposer.isConnected ? cachedComposer : document.querySelector(COMPOSER_SELECTOR);
    if (composer === null) return;
    if (composer !== validatedComposer) {
      if (!isComposerElement(composer)) {
        if (shown !== null) {
          overlay.hide();
          shown = null;
        }
        return;
      }
      validatedComposer = composer;
    }
    cachedComposer = composer;
    overlay.attach(composer);
    overlay.show(content);
    shown = { key, content };
  };
  const locale = ctx.get("locale");
  const writeOps = (payload) => {
    const svc = remoteOf(ctx)?.settings;
    if (svc === void 0) return Promise.resolve(false);
    let enriched = payload;
    try {
      const obj = JSON.parse(payload);
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        const active = locale?.getSnapshot?.()?.active;
        if (typeof active === "string" && active.length > 0) {
          enriched = JSON.stringify({ ...obj, locale: active });
        }
      }
    } catch {
    }
    return svc.mutate(SETTINGS_NAMESPACE, [{ op: "set", path: ["_ops"], value: enriched }]).then(() => true).catch(() => false);
  };
  let pullRev = 0;
  let lastPulledSessionId;
  let pendingPull = null;
  let pullRetryTimer = null;
  const pullHistory = (sessionId) => {
    if (sessionId === lastPulledSessionId) return;
    lastPulledSessionId = sessionId;
    pendingPull = { sessionId, attempts: 0 };
    pullRev += 1;
    void writeOps(JSON.stringify({ rev: pullRev, ops: [{ op: "pull", sessionId }] }));
    schedulePullRetry();
  };
  const retryPendingPull = () => {
    const pending = pendingPull;
    if (pending === null) return;
    if (lastSessionId !== pending.sessionId) {
      pendingPull = null;
      return;
    }
    if (settings.historySessionId === pending.sessionId) {
      pendingPull = null;
      return;
    }
    if (pending.attempts >= PULL_MAX_ATTEMPTS) {
      pendingPull = null;
      return;
    }
    pending.attempts += 1;
    pullRev += 1;
    void writeOps(JSON.stringify({ rev: pullRev, ops: [{ op: "pull", sessionId: pending.sessionId }] }));
    schedulePullRetry();
  };
  const schedulePullRetry = () => {
    if (pendingPull === null || pullRetryTimer !== null) return;
    const delay = PULL_RETRY_BASE_MS * 2 ** pendingPull.attempts;
    pullRetryTimer = setTimeout(() => {
      pullRetryTimer = null;
      retryPendingPull();
    }, delay);
  };
  const remote = remoteOf(ctx);
  if (remote?.settings !== void 0) {
    let lastRevision = -1;
    let describeInFlight = false;
    const applySettings = () => {
      void (async () => {
        if (describeInFlight) return;
        describeInFlight = true;
        try {
          const described = await remote.settings.describe();
          const list = unwrapSettingsDoc(described)?.namespaces ?? [];
          const entry = list.find((row) => row.ns === SETTINGS_NAMESPACE);
          if (entry === void 0) return;
          const rev = typeof entry.revision === "number" ? entry.revision : 0;
          if (rev === lastRevision) return;
          lastRevision = rev;
          settingsEpoch++;
          clearNormalizeCache();
          hotCountsCache = null;
          ghostContentCache = null;
          const v = entry.value ?? {};
          let pushed = null;
          if (typeof v._push === "string" && v._push !== "") {
            try {
              pushed = JSON.parse(v._push);
            } catch {
              pushed = null;
            }
          }
          settings = {
            historyEnabled: typeof v.historyEnabled === "boolean" ? v.historyEnabled : true,
            historyCrossSession: typeof v.historyCrossSession === "boolean" ? v.historyCrossSession : false,
            historyMaxEntries: typeof v.historyMaxEntries === "number" ? v.historyMaxEntries : 50,
            historyMinChars: typeof v.historyMinChars === "number" ? v.historyMinChars : 1,
            wordAccept: typeof v.wordAccept === "boolean" ? v.wordAccept : true,
            suggestion: pushed?.suggestion === null || pushed?.suggestion === void 0 ? null : pushed.suggestion,
            hot: pushed?.hot === null || pushed?.hot === void 0 ? null : pushed.hot,
            // history 省略 = host 本次推送不携带历史（保留现值）。启动对账推送正是
            // 这种形态：它只负责恢复建议，历史留给紧随其后的 pull 应答，此时若把
            // 本地历史清成 [] 会把「切回会话仍有历史」的体验一起清掉。
            history: Array.isArray(pushed?.history) ? (pushed?.history).filter((t) => typeof t === "string") : settings.history,
            historySessionId: Array.isArray(pushed?.history) ? typeof pushed?.historySessionId === "string" ? pushed.historySessionId : null : settings.historySessionId,
            suggestionSessionId: typeof pushed?.suggestionSessionId === "string" ? pushed.suggestionSessionId : null
          };
          render();
        } catch {
        } finally {
          describeInFlight = false;
        }
      })();
    };
    const offUpdated = remote.$on?.("settings/document-updated", () => applySettings());
    const offReset = ctx.on("connection/reset", () => applySettings());
    ctx.effect(() => () => {
      offUpdated?.();
      offReset();
    });
    applySettings();
  }
  const onKeyDown = (event) => {
    if (event.isComposing) return;
    if (shown === null) return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLTextAreaElement) && !(focused instanceof HTMLElement && focused.isContentEditable)) return;
    if (!isComposerTarget(focused)) return;
    const content = shown.content;
    const acceptKey = content.kind === "llm" ? content.acceptKey : DEFAULT_ACCEPT_KEY;
    const matcher = parseAcceptKey(acceptKey);
    if (matcher !== void 0 && matcher(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (bound !== null) {
        let accepted;
        if (content.kind === "llm") {
          accepted = content.text;
        } else {
          const draftNow = bound.input.state.getSnapshot().draft;
          const contentDraft = stripCommandPrefix(draftNow);
          const head = contentDraft === "" ? draftNow : draftNow.slice(0, draftNow.length - contentDraft.length);
          const tailJoiner = head.endsWith(" ") || head === "" ? "" : " ";
          accepted = `${head}${tailJoiner}${content.full}`;
        }
        bound.input.setDraft(accepted);
      }
      overlay.hide();
      shown = null;
      return;
    }
    if (settings.wordAccept && event.code === "ArrowRight" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const ta = focused;
      const draftNow = bound !== null ? bound.input.state.getSnapshot().draft : "";
      const full = content.kind === "llm" ? content.text : content.full;
      if (!caretAtComposerEnd(ta)) return;
      const matchBase = content.kind === "history" ? stripCommandPrefix(draftNow) : draftNow;
      if (!full.startsWith(matchBase) || matchBase.length >= full.length) return;
      const chunk = nextAcceptChunk(full.slice(matchBase.length));
      if (chunk === "") return;
      event.preventDefault();
      event.stopPropagation();
      let accepted;
      if (content.kind === "history") {
        const head = matchBase === "" ? draftNow : draftNow.slice(0, draftNow.length - matchBase.length);
        const tailJoiner = head.endsWith(" ") || head === "" ? "" : " ";
        accepted = `${head}${tailJoiner}${matchBase}${chunk}`;
      } else {
        accepted = draftNow + chunk;
      }
      if (bound !== null) bound.input.setDraft(accepted);
      if (accepted === full || content.kind === "history" && accepted.endsWith(full)) {
        overlay.hide();
        shown = null;
      }
    }
  };
  ctx.effect(() => {
    let unsubs = [];
    let deferredRenders = [];
    const scheduleDeferredRenders = () => {
      for (const t of deferredRenders) clearTimeout(t);
      deferredRenders = [60, 300, 900].map((ms) => setTimeout(render, ms));
    };
    const rebind = (knownId) => {
      for (const un of unsubs) un();
      unsubs = [];
      resolve(knownId ?? currentSessionIdOf(sessions.list.getSnapshot()));
      if (bound !== null) {
        unsubs.push(
          bound.session.subscribe(render),
          bound.input.state.subscribe(render),
          bound.projectionFace.subscribe(render)
        );
      }
      scheduleDeferredRenders();
    };
    rebind();
    render();
    const onList = () => {
      const id = currentSessionIdOf(sessions.list.getSnapshot());
      if (id !== lastSessionId) rebind(id);
      render();
    };
    const unList = sessions.list.subscribe(onList);
    const onCompositionStart = () => {
      composing = true;
      render();
    };
    const onCompositionEnd = () => {
      composing = false;
      render();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("compositionstart", onCompositionStart, true);
    window.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      unList();
      for (const un of unsubs) un();
      for (const t of deferredRenders) clearTimeout(t);
      if (pullRetryTimer !== null) clearTimeout(pullRetryTimer);
      pullRetryTimer = null;
      pendingPull = null;
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("compositionstart", onCompositionStart, true);
      window.removeEventListener("compositionend", onCompositionEnd, true);
      overlay.dispose();
    };
  }, "dsh-suggest-ghost: composer ghost render");
  const ENTRY_ID = "suggest-ghost";
  if (ctx.slots !== void 0) {
    ctx.inject(["configForms"], () => {
      const forms = ctx.get("configForms");
      if (forms === void 0 || typeof forms.get !== "function" || typeof forms.whileServed !== "function") return;
      const formScope = forms.get(ENTRY_ID);
      ctx.effect(
        () => forms.whileServed(
          [ENTRY_ID],
          () => ctx.slots.inject(
            "plugins.bundle.config",
            () => ctx.slots.register({
              name: "plugins.bundle.config",
              key: "dsh-suggest-ghost",
              locale: "dsh-suggest-ghost",
              inject: () => ({ scope: formScope, locale, surface: "detail" })
            }, SuggestGhostCard)
          )
        ),
        "dsh-suggest-ghost: plugins-page card"
      );
    });
  }
  const remoteForCard = remoteOf(ctx);
  if (ctx.slots === void 0 || remoteForCard?.settings === void 0) return;
  const SHOW_SETTINGS_KEY = "dsh-suggest-ghost:show-settings-section";
  const showSettingsSection = typeof localStorage !== "undefined" && localStorage.getItem(SHOW_SETTINGS_KEY) === "true";
  if (!showSettingsSection) return;
  const cardScope = remoteSettingsScope(remoteForCard, SETTINGS_NAMESPACE);
  const disposeSection = ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    // 自有 id：用宿主没有的 id 才会「并排新增一页」，复用宿主 id 会顶掉那一页。
    id: SETTINGS_SECTION_ID,
    order: 40,
    label: () => sectionLabel(locale),
    // 卡片只依赖 scope 的 get/subscribe/set 三个成员（见 settings-card.tsx 的
    // PluginSettingsScope），这里用 remote.settings 适配出同形状的最小面：
    // 0.1.7 已无 settingsScope 服务，而卡片逻辑（读快照 / 订阅变更 / 写字段）
    // 与代次无关，不必改卡片本体。
    inject: () => ({ scope: cardScope, locale, surface: "settings" })
  }, SuggestGhostCard));
  if (typeof disposeSection === "function") {
    ctx.effect(() => () => {
      disposeSection();
      cardScope.dispose();
    });
  }
}
function remoteSettingsScope(remote, ns) {
  let snapshot = { status: "loading", value: {}, writable: false };
  let revision = -1;
  const listeners = [];
  let disposed = false;
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
      }
    }
  };
  const readValue = () => {
    void (async () => {
      if (disposed) return;
      try {
        const described = await remote.settings?.describe();
        const doc = unwrapSettingsDoc(described);
        const entry = (doc?.namespaces ?? []).find((row) => row.ns === ns);
        if (entry === void 0) return;
        const rev = typeof entry.revision === "number" ? entry.revision : 0;
        if (rev === revision) return;
        revision = rev;
        snapshot = {
          status: "ready",
          value: entry.value ?? {},
          // `writable` 是 describe() 的**外层**字段（整个设置文档可否写），
          // 不是命名空间条目的字段。缺省视为可写（旧宿主不带该字段）。
          writable: doc?.writable !== false
        };
        notify();
      } catch {
      }
    })();
  };
  readValue();
  const offUpdated = remote.$on?.("settings/document-updated", () => readValue());
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    set: (key, next) => {
      const svc = remote.settings;
      if (svc === void 0) return Promise.resolve();
      const expected = revision < 0 ? 0 : revision;
      return svc.mutate(ns, [{ op: "set", path: [key], value: next }], expected).then(() => {
        readValue();
      }).catch(() => {
      });
    },
    dispose: () => {
      disposed = true;
      offUpdated?.();
      listeners.length = 0;
    }
  };
}
function apply(ctx) {
  applyInner(ctx);
}

		return module.exports;
	}
});
