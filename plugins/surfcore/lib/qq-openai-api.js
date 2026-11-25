import { windowsLoopbackProxy } from './study-codex.js';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { readOpenAiQqModelIds, rememberOpenAiQqModelIds } from './qq-openai-catalog-cache.js';
const execFileAsync=promisify(execFile);

// Optional paid transport. Deliberately separate from Codex-login credentials.
export const OPENAI_QQ_PROVIDER = 'surfcore-openai-api';
export const OPENAI_QQ_DEFAULT = 'gpt-6.2-sol';
export const OPENAI_QQ_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
function describeModel(id) {
  const thinking = ['gpt-6.2-sol','gpt-6.2-astra'].includes(id);
  const legacy = /^(gpt-4o(-mini)?|gpt-4o-(2024-08-06|2024-11-20)|gpt-4o-mini-2024-07-18)$/.test(id);
  const other = id === 'chat-latest' || /^gpt-4\.1(?:-(?:mini|nano))?(?:-2025-04-14)?$/.test(id);
  if (!thinking && !legacy && !other) return;
  return {id, name:legacy ? id + ' · 旧版' : id, legacy, supportsReasoning:thinking,
    contextWindow:thinking ? 500000 : legacy ? 128000 : id === 'chat-latest' ? 128000 : 1047576,
    inputModalities:['text','image'],
    // DSH represents non-reasoning models by omitting reasoning entirely.
    ...(thinking?{reasoning:{defaultEffort:'low',efforts:OPENAI_QQ_EFFORTS.map(id=>({id,name:id}))}}:{})};
}
export const OPENAI_QQ_MODELS = ['gpt-6.2-sol','gpt-6.2-astra','chat-latest','gpt-4o','gpt-4o-mini',
  'gpt-4.1','gpt-4.1-mini','gpt-4.1-nano'].map(describeModel);
export function requireOpenAiQqModel(id) {
  const model = describeModel(id);
  if (!model) throw new Error('QQ OpenAI API 模型兼容性未确认');
  return model;
}
export function requireOpenAiQqEffort(effort) {
  if (!OPENAI_QQ_EFFORTS.includes(effort)) throw new Error('QQ OpenAI API 思考强度无效');
  return effort;
}
const URL = 'https://api.openai.com/v1/responses';
const MODEL_URL = 'https://api.openai.com/v1/models';
const safeTokens = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
let systemProxyProbe, systemProxyCheckedAt = 0;
async function validateApiProxy() {
  const httpProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const anyProxy = httpProxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (anyProxy) {
    const enabled = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy') ||
      /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS || '');
    if (!httpProxy || !enabled || !process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
      throw new Error('QQ OpenAI API 未发送：需要 HTTPS_PROXY 和支持 NODE_USE_ENV_PROXY=1 的 DSH Node');
    }
  } else if (process.platform === 'win32') {
    if (!systemProxyProbe || Date.now()-systemProxyCheckedAt >= 30000) {
      systemProxyCheckedAt = Date.now();
      systemProxyProbe = windowsLoopbackProxy({openAiApi:true});
    }
    if (await systemProxyProbe) throw new Error('QQ OpenAI API 未发送：请将 Windows 代理配置到 DSH 的 HTTPS_PROXY 和 NODE_USE_ENV_PROXY=1');
  }
}

