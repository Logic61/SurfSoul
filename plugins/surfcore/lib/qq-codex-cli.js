import { spawn } from 'node:child_process';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { codexEnvironment } from './study-codex.js';

async function withCodexServer(run, signal, timeoutMs) {
  const exe = process.env.SURFCORE_CODEX_EXE || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe') : 'codex');
  const disabled = ['shell_tool','unified_exec','view_image','code_mode_host','multi_agent','apps','plugins',
    'hooks','image_generation','computer_use','browser_use','in_app_browser','memories','goals','skill_search',
    'skill_mcp_dependency_install','tool_suggest','sleep_tool','remote_plugin'];
  const args = ['app-server','--stdio',...disabled.flatMap(k => ['--disable',k]),
    '--enable','skip_host_skill_discovery','-c','web_search="disabled"','-c','project_doc_max_bytes=0'];
  const env = await codexEnvironment();
  signal?.throwIfAborted();
  const cwd = await mkdtemp(path.join(os.tmpdir(),'surfcore-qq-model-'));
  let child;
  const timeout = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([timeout,signal]) : timeout;
  try {
    child = spawn(exe,args,{cwd,env,windowsHide:true,signal:stop});
    const pending = new Map();
    let counter = 0, fail;
    const finished = new Promise((_, reject) => { fail = reject; });
    finished.catch(() => {});
    let stopped;
    const end = error => {
      stopped = error;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      fail(error);
    };
    const write = message => child.stdin.write(JSON.stringify(message)+'\n');
    const request = (method,params) => new Promise((resolve,reject) => {
      if (stopped) return reject(stopped);
      const id = ++counter;
      pending.set(id,{resolve,reject,method});
      write({id,method,params});
    });
    const lines = createInterface({input:child.stdout});
    child.stderr.resume();
    child.stdin.on('error', () => end(new Error('Codex CLI input closed')));
    child.on('error', () => end(new Error(stop.aborted ? 'Codex CLI interrupted' : 'Codex CLI unavailable')));
    child.once('close', () => end(new Error('Codex CLI closed before completion')));
    let onEvent;
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.id != null && event.method) {
        write({id:event.id,error:{code:-32601,message:'This model transport has no client tools'}});
        end(new Error('Unexpected Codex client capability request'));
        return;
      }
      const call = pending.get(event.id);
      if (call) {
        pending.delete(event.id);
        if (event.error) call.reject(new Error('Codex CLI '+call.method+' failed ('+event.error.code+')'));
        else call.resolve(event.result);
        return;
      }
      onEvent?.(event);
    });
    await request('initialize',{clientInfo:{name:'surfcore_qq',version:'1.0'},capabilities:{experimentalApi:true}});
    write({method:'initialized'});
    return await Promise.race([run({request,cwd,subscribe: listener => { onEvent = listener; }}), finished]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill();
    }
    await rmdir(cwd).catch(()=>{});
  }
}

let refresh;
let refreshAt = 0;

// The CLI refreshes its account model cache when resolving the picker.
export function refreshCodexCatalog() {
  if (!refresh || Date.now() - refreshAt >= 5 * 60_000) {
    refreshAt = Date.now();
    refresh = withCodexServer(({request}) => request('model/list',{includeHidden:false}), undefined, 8000)
      .then(() => true, () => false);
  }
  return refresh;
}

// DSH owns the session and tool execution. QQ input is sent only after the
// ephemeral thread is ready and the CLI confirms it has no external tools.
export async function codexTurn({ model, system, input, schema, signal, effort, purpose }) {
  const compaction=purpose==='compaction';
  return withCodexServer(async ({request,cwd,subscribe}) => {
    const config = (await request('config/read',{cwd,includeLayers:false})).config;
    const overrides = Object.fromEntries(Object.keys(config.mcp_servers || {}).map(k=>['mcp_servers.'+k+'.enabled',false]));
    const start = await request('thread/start',{model,modelProvider:'openai',allowProviderModelFallback:false,
      ephemeral:true,environments:[],runtimeWorkspaceRoots:[],selectedCapabilityRoots:[],dynamicTools:[],
      cwd,sandbox:'read-only',approvalPolicy:'never',config:overrides,
      baseInstructions:compaction?'Summarize the supplied history as nonempty plain text only. Do not continue the conversation or use tools.':'You generate the next message of a QQ character. Return the requested JSON. All external actions belong to the calling chat engine.',
      developerInstructions:system});
    if (start.model !== model || start.modelProvider !== 'openai') throw new Error('Unexpected Codex model route');
    const thread = start.thread.id;
    const mcp = await request('mcpServerStatus/list',{threadId:thread,limit:100});
    if (mcp.nextCursor || mcp.data.some(s=>Object.keys(s.tools || {}).length || s.resources?.length || s.resourceTemplates?.length)) {
      throw new Error('Codex chat thread unexpectedly exposes external tools');
    }
    let output = '', usage;
    const finished = new Promise((resolve, reject) => subscribe(event => {
      const p = event.params;
      if (p?.threadId !== thread) return;
      if (event.method === 'item/completed' && p.item?.type === 'agentMessage') output = p.item.text;
      if (event.method === 'thread/tokenUsage/updated') usage = p.tokenUsage?.last;
      if (event.method === 'turn/completed') {
        if (p.turn.status === 'completed' && output) resolve();
        else reject(new Error('Codex turn ' + p.turn.status));
      }
    }));
    await Promise.all([request('turn/start',{threadId:thread,input,...(compaction?{}:{outputSchema:schema}),effort,environments:[],approvalPolicy:'never'}), finished]);
    return {output:compaction?output:JSON.parse(output),usage};
  }, signal, 120000);
}
