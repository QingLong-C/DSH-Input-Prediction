// Exercise the real client closures with small stores/DOM faces, without mounting DSH.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = stripTypeScriptTypes(fs.readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8'));
function closure(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'real client closure located');
  return source.slice(a, b);
}
const computeSource = closure('const computeGhostContent =', '/** 缓存的上一次输入框查询结果');
const keySource = closure('const onKeyDown =', '\n  ctx.effect(() => {\n      // 订阅');
const suggestion = {turn: 2, baseSeq: 40, text: '可以解释一下这个实现吗？', acceptKey: 'Tab'};
function settings() {
  return {historyEnabled:false, inlineEnabled:false, wordAccept:false, suggestion, suggestionSessionId:'s1'};
}
function compute(draft, {running = false, currentId = 's1', dismissed = new Set()} = {}) {
  const load = new Function('settings', 'dismissedSuggestions', `${computeSource}\nreturn computeGhostContent;`);
  return load(settings(), dismissed)(draft, {running}, currentId);
}

test('completed-turn suggestion appears only in an empty draft of its own idle session', () => {
  assert.equal(compute('').text, suggestion.text);
  assert.equal(compute('已经在输入自己的内容'), null);
  assert.equal(compute('', {running:true}), null);
  assert.equal(compute('', {currentId:'s2'}), null);
});

function keyHarness() {
  const dismissed = new Set();
  const writes = [];
  const overlay = {hideCalls:0, hide() { this.hideCalls += 1; }};
  class Editor {}
  const editor = new Editor();
  const load = new Function('settings', 'dismissedSuggestions', 'document', 'HTMLTextAreaElement', 'HTMLElement',
    'isComposerTarget', 'parseAcceptKey', 'sessions', 'currentSessionIdOf', 'overlay', 'writes',
    'readDraftSnapshot', 'buildFullAccept', 'commitDraftIfPristine', `
      let shown = {key:'k', content:{kind:'llm', text:settings.suggestion.text, acceptKey:'Tab'}, base:{draft:'', draftRev:undefined}};
      const bound = {input:{setDraft:text => writes.push(text), state:{getSnapshot:() => ({draft:''})}}};
      let ghostContentCache = null;
      ${keySource}
      return onKeyDown;
    `);
  const handler = load(settings(), dismissed, {activeElement:editor}, Editor, Editor, () => true,
    () => event => event.key === 'Tab', {list:{getSnapshot:() => ({})}}, () => 's1', overlay, writes,
    snap => ({draft: snap.draft ?? '', draftRev: snap.draftRev}),
    (content, draft) => (content.kind === 'llm' ? content.text : content.full),
    (base, current, write) => { write(); return {committed: true}; });
  const event = key => ({key, code:key, isComposing:false, altKey:false, ctrlKey:false, metaKey:false, shiftKey:false,
    prevented:false, stopped:false, preventDefault(){this.prevented=true;}, stopPropagation(){this.stopped=true;}});
  return {handler,dismissed,writes,overlay,event};
}

test('Escape dismisses only this session and turn, including repeated render', () => {
  const h = keyHarness();
  const event = h.event('Escape');
  h.handler(event);
  assert.equal(event.prevented, true);
  assert.equal(h.overlay.hideCalls, 1);
  assert.equal(h.writes.length, 0);
  assert.equal(compute('', {dismissed:h.dismissed}), null);
  assert.equal(compute('', {dismissed:new Set(['s1:1:20'])}).text, suggestion.text);
});

test('Tab copies a suggestion into the draft without submitting', () => {
  const h = keyHarness();
  h.handler(h.event('Tab'));
  assert.deepEqual(h.writes, [suggestion.text]);
  assert.equal(h.overlay.hideCalls, 1);
});

test('IME composition leaves Tab untouched', () => {
  const h = keyHarness();
  const event = h.event('Tab');
  event.isComposing = true;
  h.handler(event);
  assert.equal(event.prevented, false);
  assert.deepEqual(h.writes, []);
});

function writeOpsHarness(service) {
  return new Function('remoteOf', 'unwrapSettingsDoc', 'ctx', 'locale', 'SETTINGS_NAMESPACE',
    `${writeOpsSource}\nreturn writeOps;`)(() => ({settings:service}), doc => doc, {}, undefined, 'suggest-ghost');
}




test('identical suggestion text in different sessions has a different render key', () => {
  const ghostSource = closure('const ghostContent =', '/** ghostContent 的实际计算');
  const getGhost = new Function('settings','bound','composing','computeGhostContent','readDraftSnapshot', `
    let ghostContentCache = null;
    let settingsEpoch = 0;
    let lastCompletionSkip = '';
    ${ghostSource}
    return ghostContent;
  `)(settings(), {session:{getSnapshot:() => ({running:false})},input:{state:{getSnapshot:() => ({draft:''})}}},
    false, () => ({kind:'llm',text:suggestion.text,acceptKey:'Tab'}),
    snap => ({draft: snap.draft ?? '', draftRev: snap.draftRev}));
  assert.notEqual(getGhost('s1').key,getGhost('s2').key);
});

test('a disconnected editor is replaced even when the suggestion key did not change', () => {
  const renderSource = closure('const render =', '// 读取/订阅设置命名空间');
  const editor = {isConnected:true};
  const overlay = {currentTextarea:{isConnected:false}, attached:null, attach(node){this.attached=node;}, show(){}, hide(){}};
  new Function('sessions','currentSessionIdOf','resolve','scheduleInlineTrigger','retryPendingPull','ghostContent',
    'overlay','document','COMPOSER_SELECTOR','isComposerElement', `
      let shown = {key:'same',content:{kind:'llm',text:'继续'}};
      let cachedComposer = null;
      let validatedComposer = null;
      ${renderSource}
      render();
    `)({list:{getSnapshot:() => ({})}}, () => 's1', () => {}, () => {}, () => {},
      () => ({key:'same',content:{kind:'llm',text:'继续'}}), overlay, {querySelector:() => editor}, 'editor', () => true);
  assert.equal(overlay.attached,editor);
});
