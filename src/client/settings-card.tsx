/**
 * SuggestGhost 设置卡片：渲染到 WebUI 设置 → 设置页槽位（`settings.section`），
 * 编辑 `suggest-ghost` settings 命名空间。React 组件，运行时从宿主解析 react
 * （esbuild external）。
 *
 * 视觉对齐官方 SettingsForm（dsh-client-ui-primitives，参考 dsh-later 的
 * SchedulerSettingsCard 同款实现）——**裸表单 + section 分组布局**，无卡片
 * chrome（无可折叠头部、无边框、无背景）：
 * - section：`padding 16px 0`，标题 13px/600（llm / history 两个 section）；
 * - 字段：`padding 12px 0`，label 13px/500 在上、控件在下、无字段分隔线；
 * - 布尔字段：官方 toggle 行（label 左 + switch 右，36×20 圆角滑块）；
 * - 帮助按钮：24×24、8px 圆角、12px 圆圈问号图标，点击展开字段说明；
 * - footer：保存/放弃按钮靠右（无顶部分隔线）。
 * 样式经 <style> 注入（styles.ts，sgc- 前缀类名），与官方 CSS 注入方式相同。
 *
 * 文案双语：字段 label/hint 直接存 { zh, en } 双值，chrome 微文案由
 * zh 源字典 + en 映射类型约束键集一致；语言经 useGhostT 跟随宿主 DSH
 * 界面语言（locale 服务），切换无刷新重渲染，服务缺失回退中文。
 * @module dsh-suggest-ghost/client/settings-card
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
// 0.1.7 移除了内核 settingsScope 服务；卡片依赖的 scope 最小面在 client 侧
// 本地声明，由 index.ts 的 remoteSettingsScope() 适配器实现。
import type { PluginSettingsScope } from './settings-scope.ts';
import type { ScopeSnapshot } from './index.ts';
import type { HotnessOp } from '../domain.ts';
import { keyEventToSpec } from './keyspec.ts';
import { useGhostT, type GhostLang, type LocaleFaceLike } from './useGhostT.ts';
import { injectStyles } from './styles.ts';

/** 字段输入形态。 */
export type FieldKind = 'number' | 'text' | 'boolean' | 'key' | 'select';

/** 双语文案值（zh 为源语言）。 */
export interface Bilingual {
  readonly zh: string;
  readonly en: string;
}

/** 配置字段定义（key / 显示名 / 提示 / 输入形态 / 所属分组）。
 * label/hint 为 { zh, en } 双值，按 useGhostT 解析出的语言取用。
 *
 * `writable: false` = **策略字段**，host 端刻意没标 `.volatile()`，因此写不进去
 * （内核的 `SettingsForms.write()` 只接受 volatile 路径，非 volatile 直接抛错）。
 * 这类字段在卡片里以只读呈现并标注来源，避免用户改了「保存」却静默无效——
 * 这正是 0.1.7 把策略参数与用户可调项分开之后必须显式表达的区别。 */
