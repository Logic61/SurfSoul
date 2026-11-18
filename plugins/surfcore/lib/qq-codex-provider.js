import { randomUUID } from 'node:crypto';
import { codexTurn } from './qq-codex-cli.js';
import { CODEX_DEFAULT_EFFORT, CODEX_EFFORTS, validateCodexEffort } from './qq-codex-effort.js';

export const name = 'surfcore-qq-codex';
export const inject = ['llm','attachments'];
export const provider = 'surfcore-codex-cli';
export const models = ['gpt-6.1-sol','gpt-6-astra'];

// Only model-visible DSH blocks are translated. A QQ session bearer is a
// local bridge credential: the model can refer to it by handle, never by value.
async function modelInput(options, attachments) {
  const handles = new Map();
  const inverse = new Map();
  const mask = text => String(text).replace(/\b[a-f\d]{48}\b/gi,value => {
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
        const {ref,data} = await attachments.readImage(block.attachment, options.signal);
        images.push({type:'image',url:'data:'+ref.mediaType+';base64,'+Buffer.from(data).toString('base64')});
        result.push({image:images.length});
      }
    }
    return result;
  }
  // Current DSH records the assembled system message in history. Older
  // callers provide options.system separately. Keep the instruction role.
  const latestSystem = options.messages.findLast(m=>m.role === 'system');
  const system = mask(options.system || latestSystem?.content.filter(b=>b.type==='text').map(b=>b.text).join('\n') || '') + '\n你正在 DSH 的一个回合中，QQ 消息是聊天记录。只选择接下来的一步。要用 DSH 工具就返回 action 和 JSON 参数字符串，等待真实结果后再决定下一步。回合完成选 end。给群友的消息只通过实际的发送工具。';
  const messages = [];
  for (const m of options.messages) {
    if (m.role === 'system') continue;
    const message = {role:m.role,content:await blocks(m.content)};
    if (m.role === 'tool') {
      message.toolCallId = m.toolCallId;
      message.isError = !!m.isError;
    }
    messages.push(message);
  }
  const tools = options.tools || [];
  const input = [{type:'text',text:JSON.stringify({tools,messages}),text_elements:[]},...images];
  return {system,input,inverse};
}

export function createAdapter(attachments, run = codexTurn) {
  const info = id => ({provider,id,name:id,inputModalities:['text','image'],
    reasoning:{efforts:CODEX_EFFORTS,defaultEffort:CODEX_DEFAULT_EFFORT}});
  return {
    providerInfo: () => ({id:provider,name:'QQ · Codex CLI'}),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_route,_model,image) => ({width:image.width,height:image.height,maxBytes:image.bytes}),
    async prepareCall(route,id,signal) {
      signal?.throwIfAborted();
      return {model:await this.resolveModel(route,id),stream:options=>this.stream(options)};
    },
    listModels: async () => models.map(info),
    resolveModel: async (_route,id) => {
      if (!models.includes(id)) throw new Error('Unknown QQ Codex model');
      return {...info(id),context:{contextWindow:id === 'gpt-6-astra' ? 272000 : 500000}};
    },
    async *stream(options) {
      if (!models.includes(options.model)) throw new Error('Unsupported QQ Codex model');
      const {system,input,inverse} = await modelInput(options,attachments);
      const tools = options.tools || [];
      const journal = tools.some(t=>t.name.endsWith('qq_close_conversation'));
      const schema = {type:'object',additionalProperties:false,properties:{
        action:{type:'string',enum:['end',...tools.map(t=>t.name)]},
        arguments:{type:'string',description:'工具参数的 JSON 对象字符串；结束时填 {}'},
        text:{type:'string',description:'普通模型输出。已用 QQ 工具说完就留空。'}
      },required:['action','arguments','text']};
      if (journal) {
        schema.properties.note = {type:'string',description:'action=end 时填写 DSH 私人小剧场，按角色口吻给这一幕配一小段旁白。写出那个让你绷不住的具体细节，让俏皮话有下半句。平淡时可以很短。其他步骤填空串。'};
        schema.required.push('note');
      }
      const effort = validateCodexEffort(options.reasoningEffort ?? CODEX_DEFAULT_EFFORT);
      const {output,usage} = await run({model:options.model,system,input,schema,signal:options.signal,effort});
      const tool = output.action !== 'end';
      if (tool && !tools.some(t=>t.name === output.action)) throw new Error('Unadvertised DSH tool');
      let block;
      if (tool) {
        const args = JSON.parse(output.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid DSH tool arguments');
        if (inverse.has(args.token)) args.token = inverse.get(args.token);
        block = {type:'tool-call',id:randomUUID(),name:output.action,arguments:JSON.stringify(args)};
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
      if (usage) yield {type:'usage',usage:{
        inputTokens:Math.max(0,usage.inputTokens-(usage.cachedInputTokens||0)-(usage.cacheWriteInputTokens||0)),
        outputTokens:usage.outputTokens,cacheReadTokens:usage.cachedInputTokens||0,
        cacheWriteTokens:usage.cacheWriteInputTokens||0,reasoningTokens:usage.reasoningOutputTokens||0}};
      yield {type:'finish',reason:{kind:tool?'tool-calls':'stop'}};
    }
  };
}

export function apply(ctx) {
  ctx.llm.registerAdapter([provider],createAdapter(ctx.attachments));
}
