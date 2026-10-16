import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateSuggestion} from '../lib/generate.js';
const config={provider:'fixture',model:'fixture',maxInputBytes:4096,maxOutputTokens:512,timeoutMs:1000,maxTranscriptChars:12000,maxSuggestionChars:240};
const session={id:'fixture',snapshotEvents:()=>[
{type:'turn/start',seq:1,data:{turn:1}},
{type:'user/message',seq:2,data:{role:'user',source:{kind:'user'},content:[{type:'text',text:'先了解一下这个插件，能省 token 吗？'}]}},
{type:'assistant/message',seq:3,data:{turn:1,message:{role:'assistant',content:[{type:'text',text:'它需要额外请求。要不要关掉它？'}]}}},
{type:'turn/end',seq:4,data:{turn:1,reason:{kind:'completed'}}}]};
function harness(outputs){const calls=[];return{calls,ctx:{logger:{debug(){}},llm:{async *stream(options){calls.push(options);const text=outputs[calls.length-1];assert.equal(typeof text,'string');yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text};yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'finish',reason:{kind:'stop'}};}}}};}
async function run(h){return generateSuggestion(h.ctx,config,session,1,new AbortController().signal,'zh','zh');}
test('structured null abstains without a second request',async()=>{const h=harness(['{"suggestion":null}']);assert.equal((await run(h)).suggestion,undefined);assert.equal(h.calls.length,1);});
test('unapproved action is withheld after an independent intent check',async()=>{const h=harness(['{"suggestion":"帮我关掉这个插件。"}','{"accept":false,"reason":"用户只在了解"}']);assert.equal((await run(h)).suggestion,undefined);assert.equal(h.calls.length,2);});
test('approved relevant question is returned as text, not JSON',async()=>{const h=harness(['{"suggestion":"每轮预测会多用多少 token？"}','{"accept":true,"reason":"用户询问 token 消耗"}']);assert.equal((await run(h)).suggestion.text,'每轮预测会多用多少 token？');assert.match(h.calls[1].messages[0].content[0].text,/先了解一下/);});
test('malformed, non-boolean or missing approval fails closed',async()=>{for(const verdict of ['yes','{}','{"accept":"true"}']){const h=harness(['{"suggestion":"帮我关掉插件。"}',verdict]);assert.equal((await run(h)).suggestion,undefined);}});
test('unstructured candidate fails closed without retries',async()=>{const h=harness(['帮我关掉插件。']);assert.equal((await run(h)).suggestion,undefined);assert.equal(h.calls.length,1);});
