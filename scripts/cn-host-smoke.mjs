// Exercise the real host event listener without any model/network/profile access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = stripTypeScriptTypes(fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'));
const start = source.lastIndexOf("ctx.on('session/event',");
const end = source.indexOf('// 插件卸载时中止', start);
assert.ok(start >= 0 && end > start);

test('a new turn aborts stale prediction and removes the previous suggestion before the next turn ends', () => {
  const session = {id:'s1'};
  const controller = new AbortController();
  const state = {pending:{turn:1,controller}};
  const states = new WeakMap([[session,state]]);
  const tracked = [];
  const pushed = [];
  let handler;
  new Function('ctx','hotness','userTextOfEvent','ringPush','states','trackSuggestion','pushToClient','statePushOf','handleTurnEnd',
    source.slice(start,end))(
      {on:(name, listener) => {handler=listener;}}, {consume:() => {}}, () => null, () => {}, states,
      (id, suggestion) => tracked.push({id,suggestion}), payload => pushed.push(payload),
      id => ({suggestion:null,suggestionSessionId:id}), () => {},
    );
  handler(session,{type:'turn/start',data:{turn:2}});
  assert.equal(controller.signal.aborted,true);
  assert.equal(state.pending,undefined);
  assert.deepEqual(tracked,[{id:'s1',suggestion:null}]);
  assert.deepEqual(pushed,[{suggestion:null,suggestionSessionId:'s1'}]);
});
