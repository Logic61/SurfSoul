import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

export const MODELSNEXUS_ENGINE = 'modelsnexus';
export const MODELSNEXUS_PROVIDER = 'surfcore-modelsnexus';
export const MODELSNEXUS_URL = 'https://modelsnexus.org';
const families = {claude:'CLAUDE_KEY',gemini:'GEMINI_ROUTER_KEY'};
const execFileAsync = promisify(execFile);
const windowsKeys = new Map();
const catalogCache = new Map();
const outputLimit = 4096;

function describe(id) {
  if (typeof id !== 'string' || id.length > 120 || id.trim() !== id) return;
  const match = /^(?:(anthropic|google)\/)?(claude|gemini)-[a-z0-9]+(?:[-.][a-z0-9]+)*$/i.exec(id);
  if (!match || /(?:^|[-.])(?:image|tts|audio|live|embedding)(?:[-.]|$)/i.test(id)) return;
  const namespace = match[1]?.toLowerCase();
  const family = match[2].toLowerCase();
  if (namespace && namespace !== (family === 'claude' ? 'anthropic' : 'google')) return;
  return {id,name:id,family,inputModalities:['text','image'],contextWindow:128000};
}

export function requireModelsNexusModel(id) {
  const model = describe(id);
  if (!model) throw new Error('请选择 ModelsNexus 目录中的 Claude 或 Gemini 对话模型');
  return model;
}

