import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifySuggestion} from '../lib/generate.js';
const user='请修复这个项目并运行测试。';
const assistant='修复完成，测试尚未执行。';
const transcript=(u=user,a=assistant)=>({pairs:[{role:'user',text:u},{role:'assistant',text:a}],sourceMessageSeqs:[2,3]});
const approval=(extra={})=>({accept:true,state:'unresolved',kind:'continue',goal_quote:user,progress_quote:assistant,...extra});
async function check(candidate,verdict=approval(),t=transcript()){
 let calls=0;
 const ctx={logger:{debug(){}},llm:{async *stream(){calls++;const text=JSON.stringify(verdict);yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};}}};
 return {accepted:await verifySuggestion(ctx,{signal:AbortSignal.timeout(1000)},t,candidate),calls};
}
test('approval without a real user quote cannot pass',async()=>{
 for(const goal_quote of [undefined,'','用户想要省钱',assistant])assert.equal((await check('继续运行测试。',approval({goal_quote}))).accepted,false);
});
test('action requires actual progress evidence; invented progress is rejected',async()=>{
 for(const progress_quote of [undefined,'','已经决定更换模型'])assert.equal((await check('继续运行测试。',approval({progress_quote}))).accepted,false);
});
test('unknown intent classification fails closed',async()=>{
 for(const kind of [undefined,'new_task','maybe'])assert.equal((await check('继续运行测试。',approval({kind}))).accepted,false);
});
test('invented concrete parameters and resource identifiers are rejected even with approval',async()=>{
 for(const candidate of ['把端口改成8321。','把预算设为99元。','换成 model-fake-v9。','打开 /Users/test/new-secret.txt。','发给 fake@example.com。']){
  const result=await check(candidate);assert.equal(result.accepted,false,candidate);assert.equal(result.calls,0,candidate);
 }
});
test('supported continuation and relevant question remain available',async()=>{
 assert.equal((await check('继续运行测试。')).accepted,true);
 assert.equal((await check('为什么会出现这个问题？',approval({kind:'question',progress_quote:null}))).accepted,true);
});
test('concrete objects from the actual conversation are allowed to reach semantic verification',async()=>{
 const u='请检查端口8321和 model-fake-v9，结果保存在 /tmp/report.txt。';
 const a='端口检查完成，model-fake-v9 尚未检查。';
 const v=approval({goal_quote:u,progress_quote:a});
 assert.equal((await check('继续检查 model-fake-v9，结果写到 /tmp/report.txt。',v,transcript(u,a))).accepted,true);
});
test('a known account mentioned by the assistant can be questioned without being a new download URL',async()=>{
 const u='帮我解释报告。',a='报告的收件人是 demo@example.com。';
 const v=approval({kind:'question',goal_quote:u,progress_quote:null});
 assert.equal((await check('demo@example.com 是报告的收件人吗？',v,transcript(u,a))).accepted,true);
});

test('new filenames are rejected; known basenames from a full path remain usable',async()=>{
 assert.equal((await check('打开 fabricated-report.pdf。')).accepted,false);
 const u='请检查 /tmp/report.pdf。',a='已找到文件，尚未检查内容。';
 assert.equal((await check('继续检查 report.pdf。',approval({goal_quote:u,progress_quote:a}),transcript(u,a))).accepted,true);
});