export const GHOST_FIELDS: ReadonlyArray<{
  readonly key: string;
  readonly label: Bilingual;
  readonly hint: Bilingual;
  readonly kind: FieldKind;
  readonly section: 'llm' | 'history' | 'language';
  /** 是否可经设置页写回（false = 只能改配置文件）。 */
  readonly writable: boolean;
  /** select 控件的选项列表（仅 kind='select' 时使用）。 */
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: Bilingual }>;
}> = [
  // —— LLM 下一条建议 ——
  {
    key: 'maxInputBytes',
    label: { zh: '输入字节上限', en: 'Input byte cap' },
    hint: {
      zh: '最终框架化用户提示的最大 UTF-8 字节数',
      en: 'Max UTF-8 bytes of the final framed user prompt',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'maxOutputTokens',
    label: { zh: '输出令牌上限', en: 'Output token cap' },
    hint: {
      zh: '建议生成的最大输出 token（推理模型留足预算，如 512）',
      en: 'Max output tokens per suggestion (leave headroom for reasoning models, e.g. 512)',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'maxSuggestionChars',
    label: { zh: '建议字符上限', en: 'Suggestion character cap' },
    hint: { zh: '幽灵文本可见字符数上限', en: 'Max visible characters of the ghost text' },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'maxRecentTurns',
    label: { zh: '参考回合数', en: 'Recent turns referenced' },
    hint: {
      zh: '转录尾部保留的最近完成回合数（1 = 只取最后一轮）',
      en: 'Completed turns kept from the transcript tail (1 = last turn only)',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'maxTranscriptChars',
    label: { zh: '转录字符预算', en: 'Transcript character budget' },
    hint: {
      zh: '发送给建议模型的转录字符上限',
      en: 'Max transcript characters sent to the suggestion model',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'timeoutMs',
    label: { zh: '超时（毫秒）', en: 'Timeout (ms)' },
    hint: {
      zh: '辅助 LLM 请求端到端截止时间',
      en: 'End-to-end deadline for the auxiliary LLM request',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'acceptKey',
    label: { zh: '采纳快捷键', en: 'Accept shortcut' },
    hint: {
      zh: '点击后按下组合键；支持 Tab、字母/数字、F1-F12、方向键等（两个功能共用）',
      en: 'Click, then press a key combo; supports Tab, letters/digits, F1-F12, arrows, etc. (shared by both features)',
    },
    kind: 'key',
    section: 'llm',
    writable: true,
  },
  {
    key: 'llmEnabled',
    label: { zh: '启用 LLM 建议', en: 'Enable LLM suggestions' },
    hint: {
      zh: '关闭后每回合不再调用建议模型（省 token）；历史前缀补全与热度不受影响',
      en: 'When off, no suggestion model call per turn (saves tokens); history completion and hotness are unaffected',
    },
    kind: 'boolean',
    section: 'llm',
    writable: true,
  },
  {
    key: 'provider',
    label: { zh: 'Provider', en: 'Provider' },
    hint: {
      zh: '显式路由；留空继承主请求路由',
      en: 'Explicit routing; leave empty to inherit the main request route',
    },
    kind: 'text',
    section: 'llm',
    writable: true,
  },
  {
    key: 'model',
    label: { zh: 'Model', en: 'Model' },
    hint: {
      zh: '显式路由；留空继承主请求路由',
      en: 'Explicit routing; leave empty to inherit the main request route',
    },
    kind: 'text',
    section: 'llm',
    writable: true,
  },
  // —— 历史前缀补全 ——
  {
    key: 'historyEnabled',
    label: { zh: '启用历史补全', en: 'Enable history completion' },
    hint: {
      zh: '草稿非空时按历史消息前缀补全（打分制：最近优先 + 频次/热度加权）',
      en: 'Completes the draft from history-message prefixes while typing (scored: recency first, weighted by frequency/heat)',
    },
    kind: 'boolean',
    section: 'history',
    writable: true,
  },
  {
    key: 'historyCrossSession',
    label: { zh: '跨会话搜索', en: 'Cross-session search' },
    hint: {
      zh: '关=候选仅当前会话；开=并入其他会话的高频历史。热度频次打分不受此开关影响',
      en: 'Off = candidates from this session only; on = merge frequent history from other sessions. Hotness frequency scoring is unaffected by this switch',
    },
    kind: 'boolean',
    section: 'history',
    writable: true,
  },
  {
    key: 'historyMaxEntries',
    label: { zh: '最大历史条目', en: 'Max history entries' },
    hint: {
      zh: '最多参考的历史条目数（0 = 不限）',
      en: 'How many history entries to consider at most (0 = unlimited)',
    },
    kind: 'number',
    section: 'history',
    writable: true,
  },
  {
    key: 'historyMinChars',
    label: { zh: '最少输入字符', en: 'Minimum typed characters' },
    hint: {
      zh: '草稿输入多少字符后才触发补全（避免过早弹框）',
      en: 'How many characters must be typed before completion kicks in (avoids popping up too early)',
    },
    kind: 'number',
    section: 'history',
    writable: true,
  },
  {
    key: 'wordAccept',
    label: { zh: '逐词采纳', en: 'Word-by-word accept' },
    hint: {
      zh: '幽灵显示时按 → 每次采纳一个词（中文按词典分词）；Tab 始终整条采纳。对两种建议模式都生效',
      en: 'While the ghost shows, → accepts one word at a time (Chinese segments via dictionary); Tab always accepts the whole text. Applies to both suggestion modes',
    },
    kind: 'boolean',
    section: 'history',
    writable: true,
  },
  // —— 语言设置 ——
  {
    key: 'languageMode',
    label: { zh: '建议语言', en: 'Suggestion language' },
    hint: {
      zh: '自动：结合界面语言与消息内容推断；指定：始终使用所选语言',
      en: 'Auto: infer from UI locale and message content; Specified: always use the selected language',
    },
    kind: 'select',
    section: 'language',
    writable: true,
    options: [
      { value: 'auto', label: { zh: '自动', en: 'Auto' } },
      { value: 'zh', label: { zh: '简体中文', en: 'Simplified Chinese' } },
      { value: 'zh-TW', label: { zh: '繁體中文', en: 'Traditional Chinese' } },
      { value: 'en', label: { zh: 'English', en: 'English' } },
      { value: 'ja', label: { zh: '日本語', en: 'Japanese' } },
      { value: 'ko', label: { zh: '한국어', en: 'Korean' } },
      { value: 'ru', label: { zh: 'Русский', en: 'Russian' } },
      { value: 'fr', label: { zh: 'Français', en: 'French' } },
      { value: 'de', label: { zh: 'Deutsch', en: 'German' } },
      { value: 'es', label: { zh: 'Español', en: 'Spanish' } },
    ],
  },
  {
    key: 'uiLocaleWeight',
    label: { zh: '界面语言权重', en: 'UI language weight' },
    hint: {
      zh: '自动模式下界面语言的影响力（0-500）；值越大越倾向界面语言，0 = 完全忽略界面语言',
      en: 'Influence of the UI locale in auto mode (0-500); higher = stronger preference for UI language, 0 = ignore UI locale entirely',
    },
    kind: 'number',
    section: 'language',
    writable: true,
  },
];

/** 卡片 chrome 微文案源字典（zh）：键集为唯一事实来源。 */
const zhStrings = {
  /** 只读提示 */
  readOnly: '当前部署不可写（内存模式）',
  /** 策略字段（非 volatile）只能改配置文件 */
  configOnly: '策略字段：host 端未开放写入，请改 cordis.patch.yml',
  /** 显示设置 section（仅详情页显示） */
  sectionDisplay: '显示设置',
  showInSettings: '在设置中显示',
  showInSettingsHint: '在设置对话框中显示本插件的设置页（刷新页面后生效）',
  /** 分组标题 */
  sectionLlm: 'LLM 下一条建议',
  sectionHistory: '历史前缀补全',
  sectionLanguage: '语言设置',
  /** 帮助按钮无障碍标签（label 为字段名） */
  helpFor: (label: string): string => `${label}说明`,
  /** footer 状态与按钮 */
  saved: '已保存',
  discard: '放弃修改',
  saving: '保存中…',
  save: '保存',
  /** 数字字段校验错误 */
  invalidNumber: '请输入数字',
  /** 快捷键控件 */
  keyCapturing: '按下组合键…（Esc 取消）',
  keyEmpty: '点击设置快捷键',
  // —— 热度管理 ——
  sectionHotness: '热度管理（跨会话高频短语）',
  hotHint: '即时生效，无需保存。删除只清当前统计（再次输入会重新计入）；固定后不参与淘汰、跨会话候选恒置顶。',
  hotSearch: '在下方列表中过滤…',
  hotEmpty: '暂无热度条目——正常使用几个回合后自动累积。',
  hotNoMatch: '没有匹配的条目（仅过滤当前显示的 top-K）。',
  hotAdd: '添加',
  hotAddPlaceholder: '手工新增一条候选短语…',
  hotPin: '固定',
  hotUnpin: '取消固定',
  hotPinnedBadge: '已固定',
  hotDelete: '删除',
  hotClear: '清空全部',
  hotClearConfirm: '确认清空？',
  hotMeta: (total: number, shown: number): string =>
    total > shown ? `共 ${total} 条，显示热度最高的 ${shown} 条` : `共 ${total} 条`,
} as const;

/** en 字典：映射类型约束与 zh 键集完全一致（缺键/多键均为编译期错误）。 */
const enStrings: { [K in keyof typeof zhStrings]: (typeof zhStrings)[K] } = {
  readOnly: 'Not writable in this deployment (in-memory mode)',
  configOnly: 'Strategy field: not writable from the UI — edit cordis.patch.yml',
  sectionDisplay: 'Display',
  showInSettings: 'Show in settings',
  showInSettingsHint: 'Show this plugin\'s settings page in the settings dialog (refresh to take effect)',
  sectionLlm: 'LLM next suggestion',
  sectionHistory: 'History prefix completion',
  sectionLanguage: 'Language settings',
  helpFor: (label: string): string => `About ${label}`,
  saved: 'Saved',
  discard: 'Discard changes',
  saving: 'Saving…',
  save: 'Save',
  invalidNumber: 'Enter a number',
  keyCapturing: 'Press a key combo… (Esc to cancel)',
  keyEmpty: 'Click to set a shortcut',
  // —— Hotness management ——
  sectionHotness: 'Hotness management (frequent cross-session phrases)',
  hotHint: 'Takes effect immediately, no save needed. Delete only clears the current tally (typing it again re-counts); pinned entries are exempt from eviction and always lead cross-session candidates.',
  hotSearch: 'Filter the list below…',
  hotEmpty: 'No entries yet — they accumulate automatically after a few turns of normal use.',
  hotNoMatch: 'No matching entries (filters the displayed top-K only).',
  hotAdd: 'Add',
  hotAddPlaceholder: 'Manually add a candidate phrase…',
  hotPin: 'Pin',
  hotUnpin: 'Unpin',
  hotPinnedBadge: 'Pinned',
  hotDelete: 'Delete',
  hotClear: 'Clear all',
  hotClearConfirm: 'Confirm clear?',
  hotMeta: (total: number, shown: number): string =>
    total > shown ? `${total} total, showing the top ${shown} by heat` : `${total} total`,
};

/** 单语言 chrome 文案字典类型（zh/en 通用；值随 zh 源字典，含函数成员）。 */
export type GhostStrings = { [K in keyof typeof zhStrings]: (typeof zhStrings)[K] };

/** 全部语言字典（键集一致，由 enStrings 的映射类型保证）。 */
const GHOST_STRINGS: Record<GhostLang, GhostStrings> = { zh: zhStrings, en: enStrings };

/** 卡片组件 props：由槽位注册的 inject 提供。 */
export interface SuggestGhostCardProps {
  scope: PluginSettingsScope<ScopeSnapshot>;
  /** 宿主 locale 服务 face（可选增强；缺失或旧宿主回退中文）。 */
  locale?: LocaleFaceLike;
  /** 卡片所在表面：详情页（detail）或设置对话框（settings）。
   *  详情页显示「在设置中显示」开关；设置页不显示。 */
  surface?: 'detail' | 'settings';
}

/** 会话状态快照的值类型。 */
type Value = Record<string, unknown>;
/** 未改动项的原始值 -> 显示用字符串。 */
function displayValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v === undefined || v === null ? '' : String(v);
}

/** 折叠按钮的 chevron-down 图标（内联 SVG，零依赖；热度管理分组折叠用）。 */
function ChevronDown({ className }: { className?: string }): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 官方同款帮助图标：12px 圆圈问号（对齐 dsh-later 帮助按钮的 SVG）。 */
function HelpIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true" strokeWidth="1">
      <path d="M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z" fill="currentColor"/>
      <path d="M7.6127 3.18921V4.55986H6.38735V3.18921H7.6127Z" fill="currentColor"/>
      <path d="M7.6127 5.68921V10.8109H6.38735V5.68921H7.6127Z" fill="currentColor"/>
    </svg>
  );
}

/** 快捷键捕获控件：点击进入录制态，按下组合键即写入规范 spec（Esc 取消）。
 * 录制经 keyspec.keyEventToSpec，产出与幽灵匹配端（parseAcceptKey）同一张表。 */
function KeyField({ id, value, disabled, t, onChange }: {
  id: string;
  value: string;
  disabled: boolean;
  t: GhostStrings;
  onChange: (spec: string) => void;
}): ReactElement {
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(false);
        return;
      }
      const spec = keyEventToSpec(event); // 纯修饰键返回 undefined，继续等待主键
      if (spec !== undefined) {
        onChange(spec);
        setCapturing(false);
      }
    };
    const cancel = (): void => setCapturing(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', cancel);
    };
  }, [capturing, onChange]);
  return (
    <button
      type="button"
      id={id}
      className={capturing ? 'sgc-key sgc-keyCapturing' : 'sgc-key'}
      disabled={disabled}
      onClick={() => setCapturing(c => !c)}
    >
      {capturing ? t.keyCapturing : value === '' ? t.keyEmpty : value}
    </button>
  );
}

