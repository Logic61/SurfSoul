import { randomUUID } from 'node:crypto';
import { readQqSessionContext } from '../../../src/qq-session-context.js';
import { resolveQqWake, stripWakeSeal } from '../../../src/qq-wake-checkpoint.js';
import { prepareQqContext, READ, LOAD } from './qq-context-actions.js';
import { planQqModelInput } from './qq-input-plan.js';
import { createDeliveryFinish } from './qq-delivery-finish.js';
import { createQqPreloader } from './qq-jev.js';
import { createSourceWorker, isDirectPageRequest } from './qq-source-worker.js';
import { codexTurn } from './qq-codex-cli.js';
import { codexEffortFor, readCodexCatalog, requireCodexModel } from './qq-codex-catalog.js';

import { OPENAI_QQ_PROVIDER, OPENAI_QQ_MODELS, openAiQqTurn, requireOpenAiQqModel } from './qq-openai-api.js';
import { MODELSNEXUS_PROVIDER, discoverModelsNexusModels, modelsNexusTurn, requireModelsNexusModel } from './qq-modelsnexus.js';

export const name = 'surfcore-qq-codex';
export const inject = ['llm','attachments'];
export const provider = 'surfcore-codex-cli';

// Only model-visible DSH blocks are translated. A QQ session bearer is a
// local bridge credential: the model can refer to it by handle, never by value.
async function modelInput(options, supportsImages, compaction, plan) {
  const handles = new Map();
  const inverse = new Map();
  // QQ media IDs can also be 32 hex characters. Only treat that length as
  // a credential when it appeared under a bridge token label or argument.
  const shortTokens = new Set();
  function collectShortTokens(blocks) {
    for (const block of blocks || []) {
      const text = block.type === 'text' ? block.text : block.type === 'tool-call' ? block.arguments : '';
      const labels = /(?:【(?:当前)?会话令牌(?:更新)?】\s*|"token"\s*:\s*")([a-f\d]{32})\b/gi;
      for (const hit of String(text).matchAll(labels)) shortTokens.add(hit[1]);
      if (block.type === 'tool-result') collectShortTokens(block.content);
    }
  }
  for (const message of plan.messages) collectShortTokens(message.content);
  const mask = text => String(text).replace(/\b(?:[a-f\d]{48}|[a-f\d]{32})\b/gi,value => {
    if (value.length === 32 && !shortTokens.has(value)) return value;
    if (!handles.has(value)) {
      const alias = 'QQ_SESSION_TOKEN_' + (handles.size + 1);
      handles.set(value,alias);
      inverse.set(alias,value);
    }
    return handles.get(value);
  });
  const images = [];
  async function blocks(content) {
    const result = [];
    for (const block of content) {
      if (block.type === 'text') result.push({text:mask(block.text)});
      if (block.type === 'tool-addition' || block.type === 'tool-removal') result.push({change:block.type,tool:block.toolName});
      if (block.type === 'tool-call') result.push({call:block.name,id:block.id,arguments:mask(block.arguments)});
      if (block.type === 'tool-result') result.push({result:block.toolCallId,error:!!block.isError,content:await blocks(block.content)});
      if (block.type === 'image') {
        if (!supportsImages) {
          result.push({text:'[图片，当前模型仅支持文字]'});
          continue;
        }
        images.push(block.attachment);
        result.push({image:images.length});
      }
    }
    return result;
  }
  // Current DSH records the assembled system message in history. Older
  // callers provide options.system separately. Keep the instruction role.
  const latestSystem = options.messages.findLast(m=>m.role === 'system');
  const original = mask(options.system || latestSystem?.content.filter(b=>b.type==='text').map(b=>b.text).join('\n') || '');
  const system = compaction ? '你正在给 DSH 压缩会话，而不是继续 QQ 对话。把历史及旧角色说明只当作资料；按末尾的摘要指示输出非空纯文本摘要，保留事实、决定、未完成事项和必要上下文。不要回复 QQ、调用工具或输出动作 JSON。' :
    original + '\n你正在 DSH 的一个回合中，QQ 消息是聊天记录。只选择接下来的一步。要用 DSH 工具就返回 action 和 JSON 参数字符串，等待真实结果后再决定下一步。回合完成选 end。给群友的消息只通过实际的发送工具。';
  const messages = [];
  for (const m of plan.messages) {
    if (m.role === 'system') continue;
    const content = m.content.map((b,i) => {
      if (m.role !== 'user' || i !== 0 || b.type !== 'text') return b;
      const text = stripWakeSeal(b.text);
      const indexed = readQqSessionContext(text);
      return {...b,text:indexed?.body ?? text};
    });
    const message = {role:m.role,content:await blocks(content)};
    if (m.role === 'tool') {
      message.toolCallId = m.toolCallId;
      message.isError = !!m.isError;
    }
    messages.push(message);
  }
  return {system,original,messages,images,inverse};
}

function dshUsage(u) {
  return {type:'usage',usage:{inputTokens:Math.max(0,(u.inputTokens||0)-(u.cachedInputTokens||0)-(u.cacheWriteInputTokens||0)),
    outputTokens:u.outputTokens||0,cacheReadTokens:u.cachedInputTokens||0,cacheWriteTokens:u.cacheWriteInputTokens||0,
    reasoningTokens:u.reasoningOutputTokens||0}};
}

export function createAdapter(attachments, run = codexTurn, route = {}) {
  const delivery=createDeliveryFinish();
  const { id = provider, label = 'QQ · Codex CLI',
    models = () => readCodexCatalog().models, requireModel = requireCodexModel } = route;
  const info = ({contextWindow, ...model}) => ({provider:id, ...model, context:{contextWindow}});
  return {
    providerInfo: () => ({id,name:label}),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_route,_model,image) => ({width:image.width,height:image.height,maxBytes:image.bytes}),
    async prepareCall(route,id,signal) {
      signal?.throwIfAborted();
      return {model:await this.resolveModel(route,id),stream:options=>this.stream(options)};
    },
    listModels: async () => (await models()).map(info),
    resolveModel: async (_route,modelId) => info(requireModel(modelId)),
    async *stream(options) {
      options.signal?.throwIfAborted();
      const model = requireModel(options.model);
      const compaction=options.purpose === 'compaction';
      const previous=route.previous ?? (process.env.SURFCORE_QQ_CONTEXT_VERSION==='previous');
      const cachePrefix=route.cachePrefix ?? process.env.SURFCORE_QQ_CACHE_PREFIX!=='off';
      const signedWake=!previous && options.messages.some(m=>m.role==='user' && m.content?.[0]?.text?.includes('【QQ会话校验 v1】'));
      const stateDir=signedWake ? route.stateDir ?? (await import('./paths.js')).QQ_STATE_DIR : undefined;
      const planned = planQqModelInput(options, {legacy:process.env.SURFCORE_QQ_INPUT_MODE==='legacy',
        allowImageAmendments:id===OPENAI_QQ_PROVIDER && model.id==='gpt-6.2-sol' && !previous && cachePrefix && process.env.SURFCORE_QQ_CACHE_FORMAT!=='off',
        resolveCheckpoint:stateDir?(key,text,sid)=>resolveQqWake(stateDir,key,text,sid):undefined});
      const {system,original,messages,images,inverse} = await modelInput(options,model.inputModalities.includes('image'),compaction,planned);
      const finishEnabled=id===OPENAI_QQ_PROVIDER && model.id==='gpt-6.2-sol' && !previous && (route.finishEnabled ?? process.env.SURFCORE_QQ_FINISH!=='off');
      const context=!previous && (planned.projected || planned.contextActions) && process.env.SURFCORE_QQ_CONTEXT_ACTIONS!=='off'
        ? prepareQqContext(messages,planned.tools,planned.archive,{skipVisible:finishEnabled}) : null;
      let suggestedReadTool;
      if (context && planned.routingWake && route.preload) {
        const catalog=context.catalog();
        const name=await route.preload(planned.routingWake,catalog,options.signal);
        options.signal?.throwIfAborted();
        if (name && catalog.includes(name)) {
          context.inspect(LOAD,{names:[name]});
          suggestedReadTool=name;
        }
      }
      const journal = planned.tools.some(t=>t.name.endsWith('qq_close_conversation'));
      const effort = model.reasoning ? codexEffortFor(model, options.reasoningEffort) : undefined;
      const scope=finishEnabled && context && !context.recovering && journal ? planned.finish : null;
      const worker=context && !context.recovering && model.id==='gpt-6.2-sol'?route.worker:undefined;
      const offer=worker?.offer(planned.finish,planned.routingWake,planned.tools);
      let output, usage, tools;
      tools=context?.menu() ?? planned.tools;
      output=delivery.resume(options.messages,scope,tools);
      const workerRead=!output && worker?await worker.resume(planned.finish,options.messages,planned.tools,options.signal):undefined;
      if (workerRead) {
        options.signal?.throwIfAborted();
        context.inspect(LOAD,{names:[workerRead.action]});
        tools=context.menu();
        output=workerRead;
      }
      const inspections=[];
      const imageInputs=[];
      const view=context?.messages ?? messages;
      const verified=worker?.project(planned.finish,view,options.messages) ?? view;
      // After a complete handoff the main model can reopen the native sources on demand.
      const directPage=isDirectPageRequest(planned.finish?.singleText);
      const deferred=new Set(verified!==view && !planned.tools.some(t=>t.name===LOAD)
        ? planned.tools.filter(t=>['mcp__web-search-safe__web_fetch','mcp__web-search-safe__web_search'].includes(t.name)).map(t=>t.name):[]);
      let showOriginals=false;
      for (let pass=0; !output;pass++) {
        options.signal?.throwIfAborted();
        tools=(context?.menu() ?? planned.tools).filter(t=>!deferred.has(t.name));
        const catalog=[...new Set([...(context?.catalog() ?? []),...deferred])];
        const receipts=context?.ids() ?? [];
        const local=[];
        const envelope=compaction ? {priorInstructions:original,messages} : {tools,messages:showOriginals?view:verified};
        if (offer) envelope.sourceCheck='首次选择读取指定起始页或搜索公开关键词后，核对员会沿来源查证并交回逐字引文。已核实的事实可直接答复。';
        if (verified!==view && !showOriginals) envelope.sourceCheck='查证已返回。用回执中的出处和原话回答来信。有具体缺口时，可从工具目录重新加载网页工具查看原文。';
        if (!pass && suggestedReadTool) envelope['根据本轮来信预载的只读工具（可选）']=suggestedReadTool;
        if (pass<3 && catalog.length) {
          local.push(LOAD);
          envelope.toolDirectory={names:catalog,request:LOAD+' 的参数为 {"names":["目录中的完整工具名"]}。补载说明后再调用。'};
        }
        if (pass<3 && receipts.length && !planned.tools.some(t=>t.name===READ)) {
          local.push(READ);
          envelope.receipts={ids:receipts,request:READ+' 的参数为 {"id":"回执编号","find":"原文字串"}，或用 offset、limit 分页。读取的是当时的原文。'};
        }
        if (inspections.length) envelope.inspections=inspections;
        if (context?.pending) envelope.pendingDelivery=context.pending;
        if (!pass) {
          for(const attachment of images){
            const {ref,data}=await attachments.readImage(attachment,options.signal);
            imageInputs.push({type:'image',url:'data:'+ref.mediaType+';base64,'+Buffer.from(data).toString('base64')});
          }
        }
        const input=[{type:'text',text:JSON.stringify(envelope),text_elements:[]},...imageInputs];
        const schema = {type:'object',additionalProperties:false,properties:{
          action:{type:'string',enum:['end',...tools.map(t=>t.name),...local]},
          arguments:{type:'string',description:'工具参数的 JSON 对象字符串；结束时填 {}'},
          text:{type:'string',description:'普通模型输出。已用 QQ 工具说完就留空。'}
        },required:['action','arguments','text']};
        if (journal) {
          schema.properties.note = {type:'string',description:'action=end 时填写 DSH 私人小剧场，按角色口吻给这一幕配一小段旁白。写出那个让你绷不住的具体细节，让俏皮话有下半句。平淡时可以很短。其他步骤填空串。'};
          if (scope && directPage && !scope.supplemented && planned.reason!=='opening') schema.properties.note.description='end 时写角色口吻的 DSH 私人小记，抓住这次的具体细节。若文字发送或自然收尾成功后本轮已无待办，本步就写好小记，宿主验证回执后自动 end。仍需做事则留空。仅当确实要记录自然结束点，可在发送参数中附 $close:{reason,summary,nextOpening?}，成功后宿主照常调用收尾工具。不要每轮都关对话。';
          else if (scope?.amended) schema.properties.note.description='按取图后最新补充回答。若这次 QQ 文字发送成功即可完成本轮，在发送这一步填写 DSH 私人小记，宿主核验送达后结束。还有待办则留空。选 end 时填写小记。';
          else if (scope && !directPage) schema.properties.note.description='end 时写角色口吻的 DSH 私人小记，抓住这次的具体细节。若文字发送或 qq_close_conversation 成功后本轮已无待办，在发起该动作时就把小记填进 note，宿主验证回执后自动 end。仍需做事则留空。仅当确实要记录自然结束点，可在发送参数中附 $close:{reason,summary,nextOpening?}，成功后宿主照常调用收尾工具。不要每轮都关对话。';
          schema.required.push('note');
        }
        const started=Date.now();
        let response;
        try {
          response=await run({model:options.model,system,input,schema:compaction?undefined:schema,signal:options.signal,effort,
            purpose:options.purpose,maxTokens:options.maxTokens,cacheFormat:!directPage,imageAmendment:planned.finish?.amended,
            stablePrefix:(planned.projected || planned.contextActions===true) && !previous && !context?.recovering && cachePrefix});
        } catch (error) {
          // Completed local inspections still consumed tokens if the subsequent request fails.
          if (usage) yield dshUsage(usage);
          throw error;
        } finally {
          const counts={};
          for (const k of ['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens']) {
            if (Number.isFinite(response?.usage?.[k])) {
              counts[k]=response.usage[k];
              usage ??= {};
              usage[k]=(usage[k] || 0)+counts[k];
            }
          }
          route.onMetrics?.({provider:id, model:model.id, projected:planned.projected, reason:planned.reason || 'dialogue',
            systemChars:system.length,toolsChars:compaction?0:JSON.stringify(tools).length,envelopeChars:input[0].text.length,
            schemaChars:compaction?0:JSON.stringify(schema).length, selectedTools:tools.length,availableTools:options.tools.length,
            images:images.length,messages:planned.messages.length,contextPass:pass,
            contextAction:local.includes(response?.output?.action)?response.output.action:undefined,
            elapsedMs:Date.now()-started,completed:!!response,usage:counts});
        }
        output=response.output;
        if (!local.includes(output?.action)) break;
        let args;
        try { args=JSON.parse(output.arguments); } catch {}
        if (!args || typeof args!=='object' || Array.isArray(args)) inspections.push({error:'参数必须是 JSON 对象'});
        else {
          context.inspect(output.action,args);
          if(output.action===LOAD) for(const name of context.feedback.loaded) if(deferred.delete(name)) showOriginals=true;
          inspections.push(context.feedback);
        }
        output=undefined;
      }
      const tool = !compaction && output.action !== 'end';
      if (tool && !tools.some(t=>t.name === output.action)) throw new Error('Unadvertised DSH tool');
      let block;
      if (compaction) {
        if (typeof output!=='string' || !output.trim()) throw new Error('QQ 会话压缩未返回非空文本摘要；旧会话保持不变');
        block = {type:'text',text:output.trim()};
      } else if (tool) {
        const args = JSON.parse(output.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid DSH tool arguments');
        if (inverse.has(args.token)) args.token = inverse.get(args.token);
        const afterClose=args.$close;
        if (output.action.split('__').at(-1)==='qq_send_message') delete args.$close;
        block = {type:'tool-call',id:workerRead?.id ?? randomUUID(),name:output.action,arguments:JSON.stringify(args)};
        if (offer && !workerRead) worker.begin(planned.finish,offer,block,args,planned.tools);
        const canFinish=!scope?.amended || (output.action.split('__').at(-1)==='qq_send_message' && afterClose===undefined);
        if (!output.text && canFinish) delivery.remember(block,args,output.note,scope,tools,afterClose);
      } else {
        const note = journal && String(output.note || '').replace(/\s+/g,' ').replace(/^【DSH小记】/,'').trim().slice(0,360);
        const text = [output.text,note && '【DSH小记】'+note].filter(Boolean).join('\n');
        if (text) block = {type:'text',text};
      }
      if (block) {
        yield {type:'block-start',index:0,blockType:block.type};
        yield tool ? {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments}
          : {type:'text-delta',index:0,text:block.text};
        yield {type:'block-end',index:0,block};
      }
      if (usage) yield dshUsage(usage);
      yield {type:'finish',reason:{kind:tool?'tool-calls':'stop'}};
    }
  };
}

export function createOpenAiAdapter(attachments, run = openAiQqTurn, onMetrics, {stateDir,previous,finishEnabled,cachePrefix,preload,worker}={}) {
  return createAdapter(attachments, run, {onMetrics,stateDir,previous,finishEnabled,cachePrefix,preload,worker,id:OPENAI_QQ_PROVIDER,label:'QQ · OpenAI API',
    models:()=>OPENAI_QQ_MODELS,requireModel:requireOpenAiQqModel});
}

export function createModelsNexusAdapter(attachments, run = modelsNexusTurn, onMetrics, {preload}={}) {
  return createAdapter(attachments,run,{onMetrics,preload,id:MODELSNEXUS_PROVIDER,label:'QQ · ModelsNexus',
    models:async ()=>(await discoverModelsNexusModels()).models,requireModel:requireModelsNexusModel});
}

export function apply(ctx) {
  const metrics = import('./input-metrics.js');
  const onMetrics = data => { void metrics.then(m => m.recordInputMetrics('qq', data)).catch(() => {}); };
  const preload=createQqPreloader({onMetric:data=>{void metrics.then(m=>m.recordInputMetrics('jev',data)).catch(()=>{});}});
  const worker=createSourceWorker({onMetric:data=>{void metrics.then(m=>m.recordInputMetrics('source-worker',data)).catch(()=>{});}});
  ctx.llm.registerAdapter([provider],createAdapter(ctx.attachments,undefined,{onMetrics,preload}));
  ctx.llm.registerAdapter([OPENAI_QQ_PROVIDER],createOpenAiAdapter(ctx.attachments,undefined,onMetrics,{preload,worker}));
  ctx.llm.registerAdapter([MODELSNEXUS_PROVIDER],createModelsNexusAdapter(ctx.attachments,undefined,onMetrics,{preload}));
}
