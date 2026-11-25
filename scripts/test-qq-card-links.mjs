import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { formatForwardResponse } from '../src/forward.js';
import { extractQqCardLinks, formatQqCqCards, qqMessageCardLinks } from '../src/qq-card-links.js';

const url = 'https://b23.tv/fixture?share=' + 'x'.repeat(240) + '&from=qq';
const title = '测试视频';
const card = { type:'json', data:{ data:JSON.stringify({
  app:'com.tencent.miniapp', meta:{ detail_1:{ title, url:'bilibili://video/123',
    qqdocurl:url, preview:'https://example.invalid/cover', token:'fixture-secret' }},
}) }};
const expected = [{url,title}];

test('OneBot card decoding retains only the navigation destination and title', () => {
  assert.deepEqual(extractQqCardLinks([card,card]), expected);
  const cq = '[CQ:json,data=' + card.data.data.replace(/&/g,'&amp;').replace(/,/g,'&#44;')
    .replace(/\[/g,'&#91;').replace(/\]/g,'&#93;') + ']';
  assert.deepEqual(qqMessageCardLinks({message:'[文本卡片]',raw_message:cq}), expected);
  assert.equal(formatQqCqCards(cq,true).trim(), `[链接卡片 ${title}] ${url}`);
  assert.deepEqual(extractQqCardLinks([{type:'share',data:{url,title}}]), expected);
  assert.deepEqual(extractQqCardLinks([{type:'xml',data:{data:`<msg url="${url.replace('&','&amp;')}" title="${title}"/>`}}]), expected);
  assert.deepEqual(extractQqCardLinks([
    {type:'json',data:{data:'broken'}},
    {type:'json',data:{data:{meta:{detail_1:{preview:url,url:'javascript:alert(1)'}}}}},
    {type:'share',data:{url:'https://user:pass@example.invalid'}},
    {type:'json',data:{data:{app:'com.tencent.multimsg',url}}},
  ]), []);
  const forward = formatForwardResponse({messages:[{message:[{type:'text',data:{text:'很长的前文'.repeat(120)}},card]},
    {type:'node',data:{content:cq}}]}, {maxCharsPerMessage:120});
  for (const message of forward.messages) assert.deepEqual(message.links,expected);
  assert.doesNotMatch(JSON.stringify(forward), /fixture-secret|example\.invalid/);
});

test('live cards reach the agent snapshot and tools, old cards resolve within their original conversation', async () => {
  const h = await bridgeHarness();
  const key = 'group:456';
  let server;
  try {
    h.setMode('reserved2');
    h.socialV2.paused = true;
    const event = {message_id:765, message_type:'group', group_id:456, user_id:800, self_id:123,
      sender:{nickname:'群友',user_id:800}, message:[{type:'text',data:{text:'前文'.repeat(150)}},card],
      time:Math.floor(Date.now()/1000)};
    await h.handleIncoming('group',456,event,h.cfg);
    const st = h.getSocialV2State(key);
    assert.equal(st.unread.length,1);
    assert.deepEqual(st.unread[0].links,expected);
    const snapshot = JSON.stringify(h.buildWakeSnapshotV2(key));
    assert.ok(snapshot.includes(url),'wake snapshot contains the full link');
    assert.doesNotMatch(snapshot,/fixture-secret|example\.invalid/);
    const history = await h.historyCandidateFromRaw(event);
    assert.deepEqual(history.links,expected);
    h.appendHistoryCatchupV2(key,[{...history,messageId:'766',time:Date.now()}]);
    assert.deepEqual(st.recentMessages.at(-1).links,expected);

    h.bot.getMessage = async id => ({...event,group_id:id===991 ? 789 : 456,message:[card]});
    h.appendSocialV2Message(key,'群友','[卡片消息]','[卡片消息]',false,false,990);
    h.appendSocialV2Message(key,'群友','[卡片消息]','[卡片消息]',false,false,991);
    h.socialV2.paused = false;
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve=>server.once('listening',resolve));
    const call = async (endpoint,params={}) => {
      const query = new URLSearchParams({key,...params});
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${endpoint}?${query}`,
        {headers:{'x-console-token':'fixture-console-token','x-agent-token':st.agentToken}});
      const data = await response.json();
      assert.equal(response.status,200,data.error);
      return data;
    };
    const rows = (await call('unread')).messages;
    assert.deepEqual(rows.find(row=>row.messageId==='765').links,expected);
    const seqFor = id => st.recentMessages.find(row=>row.messageId===id).seq;
    assert.deepEqual((await call('message-detail',{messageId:seqFor('990')})).info.links,expected);
    assert.equal((await call('message-detail',{messageId:seqFor('991')})).info.links,undefined);
    assert.equal(h.calls.sent.length,0);
  } finally {
    if (server) await new Promise(resolve=>server.close(resolve));
    await h.close();
  }
});