async function readWindowsKey(name) {
  const recent = windowsKeys.get(name);
  if (recent && Date.now()-recent.at < 10000) return recent.value;
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  // name is selected only from the fixed families map. Never put the value in argv or logs.
  const expression = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write([Environment]::GetEnvironmentVariable('${name}','User'))`;
  const value = execFileAsync(exe,['-NoProfile','-NoLogo','-NonInteractive','-Command',expression],
    {encoding:'utf8',windowsHide:true,timeout:2500,maxBuffer:4096}).then(({stdout})=>stdout.trim(),()=> '');
  windowsKeys.set(name,{at:Date.now(),value});
  return value;
}

export async function resolveModelsNexusKey(family,{env=process.env,platform=process.platform,readUserKey=readWindowsKey}={}) {
  if (!Object.hasOwn(families,family)) return '';
  const name = families[family];
  const inherited = env[name]?.trim();
  if (inherited) return inherited;
  if (platform !== 'win32') return '';
  try { return (await readUserKey(name))?.trim() || ''; } catch { return ''; }
}

export async function discoverModelsNexusModels({fetchImpl=fetch,readKey=resolveModelsNexusKey,force=false}={}) {
  const statuses = await Promise.all(Object.keys(families).map(async family => {
    const key = (await readKey(family))?.trim();
    const result = (status, details={}) => ({family,status,models:[],...details});
    if (!key) return result('unconfigured');
    const cacheable = fetchImpl === fetch && readKey === resolveModelsNexusKey;
    const prior = cacheable ? catalogCache.get(family) : undefined;
    if (!force && prior?.key === key && Date.now()-prior.at < 60000) return prior.result;
    const pending = (async () => {
      try {
        const response = await fetchImpl(`${MODELSNEXUS_URL}/v1/models`,{method:'GET',redirect:'error',
          signal:AbortSignal.timeout(7000),headers:{Authorization:'Bearer '+key}});
        if (!response.ok) return result('unavailable',{httpStatus:Number(response.status)});
        const data = await response.json();
        if (!Array.isArray(data?.data)) return result('unavailable');
        const models = new Map();
        for (const item of data.data) {
          const model = describe(item?.id);
          if (model?.family !== family) continue;
          if (Array.isArray(item.supported_endpoint_types) && !item.supported_endpoint_types.includes('openai')) continue;
          models.set(model.id,model);
        }
        return result('ready',{models:[...models.values()].sort((a,b)=>a.id.localeCompare(b.id))});
      } catch { return result('unavailable'); }
    })();
    if (cacheable) catalogCache.set(family,{key,at:Date.now(),result:pending});
    return pending;
  }));
  return {models:statuses.flatMap(s=>s.models),families:statuses.map(({models,...status})=>({...status,count:models.length}))};
}

const safeTokens = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;

export async function modelsNexusTurn({model,system,input,schema,signal,purpose,maxTokens},
  {fetchImpl=fetch,readKey=resolveModelsNexusKey,timeoutMs=120000}={}) {
  const details = requireModelsNexusModel(model);
  signal?.throwIfAborted();
  const compaction = purpose === 'compaction';
  const max_tokens = compaction && Number.isSafeInteger(maxTokens) && maxTokens>0 ? Math.min(maxTokens,outputLimit) : outputLimit;
  const instructions = compaction ? system : system+'\n只输出一个 JSON 对象。字段与动作必须符合此 JSON Schema：\n'+JSON.stringify(schema);
  const content = input.map(block=>{
    if (block.type === 'text') return {type:'text',text:block.text};
    if (block.type === 'image') return {type:'image_url',image_url:{url:block.url}};
    throw new Error('ModelsNexus 输入类型无效');
  });
  const weight = 4096+Buffer.byteLength(instructions,'utf8')+content.reduce((n,c)=>n+(c.type==='text' ?
    Buffer.byteLength(JSON.stringify(c),'utf8')+32 : 8192),0);
  if (compaction && weight+max_tokens>details.contextWindow) {
    throw new Error('ModelsNexus 压缩输入超出保守上下文预算；未提交，历史保持不变');
  }
  const key = (await readKey(details.family))?.trim();
  if (!key) throw new Error(`缺少 ${families[details.family]}；未向 ModelsNexus 发送请求`);
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal,timeout]) : timeout;
  const body = {model,max_tokens,messages:[{role:'system',content:instructions},{role:'user',
    content:content.every(c=>c.type==='text') ? content.map(c=>c.text).join('\n') : content}]};
  let response, data;
  try {
    response = await fetchImpl(`${MODELSNEXUS_URL}/v1/chat/completions`,{method:'POST',redirect:'error',signal:stop,
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if (response.ok) data = await response.json();
  } catch {
    if (signal?.aborted) throw new Error('ModelsNexus 请求已停止');
    if (timeout.aborted) throw new Error('ModelsNexus 请求超时');
    throw new Error(response ? 'ModelsNexus 响应无效' : 'ModelsNexus 连接失败');
  }
  if (!response.ok) throw new Error(`ModelsNexus 请求失败 (HTTP ${Number(response.status)})`);
  const choice = data?.choices?.[0];
  if (choice?.finish_reason !== 'stop' || choice.message?.refusal || typeof choice.message?.content !== 'string') {
    throw new Error('ModelsNexus 未正常完成生成');
  }
  let output = choice.message.content.trim();
  if (compaction) {
    if (!output) throw new Error('ModelsNexus 未返回非空文本摘要；历史保持不变');
  } else {
    const json = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(output)?.[1] ?? output;
    try { output = JSON.parse(json); } catch { throw new Error('ModelsNexus 未返回动作 JSON'); }
    if (!output || typeof output !== 'object' || Array.isArray(output) ||
        Object.keys(output).length !== schema.required.length ||
        !schema.required.every(k=>typeof output[k]==='string') || !schema.properties.action.enum.includes(output.action)) {
      throw new Error('ModelsNexus 动作校验失败');
    }
  }
  const u = data.usage;
  const usage = u ? {inputTokens:safeTokens(u.prompt_tokens),outputTokens:safeTokens(u.completion_tokens),
    cachedInputTokens:safeTokens(u.prompt_tokens_details?.cached_tokens),
    cacheWriteInputTokens:safeTokens(u.prompt_tokens_details?.cache_write_tokens),
    reasoningOutputTokens:safeTokens(u.completion_tokens_details?.reasoning_tokens)} : undefined;
  return {output,usage};
}