let windowsKey;
let windowsKeyAt=0;
export async function resolveOpenAiQqKey({
  env=process.env, platform=process.platform, readWindowsUserKey=windowsUserOpenAiKey,
}={}) {
  const inherited=env.OPENAI_API_KEY?.trim();
  if (inherited) return inherited;
  if (platform!=='win32') return '';
  try { return (await readWindowsUserKey())?.trim() || ''; } catch { return ''; }
}
async function windowsUserOpenAiKey() {
  if (!windowsKey || Date.now()-windowsKeyAt>=10_000) {
    windowsKeyAt=Date.now();
    const exe=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    // No credential in argv, files, or environment changes; stdout stays in the parent process.
    const expression="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write([Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User'))";
    windowsKey=execFileAsync(exe,['-NoProfile','-NoLogo','-NonInteractive','-Command',expression],
      {encoding:'utf8',windowsHide:true,timeout:2500,maxBuffer:4096}).then(({stdout})=>stdout.trim(),()=> '');
  }
  return windowsKey;
}
let discovery;
async function withCatalogSnapshot(result) {
  if (result.status==='ready' || [401,403].includes(result.httpStatus)) return result;
  const old=await readOpenAiQqModelIds();
  const models=(old?.modelIds || []).map(describeModel).filter(Boolean);
  return models.length ? {...result,status:'stale',reason:result.reason || 'network',
    models,unverified:[],verifiedAt:old.verifiedAt} : result;
}
export async function discoverOpenAiQqModels(options={}) {
  const {fetchImpl=fetch,force=false}=options;
  const real = fetchImpl === fetch;
  const key = Object.hasOwn(options,'key') ? options.key : await resolveOpenAiQqKey();
  if (!key?.trim()) {
    const result={status:'unconfigured',reason:'key',models:[],unverified:[]};
    return real ? withCatalogSnapshot(result) : result;
  }
  if (real && !force && discovery?.key === key && Date.now()-discovery.at < 60_000) return discovery.result;
  const result = (async () => {
    const fail=async r=>real ? withCatalogSnapshot(r) : r;
    try {
      if (real) { try { await validateApiProxy(); } catch { return fail({status:'unavailable',reason:'proxy',models:[],unverified:[]}); } }
      const res = await fetchImpl(MODEL_URL,{method:'GET',redirect:'error',signal:AbortSignal.timeout(7000),
        headers:{Authorization:'Bearer '+key.trim()}});
      if (!res.ok) return fail({status:'unavailable',httpStatus:Number(res.status),models:[],unverified:[]});
      const data = await res.json();
      if (!Array.isArray(data?.data)) return fail({status:'unavailable',reason:'response',models:[],unverified:[]});
      const ids = [...new Set(data.data.map(item=>item?.id).filter(id=>typeof id==='string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(id)))].sort();
      const models=ids.map(describeModel).filter(Boolean);
      const verifiedAt=Date.now();
      if (real && models.length) await rememberOpenAiQqModelIds(models.map(m=>m.id),{now:verifiedAt});
      return {status:'ready',models,unverified:ids.filter(id=>!describeModel(id)),verifiedAt};
    } catch { return fail({status:'unavailable',reason:'network',models:[],unverified:[]}); }
  })();
  if (real) discovery={key,at:Date.now(),result};
  return result;
}

export const QQ_OPENAI_MAX_OUTPUT = 4096;
// Conservative bound, not a tokenizer: count the complete serialized textual
// payload, protocol framing and provider image budgets, not base64 characters.
export function openAiQqEnvelopeWeight({model,instructions,input,text,reasoning}) {
  const meta=Buffer.byteLength(JSON.stringify({model,instructions,text,reasoning}),'utf8');
  const imageBudget=model.startsWith('gpt-4o-mini')?100000:8192;
  let total=4096+meta;
  for(const message of input) for(const part of message.content) {
    if(part.type==='input_image') total+=imageBudget;
    else total+=Buffer.byteLength(JSON.stringify(part),'utf8')+32;
  }
  return total;
}
// The adapter numbers image references, including images nested inside a tool result.
function hasImageRef(blocks) {
  return Array.isArray(blocks) && blocks.some(b=>Number.isInteger(b?.image) || hasImageRef(b?.content));
}
export async function openAiQqTurn({model,system,input,schema,signal,effort,purpose,maxTokens,stablePrefix,cacheFormat=true,imageAmendment=false}, options={}) {
  const {fetchImpl=fetch,timeoutMs=120000}=options;
  const details=requireOpenAiQqModel(model);
  if (details.supportsReasoning) requireOpenAiQqEffort(effort);
  signal?.throwIfAborted();
  const compaction=purpose==='compaction';
  const outputBudget=compaction && Number.isSafeInteger(maxTokens) && maxTokens>0?Math.min(maxTokens,QQ_OPENAI_MAX_OUTPUT):QQ_OPENAI_MAX_OUTPUT;
  const content = input.map(block => {
    if (block.type === 'text') return {type:'input_text',text:block.text};
    if (block.type === 'image') return {type:'input_image',image_url:block.url,detail:'auto'};
    throw new Error('QQ OpenAI API 输入类型无效');
  });
  const body={model,instructions:system,input:[{role:'user',content}],store:false,max_output_tokens:outputBudget,
    ...(details.supportsReasoning?{reasoning:{effort}}:{}),
    ...(compaction?{}:{text:{format:{type:'json_schema',name:'qq_next_action',strict:true,schema}}})};
  // Only the trusted system goes into developer. Keep QQ background and incoming messages at user authority.
  if (stablePrefix && !compaction && details.supportsReasoning && content[0]?.type==='input_text') {
    const envelope=JSON.parse(content[0].text);
    const [background,...rest]=envelope.messages;
    if (background?.role==='user' && /^【(?:会话背景|本会话总提示】)/u.test(background.content?.[0]?.text || '')) {
      const message=(role,text)=>({role,content:[{type:'input_text',text,prompt_cache_breakpoint:{mode:'explicit'}}]});
      body.prompt_cache_options={mode:'explicit'};
      body.input=[message('developer',system),message('user',JSON.stringify(background))];
      const stepFormat=cacheFormat && model==='gpt-6.2-sol' && process.env.SURFCORE_QQ_CACHE_FORMAT!=='off';
      const wake=rest[0];
      const textWakeWithToolImage=stepFormat && content.length>1 && wake?.role==='user' &&
        wake.content?.[0]?.text?.startsWith('【本轮】') && wake.content.every(b=>typeof b.text==='string') &&
        rest.some(m=>m.role==='tool' && hasImageRef(m.content));
      if (wake?.role==='user' && (content.length===1 || textWakeWithToolImage)) body.input.push(message('user',JSON.stringify(rest.shift())));
      // Keep all image references beside their bytes. A later correction and any subsequent
      // delivery receipts can then be presented in order, at their original user authority.
      let updates;
      if (textWakeWithToolImage && imageAmendment) {
        const lastImage=rest.findLastIndex(m=>hasImageRef(m.content));
        const change=rest.findIndex((m,i)=>i>lastImage && m.role==='user' && m.content?.length &&
          m.content.every(b=>typeof b.text==='string') && !m.content[0].text.trimStart().startsWith('<system-reminder>'));
        if (change>=0) updates=rest.splice(change);
      }
      const {tools,...dynamic}=envelope;
      if (tools?.length) body.input.push(message('user',JSON.stringify({tools})));
      content[0]={type:'input_text',text:JSON.stringify({...dynamic,messages:rest})};
      body.input.push({role:'user',content});
      if (stepFormat) {
        // A request-level action enum precedes even the developer prompt in the rendered prefix.
        // Keep that prefix stable while strictly constraining this step to its actual host menu.
        const format=body.text.format;
        body.text={format:{type:'text'}};
        body.input.splice(-1,0,{type:'configuration_update',text:{format}});
      }
      if (updates) body.input.push({role:'user',content:[{type:'input_text',text:JSON.stringify({messages:updates})+
        '\n以上是取图之后到达的补充及其后的实际动作。结合原授权，按最新要求作答。已有成功发送回执且本轮要求已满足时，选 end。'}]});
      delete body.instructions;
    }
  }
  if (compaction && openAiQqEnvelopeWeight(body) + outputBudget > details.contextWindow) {
    throw new Error('QQ 压缩输入按保守估算超出 '+model+' 的上下文预算；未提交到 API，未裁掉旧历史');
  }
  const key=Object.hasOwn(options,'key')?options.key:await resolveOpenAiQqKey();
  if (!key?.trim()) throw new Error('缺少 OPENAI_API_KEY；未发送请求');
  if (fetchImpl === fetch) await validateApiProxy();
  signal?.throwIfAborted();
  const timeout=AbortSignal.timeout(timeoutMs);
  const stop=signal?AbortSignal.any([signal,timeout]):timeout;
  let res;
  try {
    res = await fetchImpl(URL,{
      method:'POST',redirect:'error',signal:stop,
      headers:{'Authorization':'Bearer '+key.trim(),'Content-Type':'application/json'},
      body:JSON.stringify(body),
    });
  } catch {
    if (signal?.aborted) throw new Error('QQ OpenAI API 请求已停止');
    if (timeout.aborted) throw new Error('QQ OpenAI API 请求超时');
    throw new Error('QQ OpenAI API 连接失败');
  }
  if (!res.ok) throw new Error('QQ OpenAI API 请求失败 (HTTP ' + Number(res.status) + ')');
  let data;
  try { data = await res.json(); }
  catch {
    if (signal?.aborted) throw new Error('QQ OpenAI API 请求已停止');
    if (timeout.aborted) throw new Error('QQ OpenAI API 请求超时');
    throw new Error('QQ OpenAI API 响应无效');
  }
  if (data?.status !== 'completed' || !Array.isArray(data.output)) throw new Error('QQ OpenAI API 未完成生成');
  const parts = data.output.filter(i=>i?.type==='message' && i.role==='assistant' && Array.isArray(i.content)).flatMap(i=>i.content);
  if (parts.some(p=>p?.type==='refusal')) throw new Error('QQ OpenAI API 拒绝生成');
  const text = parts.filter(p=>p?.type==='output_text' && typeof p.text==='string').map(p=>p.text).join('');
  let output;
  if (compaction) {
    output=text.trim();
    if (!output) throw new Error('QQ 会话压缩未返回非空文本摘要；旧会话保持不变');
  } else {
    try { output=JSON.parse(text); } catch { throw new Error('QQ OpenAI API 未返回结构化结果'); }
    if (!output || typeof output !== 'object' || Array.isArray(output) ||
        Object.keys(output).length !== schema.required.length ||
        !schema.required.every(k => typeof output[k] === 'string') ||
        !schema.properties.action.enum.includes(output.action)) throw new Error('QQ OpenAI API 结构化结果校验失败');
  }
  const u=data.usage;
  const usage = u ? {inputTokens:safeTokens(u.input_tokens),outputTokens:safeTokens(u.output_tokens),
    cachedInputTokens:safeTokens(u.input_tokens_details?.cached_tokens),
    ...(u.input_tokens_details?.cache_write_tokens!==undefined ? {cacheWriteInputTokens:safeTokens(u.input_tokens_details.cache_write_tokens)} : {}),
    reasoningOutputTokens:safeTokens(u.output_tokens_details?.reasoning_tokens)} : undefined;
  return {output,usage};
}
