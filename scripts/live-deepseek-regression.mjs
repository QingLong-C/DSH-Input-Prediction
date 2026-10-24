import {generateSuggestion,verifySuggestion} from '../lib/generate.js';
const key=process.env.PREDICTION_API_KEY;
const base=process.env.PREDICTION_BASE_URL;
if(!key || !base) throw Error('Set PREDICTION_API_KEY and PREDICTION_BASE_URL');
const model='deepseek-v4.1-flash';
async function* stream(options){
 const response=await fetch(base.replace(/\/$/, '')+'/chat/completions',{method:'POST',signal:options.signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'system',content:options.system},...options.messages.map(m=>({role:m.role,content:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')}))],stream:true,max_tokens:options.maxTokens})});
 if(!response.ok)throw Error('HTTP '+response.status);
 const decoder=new TextDecoder();
 let buffer='',text='',finish=null;yield {type:'block-start',index:0,blockType:'text'};
 for await(const bytes of response.body){buffer+=decoder.decode(bytes,{stream:true});let i;
  while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line.startsWith('data: ')||line==='data: [DONE]')continue;
   const event=JSON.parse(line.slice(6));if(event.error)throw Error(JSON.stringify(event.error));
   for(const choice of event.choices??[]){if(choice.finish_reason)finish=choice.finish_reason;const delta=choice.delta?.content;if(delta){text+=delta;yield {type:'text-delta',index:0,text:delta};}}
  }
 }
 yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:finish==='length'?'max-tokens':finish==='stop'?'stop':'error'}};
}

const cfg={provider:'regression',model,maxInputBytes:32768,maxRecentTurns:12,maxOutputTokens:512,timeoutMs:60000,maxTranscriptChars:24000,maxSuggestionChars:240};
function fixture(user,answer){return [{type:'turn/start',seq:1,data:{turn:1}},{type:'user/message',seq:2,data:{role:'user',source:{kind:'user'},content:[{type:'text',text:user}]}},{type:'assistant/message',seq:3,data:{turn:1,message:{role:'assistant',content:[{type:'text',text:answer}]}}},{type:'turn/end',seq:4,data:{turn:1,reason:{kind:'completed'}}}];}
const overview=fixture('你帮我看一下当前安装的输入预测插件，先了解一下吧。','已经检查，插件已启用，提供回复后的输入建议。需要我把它接到便宜模型上省 token 吗？');
const continuation=fixture('请修复问题并运行测试。','问题已经修复，尚未运行测试。要继续运行测试吗？');
const cases=[['overview',overview],['requested-action',continuation]];
const results=[];
for(const [name,rows] of cases){let calls=0;const ctx={logger:{debug(){}},llm:{stream(options){calls++;return stream(options);}}};const session={id:'quality-fixture',snapshotEvents:()=>rows};const t=performance.now();const result=await generateSuggestion(ctx,cfg,session,1,AbortSignal.timeout(65000),'zh','zh');const row={name,suggestion:result.suggestion?.text??null,calls,ms:Math.round(performance.now()-t)};results.push(row);console.log(JSON.stringify(row));}
if(results.some(r => r.name==='overview' && r.suggestion!==null)) process.exitCode=1;
if(results.some(r => r.name==='requested-action' && !r.suggestion)) process.exitCode=1;

const gateCases=[
 ['completed-task-question-drift','下载这个视频。','视频已经下载到桌面并验收通过。','批量下载这个作者的其它视频怎么弄？',false],
 ['completed-task-new-deliverable','把报告保存为PDF。','PDF已保存，任务完成。','再做个演示文稿怎么弄？',false],
 ['invented-port','帮我分析连接故障，先不要改配置。','已经分析完成。可以尝试改端口。','把端口改成8321。',false],
 ['invented-path','帮我了解项目结构。','这是项目结构说明。','打开 /Users/test/another-project。',false],
 ['invented-model','先了解插件怎么工作。','插件会请求模型生成预测。','换成 gpt-fake-v9。',false],
 ['invented-account','帮我解释报告。','报告已解释。','发给 fake@example.com。',false],
 ['invented-budget','帮我比较两个服务，暂时不决定。','两个服务各有优劣。','我选99元的套餐。',false],
 ['invented-preference','帮我比较方案甲和方案乙，暂时不选。','甲速度快，乙成本低。','我更喜欢速度快的，就用甲。',false],
 ['invented-fact','帮我解释付款流程。','这是付款流程。','我已经付过款了，继续吧。',false],
 ['task-drift','下载这个视频。','视频已下载并校验完成。','接下来剪成短视频发出去。',false],
 ['invented-deadline','帮我了解项目的实现方式，先不排期。','实现方式已介绍。','那就明天下午交付吧。',false],
 ['planned-next-step','我想比较内存和硬盘，先只解释内存，硬盘下一轮讲。','内存是临时工作区，内存部分已解释。','现在解释硬盘。',true],
 ['relevant-comparison','帮我比较甲乙方案，先介绍功能，下一轮比较维护成本。','甲乙的功能已介绍。','这两种方案的维护成本有什么区别？',true],
 ['known-parameter-question','请解释连接方案。','连接方案使用端口8321，安全性尚未介绍。','8321这个端口的访问安全怎么保证？',true],

 ['completed','请修复问题并运行测试。','修复完成，全部测试通过。','继续运行测试。',false],
 ['unfinished','请修复问题并运行测试。','修复完成，测试尚未运行。','继续运行测试。',true],
 ['unsolicited','先了解一下这个项目。','项目介绍完了，要换便宜模型吗？','换成便宜模型吧。',false],
 ['invented-choice','帮我比较两个方案，暂时不决定。','A 更快，B 更省钱，你选哪个？','选 A 吧。',false],
 ['answered','这个插件会额外消耗 token 吗？','会，生成建议和核对都会消耗 token。','这个插件会额外消耗 token 吗？',false],
];
for(const [name,user,assistant,candidate,expected] of gateCases){
 const transcript={pairs:[{role:'user',text:user},{role:'assistant',text:assistant}],sourceMessageSeqs:[2,3]};
 const actual=await verifySuggestion({logger:{debug(){}},llm:{stream}}, {provider:'regression',model,maxTokens:512,signal:AbortSignal.timeout(60000)},transcript,candidate);
 console.log(JSON.stringify({name,expected,actual,passed:actual===expected}));
 if(actual!==expected)process.exitCode=1;
}
