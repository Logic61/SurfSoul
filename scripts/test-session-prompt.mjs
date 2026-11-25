import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createRejectFallback, normalizePresendReviewConfig} from '../src/presend-review.js';
import {readQqSessionContext} from '../src/qq-session-context.js';
import {planQqModelInput} from '../plugins/surfcore/lib/qq-input-plan.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';

test('a delayed QQ wake identifies the real poke among earlier and later unread messages', async () => {
  const key = 'group:456';
  const h = await bridgeHarness({ config: { ownerQQ: 7, allow: { groups: ['456'] } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(key);
    st.bootstrapSent = true;
    st.wakeConfig = { ...st.wakeConfig, batchWindowMs: 1000, triggers: { ...st.wakeConfig.triggers, poke: true } };
    h.appendSocialV2Message(key, '群友甲', '依旧罪己诏', '依旧罪己诏', true, false, '11', [], '8');
    await h.handlePokeNotice({ sub_type: 'poke', group_id: 456, user_id: 7, target_id: 999, self_id: 999 });
    const poke = st.unread.at(-1);
    assert.equal(poke.kind, 'poke');
    h.appendSocialV2Message(key, '群友乙', '我下楼买个梨', '我下楼买个梨', false, false, '13', [], '9');
    h.scheduleWakeV2(key, 'probability', st.unread.at(-1).seq);
    for (let i = 0; i < 40 && !h.calls.prompts.length; i++) await delay(100);
    const prompt = h.calls.prompts.at(-1)?.content[0].text;
    assert.ok(prompt, 'scheduled wake should deliver a prompt');
    assert.match(prompt, new RegExp(`【本次唤醒】[^\\n]*（主人账号）戳了你（seq=${poke.seq}，`));
    assert.match(prompt, /依旧罪己诏/);
    assert.match(prompt, /我下楼买个梨/);
    await h.deliverPrompt(key, '', { wakeReason: 'recovery', silent: true });
    assert.doesNotMatch(h.calls.prompts.at(-1).content[0].text, /^【本次唤醒】/m);
  } finally { await h.close(); }
});

test('a slow draft waits for fresh chat only when a live unread arrival intervenes', async () => {
  const key = 'group:456';
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const h = await bridgeHarness({ config: { allow: { groups: ['456'] } }, globals: { Date: Clock } });
  let server;
  try {
    h.setMode('reserved2');
    const append = (id, text) => h.appendSocialV2Message(key, '群友', text, text, false, false, id, [], '8');
    append('1', '头一个话题');
    await h.deliverPrompt(key, '', { wakeReason: 'question', wakeSeq: h.getSocialV2State(key).lastUnreadSeq, silent: true });
    h.alignTurnTriggerStart(h.state.sessions[key], key);
    const st = h.getSocialV2State(key);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const headers = { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken };
    const send = text => fetch(origin + '/api/socialV2/send-message', {
      method: 'POST', headers, body: JSON.stringify({ key, messages: [text] }),
    });
    const sends = () => h.calls.http.filter(call => call.url.endsWith('/send_group_msg')).length;
    now += 21000;
    const stillCurrent = await send('没人打岔，旧草稿还接得上');
    assert.equal(stillCurrent.status, 200, await stillCurrent.text());
    now += 1000;
    append('2', '现在换话题了');
    const stale = await send('接着说头一个话题');
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /qq_get_unread_messages/);
    assert.equal(sends(), 1);
    assert.equal(st.sendTimes.length, 1, 'a withheld draft does not consume a message slot');
    const unread = await fetch(origin + '/api/socialV2/unread?key=group:456', { headers });
    assert.equal(unread.status, 200);
    assert.match(JSON.stringify(await unread.json()), /现在换话题了/);
    const refreshed = await send('现在说哪个？');
    assert.equal(refreshed.status, 200, await refreshed.text());
    assert.equal(sends(), 2);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

test('discard cancels an existing text fallback and never schedules a replacement', async () => {
  let fallback;
  let verdict = { allow: false, score: 60, threshold: 75, reason: '回错了人', error: '换一句', attempt: 1 };
  const h = await bridgeHarness({
    config: { socialV2: { review: { enabled: true } } },
    globals: {
      normalizePresendReviewConfig,
      createPresendReviewer: () => ({ review: async () => verdict }),
      createRejectFallback: options => (fallback = createRejectFallback(options)),
    },
  });
  let server;
  try {
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const send = text => fetch('http://127.0.0.1:' + server.address().port + '/api/socialV2/send-message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken },
      body: JSON.stringify({ key, messages: [text] }),
    });
    assert.equal((await send('第一次试着接')).status, 422);
    assert.equal(fallback.size(), 1);
    verdict = { ...verdict, action: 'discard', reason: '已经没人等了', error: '直接收尾' };
    const result = await send('打算再补一句');
    assert.equal(result.status, 422);
    assert.equal((await result.json()).review.action, 'discard');
    assert.equal(fallback.size(), 0);
    assert.equal(st.sendTimes.length, 0);
  } finally {
    fallback?.dispose();
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

test('master prompt is committed after acceptance, once per actual DSH session',async()=>{
 const key='private:7';
 const h=await bridgeHarness({config:{ownerQQ:7,allow:{private:['7']}}});
 const text=()=>h.calls.prompts.at(-1).content[0].text;
 const wake=reason=>h.deliverPrompt(key,'',{wakeReason:reason,silent:true});
 const master=/【本会话总提示】/;
 try{
  h.setMode('reserved2');
  const other=h.getSocialV2State('group:99');
  other.activeTopics=[{text:'他群话题不得出现在这里'}];
  other.memberImpressions={n:{traits:['跨场合印象不应出现']}};
  other.rules=[{scope:'global',text:'所有场合的约定'}];
  const submit=h.api.sessions.prompt;
  h.api.sessions.prompt=async()=>({result:{ok:false,error:{code:'TEST',message:'rejected'}}});
  assert.equal((await wake('question')).ok,false);
  assert.ok(!h.state.promptReceipts?.[key]);
  h.api.sessions.prompt=submit;
  h.appendSocialV2Message(key,'主人','新消息甲','新消息甲',false,true,'1',[],'7',[]);
  await wake('question');
  assert.match(text(),master);
  assert.match(text(),/所有场合的约定/);
  assert.doesNotMatch(text(),/他群话题不得出现在这里|跨场合印象不应出现/);
  assert.match(text(),/新消息甲/);
  const sid=h.state.sessions[key];
  const stored=JSON.parse(fs.readFileSync(path.join(h.temp,'state/sessions.json')));
  assert.equal(stored.promptReceipts[key].sessionId,sid);
  const resumed=await bridgeHarness({config:{ownerQQ:7,allow:{private:['7']}},savedState:stored,files:{
    'state/social-v2.json':fs.readFileSync(path.join(h.temp,'state/social-v2.json'),'utf8')
  }});
  try {
    resumed.setMode('reserved2');
    await resumed.deliverPrompt(key,'',{wakeReason:'recovery',silent:true});
    assert.equal(resumed.state.sessions[key],sid);
    assert.doesNotMatch(resumed.calls.prompts.at(-1).content[0].text,master);
  } finally {await resumed.close();}
  const submitCount=h.calls.prompts.length;
  await Promise.all([wake('bootstrap'),wake('bootstrap')]);
  for(const item of h.calls.prompts.slice(submitCount)) assert.doesNotMatch(item.content[0].text,master);
  assert.doesNotMatch(text(),/语感本|表情包策略/);
  await wake('replyCheck');
  assert.match(text(),/暂无新回复/);
  assert.doesNotMatch(text(),/新消息甲/);
  other.rules.push({scope:'global',text:'新增全局规矩'});
  await wake('question');
  assert.match(text(),/新增全局规矩/);
  await wake('question');
  assert.doesNotMatch(text(),/新增全局规矩/);
  h.retireSession(key);
  await wake('recovery');
  assert.notEqual(h.state.sessions[key],sid);
  assert.match(text(),master);
  assert.match(text(),/新消息甲/);
 }finally{await h.close();}
});

test('screen observation stays in the owner chat; the action menu is sent once', async () => {
  const owner = 'private:7';
  const group = 'group:99';
  let looks = 0;
  const h = await bridgeHarness({
    config: { ownerQQ: 7, allow: { private: ['7'], groups: ['99'] }, purpose: { screen: { enabled: true } } },
    files: { 'dsh/surfcore/persona.md':'# 角色卡：测试柚子\n只在需要时重读这句。', 'dsh/surfcore/pet/host.json': { baseUrl: 'http://127.0.0.1:5555', token: 'fixture-pet' } },
    globals: { fetch: async () => { looks++; return { ok: true, json: async () => ({ ok: true, at: 123, observation: '在看公式' }) }; } }
  });
  let server;
  try {
    h.setMode('reserved2');
    const wake = async key => {
      await h.deliverPrompt(key, '', { wakeReason: 'question', silent: true });
      return h.calls.prompts.at(-1).content[0].text;
    };
    assert.match(await wake(owner), /qq_look_at_screen/);
    assert.doesNotMatch(await wake(owner), /qq_look_at_screen/);
    assert.equal(h.isSendToolName('mcp__snowluma__qq_send_sticker'), true);
    assert.equal(h.isSendToolName('mcp__snowluma__qq_list_stickers'), false);
    const groupPrompt = await wake(group);
    assert.doesNotMatch(groupPrompt, /qq_look_at_screen/);
    assert.match(groupPrompt, /qq_set_my_group_card/);
    assert.match(groupPrompt, /豆包帮我.*正经求助.*一句就能玩/);
    assert.doesNotMatch(await wake(group), /豆包帮我/);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const look = (key, token) => fetch('http://127.0.0.1:' + server.address().port + '/api/socialV2/look-at-screen', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': token },
      body: JSON.stringify({ key })
    });
    const groupToken = h.getSocialV2State(group).agentToken;
    assert.equal((await look(group, groupToken)).status, 403);
    assert.equal((await look(owner, groupToken)).status, 403);
    const promptLookup = async (suffix) => {
      const response = await fetch('http://127.0.0.1:'+server.address().port+'/api/socialV2/prompt?key=group%3A99'+suffix,{
        headers:{'x-console-token':'fixture-console-token','x-agent-token':groupToken}
      });
      assert.equal(response.status,200); return response.json();
    };
    assert.equal((await promptLookup('')).role.hint,undefined);
    assert.match((await promptLookup('&includeRole=true')).role.hint,/只在需要时重读这句/);
    const callsBefore = looks;
    const res = await look(owner, h.getSocialV2State(owner).agentToken);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, at: 123, observation: '在看公式' });
    assert.equal(looks, callsBefore + 1);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

test('registry revision waits for idle, preserves unread, and sends exactly one master prompt to the replacement', async () => {
  const key = 'group:99', old = 'old-session';
  const h = await bridgeHarness({config:{ownerQQ:7, allow:{groups:['99']}}, savedState:{
    sessions:{[key]:old}, sessionPolicies:{[key]:JSON.stringify(['reserved2','qq-chat-v2',null])}
  }});
  try {
    h.setMode('reserved2');
    let inbox = {'next-turn':[{}]};
    h.api.callUnary = async method => ({result:{ok:true,value:method === 'agentPresets/read'
      ? {content:'fixture-preset'} : {values:{inbox}}}});
    h.appendSocialV2Message(key,'群友','等下还要说','等下还要说',false,false,'m-fixture',[],'123');
    await h.refreshPresetRevision();
    await h.reconcileSessionPolicies();
    assert.equal(h.state.sessions[key],old);
    h.recordSessionSnapshot(old, {records:[], projections:{values:{inbox:{'next-turn':[{}]}}}});
    await h.reconcileSessionPolicies();
    assert.equal(h.state.sessions[key],old);
    inbox = {'next-turn':'unavailable'};
    await h.reconcileSessionPolicies();
    assert.equal(h.state.sessions[key],old);
    inbox = {'next-turn':[]};
    h.v2TurnStartAt.set(old,Date.now());
    await h.reconcileSessionPolicies();
    assert.equal(h.state.sessions[key],old);
    h.v2TurnStartAt.delete(old);
    await h.reconcileSessionPolicies();
    assert.equal(h.state.sessions[key],undefined);
    assert.equal(h.getSocialV2State(key).unread[0].messageId,'m-fixture');
    await h.deliverPrompt(key,'',{wakeReason:'question',silent:true});
    assert.match(h.calls.prompts.at(-1).content[0].text,/【本会话总提示】[\s\S]*等下还要说/);
    const next = h.state.sessions[key];
    await h.reconcileSessionPolicies();
    assert.equal(h.state.sessions[key],next);
    await h.deliverPrompt(key,'',{wakeReason:'question',silent:true});
    assert.doesNotMatch(h.calls.prompts.at(-1).content[0].text,/【本会话总提示】/);
  } finally {await h.close();}
});

test('voice tie-breaker appears on fresh eligible batches and yields after a recent voice', async () => {
  const key = 'group:456';
  const h = await bridgeHarness({config:{socialV2:{voice:{enabled:true, trigger:{who:'anyone'}, tts:{enabled:true}}, tools:{sendVoice:true}}}});
  try {
    h.setMode('reserved2');
    const wake = async () => {
      await h.deliverPrompt(key, '', {wakeReason:'question', silent:true});
      return h.calls.prompts.at(-1).content[0].text;
    };
    await wake();
    for (let i = 1; i <= 6; i++) {
      h.appendSocialV2Message(key, '普通群友', '新消息'+i, '新消息'+i, false, false, String(i), [], '789', []);
      assert.equal((await wake()).includes('这回稍微偏向语音'), i === 6);
      assert.doesNotMatch(await wake(), /这回稍微偏向语音/);
    }
    h.state.promptReceipts[key].voiceTurns = 5;
    h.getSocialV2State(key).recentMessages.push({isSelf:true, kind:'voice', text:'[语音] 早', time:Date.now()});
    h.appendSocialV2Message(key, '普通群友', '接着聊', '接着聊', false, false, '8', [], '789', []);
    assert.doesNotMatch(await wake(), /这回稍微偏向语音/);
  } finally { await h.close(); }
});

test('real QQ wake builds indexed session settings and drops superseded or opening-only notes', async () => {
  const key = 'group:456';
  const h = await bridgeHarness({config:{dsh:{qqEngine:'openai-api'}, allow:{groups:['456']}}});
  try {
    h.setMode('reserved2');
    const history = [];
    async function wake(reason) {
      h.appendSocialV2Message(key,'群友','现在呢','现在呢',false,false,String(history.length+1),[],'8',[]);
      await h.deliverPrompt(key,'',{wakeReason:reason, silent:true});
      const prompt = h.calls.prompts.at(-1);
      history.push({role:'user',content:prompt.content});
      return prompt.content[0].text;
    }
    h.setInitialPrompt(key,'开场用的蓝色记号','opening');
    const first = await wake('anyMessage');
    assert(first.includes('开场用的蓝色记号'));
    assert.equal(readQqSessionContext(first)?.full, true);
    h.setInitialPrompt(key,'持续的绿色记号','session');
    const revision = await wake('atMention');
    assert.match(readQqSessionContext(revision).values.setting,/持续的绿色记号/);
    await wake('keyword:测试');
    const projected = planQqModelInput({messages:history,tools:[]});
    assert(projected.projected, projected.reason);
    const visible = projected.messages.map(m=>m.content[0].text).join('\n');
    assert(visible.includes('持续的绿色记号'));
    assert(!visible.includes('开场用的蓝色记号'));
    h.setInitialPrompt(key,'改成紫色','session');
    await wake('speaker:老李');
    const amended = planQqModelInput({messages:history,tools:[]}).messages.map(m=>m.content[0].text).join('\n');
    assert(amended.includes('改成紫色'));
    assert(!amended.includes('持续的绿色记号'));
    const {resolveQqWake}=await import('../src/qq-wake-checkpoint.js');
    const stateDir=path.join(h.temp,'state');
    const withoutOpening=planQqModelInput({messages:history.slice(-1),tools:[],sessionId:h.state.sessions[key]},
      {resolveCheckpoint:(...args)=>resolveQqWake(stateDir,...args)});
    assert.equal(withoutOpening.reason,'checkpoint');
    const resumed=withoutOpening.messages.map(m=>m.content[0].text).join('\n');
    assert.match(resumed,/改成紫色/);
    assert.doesNotMatch(resumed,/开场用的蓝色记号/);
  } finally { await h.close(); }
});
