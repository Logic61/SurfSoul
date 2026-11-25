// Experiment only. The caller supplies synthetic messages; this module never reads QQ history or configuration.
import {performance} from 'node:perf_hooks';
import {openAiQqTurn} from '../plugins/surfcore/lib/qq-openai-api.js';
import {LOAD} from '../plugins/surfcore/lib/qq-context-actions.js';
import {jevDecision} from '../plugins/surfcore/lib/qq-jev.js';

const threshold=0.8;
const descriptions={
  qq_list_stickers:'列出本人收藏的表情，查找现有表情的名称或编号。',
  bilibili_video:'通过明确的视频编号查哔哩哔哩视频的详情，如标题、UP 主或时长。',
  qq_get_forward_msg:'读取合并转发的聊天记录内页。',
  qq_get_message_images:'读取聊天消息附带的实际图片以观察画面内容。'
};
const standard='standard';
const instructions='根据当前来信判断：是否明确需要预先装载某一个只读工具说明？候选项只列尚未装载的工具。已具备能力、闲聊、否定使用、意图不明或需要综合判断时，选择 standard。';
const decide=(state,question)=>jevDecision(state,question,{timeoutMs:25000});
async function choose(text,hidden,minimum=threshold) {
  const criteria={standard:'继续现有主模型流程，交给它决定。',...Object.fromEntries(hidden.map(n=>[n,descriptions[n]]))};
  const r=await decide(text,{type:'choice',instructions,criteria});
  const raw=r.answer.choice,prob=r.answer.probabilities?.[raw];
  if (!Object.hasOwn(criteria,raw) || !Number.isFinite(prob)) throw Error('Invalid choice or probability');
  const {answer,...usage}=r;
  return {...usage,raw,prob,selected:prob>=minimum?raw:standard};
}
function keywordChoice(text,hidden) {
  const patterns={qq_list_stickers:/收藏表情|收藏.{0,8}(表情|动图)|表情.{0,4}(编号|收藏)|表情包/,
    bilibili_video:/BV[a-z0-9]{10}/i,qq_get_forward_msg:/合并转发|转发记录/,
    qq_get_message_images:/看看.{0,4}图|图里|图上/};
  const matches=hidden.filter(n=>patterns[n].test(text));
  return matches.length===1?matches[0]:standard;
}

// Intercept the first model decision only. A hit preloads one advertised schema through
// the real adapter's LOAD path. Sol still chooses every tool, its arguments and the QQ reply.
export function makeExperiment(arm,question,{previous,minimum=threshold}={}) {
  const modelCalls=[],decisions=[];
  let first=true;
  async function run(req) {
    if (first && arm!=='sol') {
      first=false;
      const env=JSON.parse(req.input[0].text);
      const hidden=(env.toolDirectory?.names??[]).filter(n=>Object.hasOwn(descriptions,n));
      if (hidden.length && req.schema.properties.action.enum.includes(LOAD)) {
        let decision;
        if (arm==='jev') {
          const state=previous?{上一条助手消息:previous,最新用户消息:question}:question;
          try {decision=await choose(state,hidden,minimum);}
          catch (err) {decision={selected:standard,error:err.message};}
        } else decision={selected:keywordChoice([previous,question].filter(Boolean).join('\n'),hidden)};
        decisions.push(decision);
        if (hidden.includes(decision.selected)) return {output:{action:LOAD,arguments:JSON.stringify({names:[decision.selected]}),text:'',note:''}};
      }
    }
    const started=performance.now(),response=await openAiQqTurn(req);
    modelCalls.push({...response.usage,ms:Math.round(performance.now()-started),action:response.output.action});
    return response;
  }
  return {run,modelCalls,decisions};
}

