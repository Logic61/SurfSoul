// 生活参数 MCP 代理回归（真实 stdio + 本地 stub bridge；不连真实桥接/不联网/不读真实 ~/.dsh）。
// 断言：9 个工具都必填 key/token、无 approve 工具；GET/POST 路径与 query/body 符合 IMPL-SPEC §4；
// 转发三个鉴权头；成功透传 bridge JSON；业务错误/HTTP 错误统一 rejected 形状；额外参数被拒；
// token 绝不出现在 query/body；启动不依赖 bridge 在线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-life-mcp-'));
const root=path.join(temp,'root'),dshHome=path.join(temp,'home');
fs.mkdirSync(root,{recursive:true});
const CONSOLE_TOKEN='isolated-life-console-token_0123456789';
const SESSION_TOKEN='session-token-abc-123';
const TOOL_NAMES=['life_state','life_catalog','life_explain','life_preview','life_apply','life_verify','life_history','life_rollback','life_observe'];
const requests=[];
const json=(res,status,payload)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(payload));};
const bridge=http.createServer((req,res)=>{
  const chunks=[];req.on('data',(chunk)=>chunks.push(chunk));req.on('end',()=>{
    const raw=Buffer.concat(chunks).toString('utf8');
    const url=new URL(req.url,'http://127.0.0.1');
    let body=null;try{body=raw?JSON.parse(raw):null;}catch{body=raw;}
    const record={method:req.method,pathname:url.pathname,query:Object.fromEntries(url.searchParams),headers:req.headers,body};
    requests.push(record);
    if(url.pathname==='/api/life/rollback'&&body?.changeId==='change-deny')return json(res,200,{ok:false,error:'OWNER_REQUIRED: 仅主人本人触发的回合可以改生活参数'});
    if(url.pathname==='/api/life/observe'&&body?.changeId==='change-forbidden')return json(res,403,{ok:false,error:'FORBIDDEN: token 不属于该会话'});
    return json(res,200,{ok:true,route:url.pathname.slice('/api/life/'.length)});
  });
});
await new Promise((resolve)=>bridge.listen(0,'127.0.0.1',resolve));
const bridgePort=bridge.address().port;
fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({consolePort:bridgePort,consoleToken:CONSOLE_TOKEN},null,2));

// 一个确定关闭的端口：用来证明 MCP 启动不依赖 bridge 在线。
const closedServer=http.createServer();
await new Promise((resolve)=>closedServer.listen(0,'127.0.0.1',resolve));
const closedPort=closedServer.address().port;
await new Promise((resolve)=>closedServer.close(resolve));

const connect=(fixtureRoot)=>{
  const client=new Client({name:'isolated-scripted-agent',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'src','mcp-life-settings.js')],
    env:{...process.env,SURFCORE_ROOT:fixtureRoot,DSH_HOME:dshHome},stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',(chunk)=>{stderr+=chunk;});
  return {client,transport,getStderr:()=>stderr};
};
const unpack=(result)=>JSON.parse(result.content[0].text);
const expectRejected=async(promise,pattern)=>{
  let result=null;
  try{result=await promise;}catch(error){assert.ok(error,'应当被拒绝');return;}
  assert.equal(result.isError,true);
  const text=String(result.content?.[0]?.text??'');
  let parsed=null;try{parsed=JSON.parse(text);}catch{parsed=null;}
  if(pattern)assert.match(parsed?parsed.error:text,pattern);
};
const envRoot2=path.join(temp,'root-offline');
fs.mkdirSync(envRoot2,{recursive:true});
fs.writeFileSync(path.join(envRoot2,'config.json'),JSON.stringify({consolePort:closedPort,consoleToken:CONSOLE_TOKEN},null,2));