/** `_push` 载荷里的热度条目（管理面板消费）。 */
interface HotPushEntry {
  readonly text: string;
  readonly count: number;
  readonly pinned?: boolean;
}

/** 热度管理分组：列表（固定/删除）、新增、清空。操作经 `_ops` 通道**即时生效**
 * （scope.set 直接写入，不进卡片的暂存/保存流程）；列表数据来自 `_push`
 * 实时推送，host 消费后回推最新状态，本组件随订阅无刷新重渲染。 */
function HotnessSection({ scope, pushRaw, writable, busy, lang, t, uiLocale }: {
  scope: PluginSettingsScope<Record<string, unknown>>;
  /** 当前 `_push` 字段原始值（由卡片从 scope 快照透传）。 */
  pushRaw: unknown;
  writable: boolean;
  busy: boolean;
  lang: GhostLang;
  t: GhostStrings;
  /** UI 语言（'zh' | 'en'），捎带给 host 做语言先验。 */
  uiLocale?: string;
}): ReactElement {
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const opsRev = useRef(0);
  // 清空按钮的双击确认：3 秒未确认自动复位。
  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  const disabled = !writable || busy;
  let hot: readonly HotPushEntry[] = [];
  let total = 0;
  if (typeof pushRaw === 'string' && pushRaw !== '' && pushRaw !== 'null') {
    try {
      const parsed = JSON.parse(pushRaw) as { hot?: HotPushEntry[] | null; total?: number };
      if (Array.isArray(parsed.hot)) hot = parsed.hot;
      if (typeof parsed.total === 'number') total = parsed.total;
    } catch { /* 残缺推送：展示空列表，等下一次推送自愈 */ }
  }
  if (!Number.isFinite(total) || total < hot.length) total = hot.length;

  /** 发送一批管理操作（幂等协议；rev 仅用于 client 侧递增）。 */
  const sendOps = (ops: readonly HotnessOp[]): void => {
    if (!writable) return;
    opsRev.current += 1;
    const payload: Record<string, unknown> = { rev: opsRev.current, ops };
    if (uiLocale) payload.locale = uiLocale;
    void scope.set('_ops', JSON.stringify(payload));
  };

  const needle = search.trim().toLowerCase();
  const visible = needle === ''
    ? hot
    : hot.filter((entry) => entry.text.toLowerCase().includes(needle));

  return (
    <>
      <p className="sgc-hint">{t.hotHint}</p>
      <input
        className="sgc-input"
        type="text"
        aria-label={t.hotSearch}
        placeholder={t.hotSearch}
        value={search}
        disabled={disabled}
        onChange={e => setSearch(e.target.value)}
      />
      {hot.length === 0 ? (
        <p className="sgc-hint">{t.hotEmpty}</p>
      ) : visible.length === 0 ? (
        <p className="sgc-hint">{t.hotNoMatch}</p>
      ) : (
        <div className="sgc-hotList" role="list">
          {visible.map((entry) => (
            <div className="sgc-hotRow" role="listitem" key={entry.text}>
              {entry.pinned === true && <span className="sgc-hotPinFlag">{t.hotPinnedBadge}</span>}
              <span className="sgc-hotText" title={entry.text}>{entry.text}</span>
              <span className="sgc-hotCount">×{entry.count}</span>
              <button
                type="button"
                className="sgc-hotBtn"
                disabled={disabled}
                onClick={() => sendOps([{ op: 'pin', text: entry.text, pinned: entry.pinned !== true }])}
              >
                {entry.pinned === true ? t.hotUnpin : t.hotPin}
              </button>
              <button
                type="button"
                className="sgc-hotBtn sgc-hotBtnDanger"
                disabled={disabled}
                onClick={() => sendOps([{ op: 'delete', text: entry.text }])}
              >
                {t.hotDelete}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="sgc-hotAdd">
        <input
          className="sgc-input"
          type="text"
          aria-label={t.hotAddPlaceholder}
          placeholder={t.hotAddPlaceholder}
          value={adding}
          disabled={disabled}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && adding.trim() !== '' && !disabled) {
              // 手工新增默认固定：意图是「让它成为候选」，未固定的新条目频次 1
              // 会被真实高频挤到 top-K 之外，用户会以为添加失败。
              sendOps([{ op: 'add', text: adding.trim(), pinned: true }]);
              setAdding('');
            }
          }}
        />
        <button
          type="button"
          className="sgc-hotBtn"
          disabled={disabled || adding.trim() === ''}
          onClick={() => {
            sendOps([{ op: 'add', text: adding.trim(), pinned: true }]);
            setAdding('');
          }}
        >
          {t.hotAdd}
        </button>
      </div>
      <div className="sgc-hotMeta">
        <span className="sgc-hint">{t.hotMeta(total, hot.length)}</span>
        <button
          type="button"
          className={`sgc-hotBtn sgc-hotBtnDanger${confirmClear ? ' sgc-hotConfirming' : ''}`}
          disabled={disabled || hot.length === 0}
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            setConfirmClear(false);
            sendOps([{ op: 'clear' }]);
          }}
        >
          {confirmClear ? t.hotClearConfirm : t.hotClear}
        </button>
      </div>
    </>
  );
}