const S='qq_list_stickers',V='bilibili_video',F='qq_get_forward_msg',I='qq_get_message_images',N=standard;
const probes=[
  ['s1','把收藏表情中那只趴在键盘上的猫的编号告诉我。',S],
  ['s2','周一早八那个会动的小人，帮我翻翻你自己攒的那一堆，我只要它的名字。',S],
  ['s3','以前存的梗图都叫啥？把你自己那本图册的目录翻出来。',S],
  ['v1','BV1xx411c7mD 的 UP 主是谁？查一下。',V],
  ['v2','我说的片子编号是 BV1yy411c7mE，帮我看眼多长时间。',V],
  ['v3','这两个番剧哪部值得看？我还没挑具体视频。',N],
  ['f1','把这个合并转发打开，最里面那个人说周几？',F],
  ['f2','我刚扔过来一个聊天记录合集，点进去看看最后那句原话。',F],
  ['i1','看上面附件那张图，第二行写的是哪两个字？',I],
  ['i2','我发的是一张截图。右下角按钮是什么颜色？',I],
  ['n1','不用翻收藏表情；我只是说那个名字好笑，回个哈哈就行。',N],
  ['n2','“把合并转发点开”是他说过的话。我没发记录给你，只想问这句话自然吗。',N],
  ['n3','看起来跟图里似的，今天晚霞真漂亮。',N],
  ['n4','这个 BV1xx411c7mD 我已经查完了。帮我润色这句标题，不需要再去看视频。',N],
  ['n5','之前约七点，现在改周五八点北门，确认一下。',N],
  ['n6','网页上有条最新公告，帮我查原文。',N],
  ['n7','他刚说的那个是啥来着？',N],
  ['n8','那张动图和上回的视频片段都可能是他说的，你先问我指哪个。',N]
];
const checks=[
  ['covered','补答雨天集合点，并保留入场时间。','17:42 入场，下雨就在栖石厅集合。',true],
  ['missing','补答雨天集合点，并保留入场时间。','17:42 入场，记得带伞。',false],
  ['old-value','确认改到北门、周五八点。','好，周五七点北门见。',false],
  ['paraphrase','说明候场地点青榆棚，雨天集合地点栖石厅。','先在青榆棚等，要是下雨就到栖石厅碰头。',true],
  ['conditional','晴天青榆棚，雨天栖石厅。','晴天栖石厅，下雨就到青榆棚。',false],
  ['negated','原约定七点已取消，要明确现在是八点。','改成八点了，七点那场就不用赶。',true]
];
export async function runDecisionProbes() {
  const hidden=Object.keys(descriptions);
  for (const [id,text,expected] of probes) {
    console.log(JSON.stringify({kind:'choice',id,expected,keyword:keywordChoice(text,hidden),...await choose(text,hidden)}));
  }
  for (const [id,requirement,draft,expected] of checks) {
    const r=await decide({requirement,draft},{type:'noul',instructions:'草稿是否已经答全要求中的每一项，并保持原意和对应关系？'});
    console.log(JSON.stringify({kind:'coverage',id,expected,p:r.answer.noul,ms:r.ms,input:r.input,output:r.output,cost:r.cost,model:r.model}));
  }
}

export async function runHistoryProbes() {
  // Two identical current messages can require different tools. Each row is a fresh fixture.
  const pairs=[
    ['h1','我这边可以翻翻我收藏的表情，看看那只戴帽子的海豹有没有编号。','好，那你看看吧。',S],
    ['h2','你贴的 BV1zz411c7mF，我可以帮你查这段视频的作者和时长。','好，那你看看吧。',V],
    ['h3','你刚发的合并聊天记录有好几页。我可以打开看看最后那个人说了什么。','好，那你看看吧。',F],
    ['h4','你附的那张车站照片，我可以读读右下角的站名。','好，那你看看吧。',I],
    ['h5','我可以帮你把这句道歉的话改得自然一点。','好，那你看看吧。',N],
    ['h6','我可以帮你找收藏的海豹表情。','算啦，我找到啦，晚安。',N]
  ];
  const hidden=Object.keys(descriptions);
  for(const [id,previous,current,expected] of pairs) {
    for(const history of (Number(id.slice(1))%2?[false,true]:[true,false])) {
      const state=history?{上一条助手消息:previous,最新用户消息:current}:current;
      console.log(JSON.stringify({kind:'history',id,history,expected,...await choose(state,hidden)}));
    }
  }
}
