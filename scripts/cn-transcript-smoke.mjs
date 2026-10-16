// One-shot prediction must use user-authored dialogue, not injected harness context.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTranscript } from '../lib/generate.js';
import { suggestionLanguage } from '../lib/transcript.js';

const user = '请用两句话解释电脑的内存和硬盘有什么区别。';
const answer = '内存暂存正在运行的数据，关机后消失；硬盘长期保存文件，关机后仍在。';
function session() {
  const events = [
    {type:'turn/start',seq:1,data:{turn:1}},
    {type:'user/message',seq:2,data:{id:'u',role:'user',source:{kind:'user'},content:[{type:'text',text:user}]}},
    {type:'user/message',seq:3,data:{id:'i',role:'user',source:{kind:'workspace-instructions'},content:[{type:'text',text:'<system-reminder>Injected workspace rules. '.repeat(400)}]}},
    {type:'user/message',seq:4,data:{id:'t',role:'user',source:{kind:'time-context'},content:[{type:'text',text:'Time sampled while preparing turn 1. Browser time zone for this request: Asia/Shanghai.'}]}},
    {type:'assistant/message',seq:5,data:{turn:1,step:1,message:{id:'a',role:'assistant',source:{kind:'model',provider:'test',model:'fixture'},content:[{type:'text',text:answer}]}}},
    {type:'turn/end',seq:6,data:{turn:1,reason:{kind:'completed'}}},
  ];
  return {snapshotEvents:() => events};
}

test('injected user-role context cannot evict the real Chinese question from the prediction budget', () => {
  const transcript = buildTranscript(session(),3,12000,4096,true,1500);
  assert.deepEqual(transcript.pairs,[{role:'user',text:user},{role:'assistant',text:answer}]);
  assert.deepEqual(transcript.sourceMessageSeqs,[2,5]);
  assert.equal(suggestionLanguage(transcript.pairs,'zh'),'简体中文');
});

test('long assistant replies cannot evict the user goal or latest question', async () => {
  const { trimTranscript, frameTranscript } = await import('../lib/transcript.js');
  const pairs=[{role:'user',text:'先了解这个项目，不要改配置。'},{role:'assistant',text:'项目说明。'.repeat(1500)},{role:'user',text:'它能省 token 吗？'},{role:'assistant',text:'详细说明。'.repeat(1500)+'最终结论：这是输入辅助功能。'}];
  const trimmed=trimTranscript(pairs,[1,2,3,4],12000,4096);
  assert.ok(trimmed.pairs.some(p=>p.text===pairs[0].text));
  assert.ok(trimmed.pairs.some(p=>p.text===pairs[2].text));
  assert.ok(trimmed.pairs.at(-1).text.endsWith('最终结论：这是输入辅助功能。'));
  assert.ok(Buffer.byteLength(frameTranscript(trimmed.pairs))<=4096);
  assert.equal(trimmed.pairs.length,trimmed.sourceMessageSeqs.length);
});
