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
    'isComposerTarget', 'parseAcceptKey', 'sessions', 'currentSessionIdOf', 'overlay', 'writes', `
      let shown = {key:'k', content:{kind:'llm', text:settings.suggestion.text, acceptKey:'Tab'}};
      const bound = {input:{setDraft:text => writes.push(text)}};
      let ghostContentCache = null;
      ${keySource}
      return onKeyDown;
    `);
  const handler = load(settings(), dismissed, {activeElement:editor}, Editor, Editor, () => true,
    () => event => event.key === 'Tab', {list:{getSnapshot:() => ({})}}, () => 's1', overlay, writes);
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

const writeOpsSource = closure('const writeOps =', '/**\n   * 停顿续写调度');
function writeOpsHarness(service) {
  return new Function('remoteOf', 'unwrapSettingsDoc', 'ctx', 'locale', 'SETTINGS_NAMESPACE',
    `${writeOpsSource}\nreturn writeOps;`)(() => ({settings:service}), doc => doc, {}, undefined, 'suggest-ghost');
}

test('settings operations use the current revision instead of zero', async () => {
  const calls = [];
  const service = {
    describe: async () => ({namespaces:[{ns:'suggest-ghost', revision:7}]}),
    mutate: async (ns, ops, revision) => { calls.push(revision); assert.equal(revision,7); },
  };
  assert.equal(await writeOpsHarness(service)('{"op":"pull","sessionId":"s1"}'), true);
  assert.deepEqual(calls,[7]);
});

test('a revision conflict re-describes once and retries without an unbounded loop', async () => {
  let revision = 7;
  const calls = [];
  const service = {
    describe: async () => ({namespaces:[{ns:'suggest-ghost', revision}]}),
    mutate: async (ns, ops, expected) => {
      calls.push(expected);
      assert.equal(expected,revision);
      if (calls.length === 1) { revision = 8; throw new Error('revision conflict'); }
    },
  };
  assert.equal(await writeOpsHarness(service)('{"op":"pull","sessionId":"s1"}'), true);
  assert.deepEqual(calls,[7,8]);
});

test('a session that becomes ready on a deferred render notifies the subscription owner', () => {
  let ready = false;
  let changes = 0;
  const session = {projections:{faceOf:() => ({})}};
  const conversation = {input:{for:() => ({})}};
  const sessions = {scope:() => ready ? {get:() => conversation} : undefined, sessionOf:() => session};
  const resolveSource = closure('const resolve =', '/** 计算当前应显示的幽灵内容');
  const resolve = new Function('sessions', 'pullHistory', 'PROJECTION_KEY', 'onBoundChanged', `
    let bound = null;
    let lastSessionId;
    ${resolveSource}
    return resolve;
  `)(sessions, () => {}, 'suggestGhost', () => { changes += 1; });
  resolve('s1');
  assert.equal(changes,0);
  ready = true;
  resolve('s1');
  assert.equal(changes,1);
});

test('identical suggestion text in different sessions has a different render key', () => {
  const ghostSource = closure('const ghostContent =', '/** ghostContent 的实际计算');
  const getGhost = new Function('settings','bound','composing','computeGhostContent', `
    let ghostContentCache = null;
    let settingsEpoch = 0;
    ${ghostSource}
    return ghostContent;
  `)(settings(), {session:{getSnapshot:() => ({running:false})},input:{state:{getSnapshot:() => ({draft:''})}}},
    false, () => ({kind:'llm',text:suggestion.text,acceptKey:'Tab'}));
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