/** 设置卡片：读取/编辑/保存 suggest-ghost 命名空间。
 * 裸表单 + section 分组布局（llm / history 两个 section + 可折叠的热度管理），
 * 文案跟随宿主界面语言（locale 缺失回退中文），语言切换实时重渲染。 */
export function SuggestGhostCard({ scope, locale, surface }: SuggestGhostCardProps): ReactElement | null {
  // 样式注入（幂等；卸载时随组件清理）。
  useEffect(() => injectStyles(), []);
  const lang = useGhostT(locale);
  const t = GHOST_STRINGS[lang];
  const [snap, setSnap] = useState(scope.getSnapshot());
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  const [edits, setEdits] = useState<Record<string, string | boolean | number>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  /** 帮助按钮展开态（对齐官方 _helpButton_：aria-expanded 切换）。 */
  const [helpOpen, setHelpOpen] = useState<Record<string, boolean>>({});
  // 热度管理分组折叠：默认收起（管理列表较长，配置区保持紧凑）。
  const [hotOpen, setHotOpen] = useState(false);

  // 「在设置中显示」开关：仅详情页显示，控制 settings.section 是否注册。
  // localStorage 非响应式，切换后需刷新页面生效。
  const SHOW_SETTINGS_KEY = 'dsh-suggest-ghost:show-settings-section';
  const [showSettings, setShowSettings] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(SHOW_SETTINGS_KEY) === 'true';
  });
  const toggleShowSettings = (): void => {
    const next = !showSettings;
    setShowSettings(next);
    if (typeof localStorage !== 'undefined') {
      if (next) localStorage.setItem(SHOW_SETTINGS_KEY, 'true');
      else localStorage.removeItem(SHOW_SETTINGS_KEY);
    }
  };

  if (snap.status === 'unavailable') return null; // 命名空间未暴露时不显示卡片
  const value = (snap.value ?? {}) as Value;
  const writable = snap.writable && snap.status === 'ready';
  const isDirty = Object.keys(edits).some(k => GHOST_FIELDS.find(f => f.key === k)?.writable === true);

  const fieldValue = (key: string): string => {
    if (key in edits) return String(edits[key]);
    return displayValue(value[key]);
  };
  /** 数字字段的暂存值是否非法（空或非数字）；与官方 ValueField 校验一致。 */
  const fieldInvalid = (f: (typeof GHOST_FIELDS)[number]): boolean => {
    if (f.kind !== 'number' || !(f.key in edits)) return false;
    const raw = String(edits[f.key]).trim();
    return raw === '' || Number.isNaN(Number(raw));
  };
  const anyInvalid = GHOST_FIELDS.some(fieldInvalid);
  const setField = (key: string, raw: string | boolean | number): void => {
    setEdits(prev => ({ ...prev, [key]: raw }));
  };
  const save = async (): Promise<void> => {
    if (anyInvalid) return;
    setBusy(true);
    try {
      for (const [key, raw] of Object.entries(edits)) {
        const def = GHOST_FIELDS.find(f => f.key === key)!;
        // 策略字段（非 volatile）host 端拒绝写入，跳过以免整批保存被它带崩。
        if (!def.writable) continue;
        let final: string | number | boolean = raw;
        if (def.kind === 'number') final = Number(raw);
        else if (def.kind === 'boolean') final = raw === true || raw === 'true';
        else if (def.kind === 'key') {
          const trimmed = String(raw).trim();
          if (trimmed === '') continue; // host 端 zod 要求非空，空 spec 直接丢弃
          final = trimmed;
        }
        await scope.set(key, final);
      }
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };
  const discard = (): void => setEdits({});

  const renderField = (f: (typeof GHOST_FIELDS)[number]): ReactElement => {
    const invalid = fieldInvalid(f);
    // 策略字段（非 volatile）写不进 host：只读呈现，并说明来源，避免「改了没反应」。
    const editable = writable && f.writable;
    const fieldId = `sgc-field-${f.key}`;
    const helpId = `sgc-help-${f.key}`;
    const helpOpenNow = helpOpen[f.key] === true;
    const helpAria = t.helpFor(f.label[lang]);

    /** 布尔字段：官方 toggle 行（label 左 + switch 右，说明常驻在下）。
     * 语义与旧 select 完全一致：仅显式 'true' 视为开（未设置显示为关）。 */
    if (f.kind === 'boolean') {
      const checked = fieldValue(f.key) === 'true';
      return (
        <div key={f.key} className="sgc-field">
          <div className="sgc-toggle-row">
            <div className="sgc-label-group">
              <label className="sgc-toggle-label" htmlFor={fieldId}>{f.label[lang]}</label>
            </div>
            <button
              type="button"
              id={fieldId}
              role="switch"
              aria-checked={checked}
              aria-label={f.label[lang]}
              className="sgc-toggle-switch"
              disabled={!editable || busy}
              onClick={() => setField(f.key, !checked)}
            />
          </div>
          <p className={invalid ? 'sgc-invalid' : 'sgc-toggle-description'}>
            {invalid ? t.invalidNumber : f.hint[lang]}
          </p>
          {!f.writable && <p className="sgc-configOnly">{t.configOnly}</p>}
        </div>
      );
    }

    const inputClass = [
      invalid ? 'sgc-input sgc-inputInvalid' : 'sgc-input',
      f.writable ? '' : 'sgc-inputReadOnly',
    ].filter(Boolean).join(' ');
    const control = f.kind === 'key' ? (
      <KeyField
        id={fieldId}
        value={fieldValue(f.key)}
        disabled={!editable || busy}
        t={t}
        onChange={spec => setField(f.key, spec)}
      />
    ) : f.kind === 'select' ? (
      <select
        className={inputClass}
        id={fieldId}
        value={fieldValue(f.key)}
        disabled={!editable || busy}
        onChange={e => setField(f.key, e.target.value)}
      >
        {(f.options ?? []).map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label[lang]}</option>
        ))}
      </select>
    ) : (
      <input
        className={inputClass}
        id={fieldId}
        type="text"
        {...(f.kind === 'number' ? { inputMode: 'numeric' as const } : {})}
        {...(invalid ? { 'aria-invalid': true } : {})}
        value={fieldValue(f.key)}
        disabled={!editable || busy}
        onChange={e => setField(f.key, e.target.value)}
      />
    );
    return (
      <div key={f.key} className="sgc-field">
        <div className="sgc-fieldHead">
          <div className="sgc-label-group">
            <label className="sgc-label" htmlFor={fieldId}>{f.label[lang]}</label>
            <button
              type="button"
              className={helpOpenNow ? 'sgc-help-btn sgc-help-btnOpen' : 'sgc-help-btn'}
              aria-label={helpAria}
              aria-expanded={helpOpenNow}
              aria-controls={helpId}
              onClick={() => setHelpOpen(prev => ({ ...prev, [f.key]: !helpOpenNow }))}
            >
              <HelpIcon />
            </button>
          </div>
        </div>
        {control}
        {invalid && <p className="sgc-invalid" role="status">{t.invalidNumber}</p>}
        {helpOpenNow && (
          <div id={helpId} role="region" aria-label={helpAria} className="sgc-help">
            <p>{f.hint[lang]}</p>
          </div>
        )}
        {!f.writable && <p className="sgc-configOnly">{t.configOnly}</p>}
      </div>
    );
  };

  const llmFields = GHOST_FIELDS.filter(f => f.section === 'llm');
  const historyFields = GHOST_FIELDS.filter(f => f.section === 'history');
  const languageFields = GHOST_FIELDS.filter(f => f.section === 'language');

  /** Section 布局：grid = 两列并排（适合短字段），stack = 单列堆叠。 */
  const SECTION_LAYOUT: Record<string, 'grid' | 'stack'> = {
    llm: 'stack',
    history: 'stack',
    language: 'grid',
  };

  return (
    <div className="sgc-settings-form">
      {!writable && <p className="sgc-readOnly" role="status">{t.readOnly}</p>}
      {/* 仅详情页显示：控制设置对话框中是否出现本插件的设置页。
       *  localStorage 非响应式，切换后需刷新页面生效。 */}
      {surface === 'detail' && (
        <section className="sgc-section" aria-labelledby="sgc-section-display">
          <h3 className="sgc-section-heading" id="sgc-section-display">{t.sectionDisplay}</h3>
          <div className="sgc-section-fields">
            <div className="sgc-field">
              <div className="sgc-toggle-row">
                <div className="sgc-label-group">
                  <label className="sgc-toggle-label" htmlFor="sgc-show-settings">{t.showInSettings}</label>
                </div>
                <button
                  type="button"
                  id="sgc-show-settings"
                  role="switch"
                  aria-checked={showSettings}
                  aria-label={t.showInSettings}
                  className="sgc-toggle-switch"
                  onClick={toggleShowSettings}
                />
              </div>
              <p className="sgc-toggle-description">{t.showInSettingsHint}</p>
            </div>
          </div>
        </section>
      )}
      <section className="sgc-section" aria-labelledby="sgc-section-llm">
        <h3 className="sgc-section-heading" id="sgc-section-llm">{t.sectionLlm}</h3>
        <div className={SECTION_LAYOUT.llm === 'grid' ? 'sgc-section-fields sgc-section-fieldsGrid' : 'sgc-section-fields'}>{llmFields.map(renderField)}</div>
      </section>
      <section className="sgc-section" aria-labelledby="sgc-section-history">
        <h3 className="sgc-section-heading" id="sgc-section-history">{t.sectionHistory}</h3>
        <div className={SECTION_LAYOUT.history === 'grid' ? 'sgc-section-fields sgc-section-fieldsGrid' : 'sgc-section-fields'}>{historyFields.map(renderField)}</div>
      </section>
      <section className="sgc-section" aria-labelledby="sgc-section-language">
        <h3 className="sgc-section-heading" id="sgc-section-language">{t.sectionLanguage}</h3>
        <div className={SECTION_LAYOUT.language === 'grid' ? 'sgc-section-fields sgc-section-fieldsGrid' : 'sgc-section-fields'}>{languageFields.map(renderField)}</div>
      </section>
      <section className="sgc-section" aria-labelledby="sgc-section-hotness">
        <button
          type="button"
          id="sgc-section-hotness"
          className="sgc-sectionBtn"
          aria-expanded={hotOpen}
          aria-controls="sgc-hotness-body"
          onClick={() => setHotOpen(o => !o)}
        >
          <span className="sgc-sectionBtnText">{t.sectionHotness}</span>
          <ChevronDown className={hotOpen ? 'sgc-chevron sgc-chevronOpen' : 'sgc-chevron'} />
        </button>
        {hotOpen && (
          <div id="sgc-hotness-body">
            <HotnessSection
              scope={scope}
              pushRaw={value._push}
              writable={writable}
              busy={busy}
              lang={lang}
              t={t}
              uiLocale={locale?.getSnapshot?.()?.active}
            />
          </div>
        )}
      </section>
      <div className="sgc-footer">
        {saved && <span className="sgc-status" role="status">{t.saved}</span>}
        <button className="sgc-discard" disabled={!isDirty || busy} onClick={discard}>{t.discard}</button>
        <button className="sgc-save" disabled={!writable || busy || !isDirty || anyInvalid} onClick={() => void save()}>
          {busy ? t.saving : t.save}
        </button>
      </div>
    </div>
  );
}
