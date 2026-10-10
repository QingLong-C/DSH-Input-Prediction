/**
 * SuggestGhost 设置卡片样式（裸表单 + section 分组布局）。
 *
 * 视觉对齐官方 SettingsForm（dsh-client-ui-primitives）：无卡片容器，
 * 字段按 section 分组，每组有标题，底部保存按钮。sgc- 前缀防冲突。
 *
 * 关键值从 dsh-later/styles.ts 复制（官方风格参考实现）。
 */

export const STYLE_ID = 'dsh-suggest-ghost-card-css';

const COMPONENTS = [
  /* ==================== 表单根 ==================== */
  /* 裸表单，无卡片容器（对齐官方 SettingsForm） */
  '.sgc-settings-form{display:flex;flex-direction:column}',

  /* ==================== Section 分组 ==================== */
  '.sgc-section{padding:16px 0}',
  '.sgc-section-heading{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
  '.sgc-section-fields{display:flex;flex-direction:column}',

  /* ==================== 字段 ==================== */
  '.sgc-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
  '.sgc-fieldHead{display:flex;align-items:center;gap:8px}',
  '.sgc-label-group{display:flex;align-items:center;gap:4px;flex:1;min-width:0}',
  '.sgc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',

  /* ==================== 输入框 ==================== */
  '.sgc-input{box-sizing:border-box;width:100%;min-height:36px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}',
  '.sgc-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
  '.sgc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
  '.sgc-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}',
  '.sgc-inputReadOnly{opacity:.6;cursor:not-allowed}',

  /* ==================== 快捷键按钮 ==================== */
  '.sgc-key{box-sizing:border-box;width:100%;appearance:none;font:inherit;text-align:left;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);min-height:36px;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md,8px);padding:0 12px;font-size:13px;line-height:1.5}',
  '.sgc-key:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:none}',
  '.sgc-key:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
  '.sgc-keyCapturing,.sgc-keyCapturing:focus-visible{border-color:var(--dsw-alias-brand-primary)}',

  /* ==================== 帮助按钮 ==================== */
  '.sgc-help-btn{width:24px;height:24px;padding:0;flex:none;display:inline-flex;align-items:center;justify-content:center;background:none;border:none;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-tertiary)}',
  '.sgc-help-btn:hover,.sgc-help-btnOpen{color:var(--dsw-alias-label-secondary)}',
  '.sgc-help-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',

  /* ==================== 帮助展开区 ==================== */
  '.sgc-help{margin:0;padding:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
  '.sgc-help p{margin:0}',

  /* ==================== Toggle 行（布尔字段） ==================== */
  '.sgc-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px}',
  '.sgc-toggle-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
  '.sgc-toggle-switch{position:relative;width:36px;height:20px;flex:none;background:var(--dsw-alias-bg-module-platform);border-radius:999px;cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);border:none;padding:0}',
  '.sgc-toggle-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary)}',
  '.sgc-toggle-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}',
  '.sgc-toggle-switch[aria-checked="true"]::after{transform:translateX(16px)}',
  '.sgc-toggle-switch:disabled{opacity:0.4;cursor:default}',
  '.sgc-toggle-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
  '.sgc-toggle-description{margin:0;padding:0 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',

  /* ==================== 只读/策略字段提示 ==================== */
  '.sgc-configOnly{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:11px;line-height:1.4}',
  '.sgc-invalid{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}',
  '.sgc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
  '.sgc-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',

  /* ==================== 底部操作栏 ==================== */
  '.sgc-footer{justify-content:flex-end;align-items:center;gap:8px;padding-top:16px;display:flex}',
  '.sgc-status{flex:1;min-width:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5}',
  '.sgc-discard,.sgc-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);padding:5px 14px;font-size:13px;line-height:1.5}',
  '.sgc-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:none}',
  '.sgc-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
  '.sgc-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
  '.sgc-save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
  '.sgc-save:disabled,.sgc-discard:disabled{opacity:.4;cursor:default}',
  '.sgc-save:focus-visible,.sgc-discard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',

  /* ==================== 热度管理分组 ==================== */
  /* 折叠式 section 标题按钮：外观对齐 .sgc-section-heading（13px/600/primary），可点击展开 */
  '.sgc-sectionBtn{appearance:none;width:100%;font:inherit;background:none;border:0;text-align:left;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5;padding:0}',
  '.sgc-sectionBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}',
  '.sgc-sectionBtnText{min-width:0}',
  '.sgc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
  '.sgc-chevronOpen{transform:rotate(180deg)}',
  '.sgc-hotList{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;max-height:320px;overflow-y:auto}',
  '.sgc-hotRow{display:flex;align-items:center;gap:8px;padding:6px 10px;min-width:0}',
  '.sgc-hotRow+.sgc-hotRow{border-top:1px solid var(--dsw-alias-border-l2)}',
  '.sgc-hotRow:hover{background:var(--dsw-alias-bg-layer-2)}',
  '.sgc-hotPinFlag{flex:none;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 7px;font-size:11px;font-weight:500;line-height:16px;white-space:nowrap}',
  '.sgc-hotText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
  '.sgc-hotCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}',
  '.sgc-hotBtn{flex:none;appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:none;border-radius:6px;padding:2px 8px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary)}',
  '.sgc-hotBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
  '.sgc-hotBtn:disabled{opacity:.4;cursor:default}',
  '.sgc-hotBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
  '.sgc-hotBtnDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
  '.sgc-hotAdd{display:flex;gap:8px;margin-top:8px}',
  '.sgc-hotAdd .sgc-input{flex:1;min-width:0;min-height:30px;height:30px;font-size:12px}',
  '.sgc-hotMeta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0 0}',
  '.sgc-hotDanger{color:var(--dsw-alias-state-error-primary)}',
].join('\n');

/** 幂等样式注入（与 dsh-later 的 injectStyles 同一模式）。 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) {
    return () => undefined;
  }
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-suggest-ghost';
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = COMPONENTS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}
