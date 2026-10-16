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
test('approved relevant question is returned as text, not JSON',async()=>{const h=harness(['{"suggestion":"每轮预测会多用多少 token？"}','{"accept":true,"state":"unresolved","kind":"question","goal_quote":"能省 token 吗？","progress_quote":null,"reason":"用户询问 token 消耗"}']);assert.equal((await run(h)).suggestion.text,'每轮预测会多用多少 token？');assert.match(h.calls[1].messages[0].content[0].text,/先了解一下/);});
test('malformed, non-boolean or missing approval fails closed',async()=>{for(const verdict of ['yes','{}','{"accept":"true"}']){const h=harness(['{"suggestion":"帮我关掉插件。"}',verdict]);assert.equal((await run(h)).suggestion,undefined);}});
test('unstructured candidate fails closed without retries',async()=>{const h=harness(['帮我关掉插件。']);assert.equal((await run(h)).suggestion,undefined);assert.equal(h.calls.length,1);});

test('completed, unsupported, uncertain and missing task states fail closed even with accept=true',async()=>{for(const state of ['completed','unsupported','uncertain',null]){const h=harness(['{"suggestion":"继续运行测试。"}',JSON.stringify({accept:true,state})]);assert.equal((await run(h)).suggestion,undefined);}});
test('quality gate receives ordered assistant progress as well as user intent',async()=>{const h=harness(['{"suggestion":"每轮预测会多用多少 token？"}','{"accept":true,"state":"unresolved","kind":"question","goal_quote":"先了解一下","progress_quote":null}']);await run(h);const input=JSON.parse(h.calls[1].messages[0].content[0].text);assert.equal(input.conversation[0].role,'user');assert.equal(input.conversation[1].role,'assistant');assert.match(input.conversation[1].text,/额外请求/);assert.equal(input.user_messages.length,1);});

const urlSession=(user,assistant='视频已下载并验收通过。')=>({id:'url-fixture',snapshotEvents:()=>[
{type:'turn/start',seq:1,data:{turn:1}},
{type:'user/message',seq:2,data:{role:'user',source:{kind:'user'},content:[{type:'text',text:user}]}},
{type:'assistant/message',seq:3,data:{turn:1,message:{role:'assistant',content:[{type:'text',text:assistant}]}}},
{type:'turn/end',seq:4,data:{turn:1,reason:{kind:'completed'}}}]});
const original='https://example.com/share/video/1234567890123456784/';
async function runUrl(candidate,user='下载：'+original,assistant){const h=harness([JSON.stringify({suggestion:candidate}),JSON.stringify({accept:true,state:'unresolved',kind:'question',goal_quote:user.slice(0,100),progress_quote:null})]);const result=await generateSuggestion(h.ctx,config,urlSession(user,assistant),1,new AbortController().signal,'zh','zh');return {h,result};}
test('fabricated incremented video URL is rejected even if model would approve',async()=>{const {h,result}=await runUrl('下载这个：'+original.replace('6784','6785'));assert.equal(result.suggestion,undefined);assert.equal(h.calls.length,1);});
test('changed query, shortened URL and markdown destination cannot introduce a new target',async()=>{for(const url of [original+'?id=2','https://v.douyin.com/madeup/','https://evil.test/video']){const {result}=await runUrl(`[下载](${url})`);assert.equal(result.suggestion,undefined);}});
test('assistant-only URL does not count as user-provided evidence',async()=>{const {result}=await runUrl('下载 https://example.com/next','下载：'+original,'完成了。还可以下载 https://example.com/next');assert.equal(result.suggestion,undefined);});
test('exact user-provided URL and URL-free follow-up still pass intent verification',async()=>{for(const text of ['检查这个文件对应的视频：'+original,'这个视频的编码是什么？']){const {h,result}=await runUrl(text);assert.equal(result.suggestion.text,text);assert.equal(h.calls.length,2);}});

test('scheme-less and protocol-relative download links are also grounded',async()=>{for(const url of ['example.com/new.mp4','//example.com/new.mp4','www.example.com/new.mp4','magnet:?xt=urn:btih:invented']){assert.equal((await runUrl('下载：'+url)).result.suggestion,undefined);}});