let passed=0;
const test=async(name,run)=>{await run();passed++;console.log('PASS '+name);};
try {
  const live=connect(root);
  await live.client.connect(live.transport);
  try {
    await test('discovers exactly 9 life tools, each requires key+token, no approve tool',async()=>{
      const listed=await live.client.listTools();
      assert.equal(listed.tools.length,9);
      assert.deepEqual(listed.tools.map((tool)=>tool.name).sort(),[...TOOL_NAMES].sort());
      assert.ok(!listed.tools.some((tool)=>tool.name.includes('approve')));
      for(const tool of listed.tools){
        const props=Object.keys(tool.inputSchema?.properties??{});
        assert.ok(props.includes('key'),tool.name+' 必须要求 key');
        assert.ok(props.includes('token'),tool.name+' 必须要求 token');
        assert.ok(Array.isArray(tool.inputSchema.required)&&tool.inputSchema.required.includes('key')&&tool.inputSchema.required.includes('token'),tool.name+' 的 key/token 必须必填');
        assert.equal(tool.inputSchema.additionalProperties,false,tool.name+' 必须拒绝额外参数');
      }
      for(const name of ['life_preview','life_apply','life_rollback','life_observe']){
        const tool=listed.tools.find((entry)=>entry.name===name);
        assert.match(tool.description,/主人本人/,name+' 描述必须写明写操作需主人本人身份');
      }
      for(const tool of listed.tools)assert.match(tool.description,/QQ 会话/,tool.name+' 描述必须写明仅 QQ 会话可用');
    });
    const call=(name,args)=>live.client.callTool({name,arguments:args});
    await test('life_state GET /api/life/state carries key in query and three auth headers',async()=>{
      const result=unpack(await call('life_state',{key:'group:123',token:SESSION_TOKEN}));
      assert.equal(result.ok,true);assert.equal(result.route,'state');
      const request=requests.at(-1);
      assert.equal(request.method,'GET');
      assert.equal(request.pathname,'/api/life/state');
      assert.equal(request.query.key,'group:123');
      assert.equal(request.headers['x-console-token'],CONSOLE_TOKEN);
      assert.equal(request.headers['x-agent-call'],'1');
      assert.equal(request.headers['x-agent-token'],SESSION_TOKEN);
      assert.equal(request.body,null);
    });
    await test('catalog / explain / verify / history use GET query params',async()=>{
      unpack(await call('life_catalog',{key:'private:456',token:SESSION_TOKEN,query:'群聊'}));
      assert.deepEqual({path:requests.at(-1).pathname,query:requests.at(-1).query},{path:'/api/life/catalog',query:{key:'private:456',q:'群聊'}});
      unpack(await call('life_explain',{key:'private:456',token:SESSION_TOKEN,id:'purpose.enabled'}));
      assert.deepEqual({path:requests.at(-1).pathname,query:requests.at(-1).query},{path:'/api/life/explain',query:{key:'private:456',id:'purpose.enabled'}});
      unpack(await call('life_verify',{key:'private:456',token:SESSION_TOKEN,changeId:'change-1'}));
      assert.deepEqual({path:requests.at(-1).pathname,query:requests.at(-1).query},{path:'/api/life/verify',query:{key:'private:456',changeId:'change-1'}});
      unpack(await call('life_history',{key:'private:456',token:SESSION_TOKEN,offset:0,limit:5}));
      assert.deepEqual({path:requests.at(-1).pathname,query:requests.at(-1).query},{path:'/api/life/history',query:{key:'private:456',offset:'0',limit:'5'}});
    });
    await test('preview / apply / rollback / observe POST JSON bodies match contract',async()=>{
      unpack(await call('life_preview',{key:'group:123',token:SESSION_TOKEN,patch:{'purpose.enabled':false},reason:'隔离脚本预览',experience:'测试'}));
      assert.deepEqual({method:requests.at(-1).method,path:requests.at(-1).pathname,body:requests.at(-1).body},{
        method:'POST',path:'/api/life/preview',body:{key:'group:123',patch:{'purpose.enabled':false},reason:'隔离脚本预览',experience:'测试'},
      });
      assert.match(String(requests.at(-1).headers['content-type']),/application\/json/);
      unpack(await call('life_apply',{key:'group:123',token:SESSION_TOKEN,planId:'plan-1'}));
      assert.deepEqual({path:requests.at(-1).pathname,body:requests.at(-1).body},{path:'/api/life/apply',body:{key:'group:123',planId:'plan-1'}});
      unpack(await call('life_rollback',{key:'group:123',token:SESSION_TOKEN,changeId:'change-1',reason:'恢复'}));
      assert.deepEqual({path:requests.at(-1).pathname,body:requests.at(-1).body},{path:'/api/life/rollback',body:{key:'group:123',changeId:'change-1',reason:'恢复'}});
      unpack(await call('life_observe',{key:'group:123',token:SESSION_TOKEN,changeId:'change-1',text:'观察',decision:'keep'}));
      assert.deepEqual({path:requests.at(-1).pathname,body:requests.at(-1).body},{path:'/api/life/observe',body:{key:'group:123',changeId:'change-1',text:'观察',decision:'keep'}});
    });
    await test('bridge business errors and HTTP errors become rejected results',async()=>{
      await expectRejected(call('life_rollback',{key:'group:123',token:SESSION_TOKEN,changeId:'change-deny',reason:'恢复'}),/OWNER_REQUIRED/);
      await expectRejected(call('life_observe',{key:'group:123',token:SESSION_TOKEN,changeId:'change-forbidden',text:'观察'}),/FORBIDDEN/);
    });
    await test('extra parameters and missing key/token are rejected',async()=>{
      await expectRejected(call('life_apply',{key:'group:123',token:SESSION_TOKEN,planId:'plan-1',operator:true}),/./);
      await expectRejected(call('life_state',{}),/./);
      await expectRejected(call('life_apply',{key:'group:123',planId:'plan-1'}),/./);
    });
    await test('session token never leaks into query or body',async()=>{
      for(const request of requests){
        assert.ok(!JSON.stringify(request.query).includes(SESSION_TOKEN),'token 不能出现在 query');
        assert.ok(!JSON.stringify(request.body??null).includes(SESSION_TOKEN),'token 不能出现在 body');
      }
      assert.equal(live.getStderr(),'');
    });
  } finally {
    await live.client.close();await live.transport.close();
  }

  await test('MCP server starts and lists tools while the bridge is offline',async()=>{
    const offline=connect(envRoot2);
    await offline.client.connect(offline.transport);
    try {
      const listed=await offline.client.listTools();
      assert.equal(listed.tools.length,9);
      const result=await offline.client.callTool({name:'life_state',arguments:{key:'private:1',token:SESSION_TOKEN}});
      assert.equal(result.isError,true);
      assert.match(unpack(result).error,/BRIDGE_|桥接/);
    } finally {
      await offline.client.close();await offline.transport.close();
    }
  });
  console.log(passed+'/'+passed+' MCP proxy scenarios passed (real stdio, stub bridge only)');
}finally{
  await new Promise((resolve)=>bridge.close(resolve));
  fs.rmSync(temp,{recursive:true,force:true});
}
