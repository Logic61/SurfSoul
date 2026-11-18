import { evidenceOf } from './memory-evidence.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const legacyName = /叫他[「“]([^」”]+)[」”](?:或者|或)[「“]([^」”]+)[」”]/;
const nameRequest = /^(?:以后|今后|从现在起|下次开始|往后)(?:你)?(?:就|都|可以)?(?:叫我|称呼我|喊我)[「“]?([\p{Script=Han}a-zA-Z0-9·]{1,12}?)[」”]?(?:就好|就行|吧)?[。！!]?$/u;
const styleRequest = /^(?:以后|今后|往后)(?:跟我聊天时|回我时|跟我说话时)?(?:请|就)?(说话短一点|说话简短一点|回复简短一点|详细一点|说详细一点|一条消息一个意思|少用表情包|多用表情包|不要用表情包)[。！!]?$/;
// Scope a relationship preference to the activity the speaker actually named.
const activityPreference = /^(?:以后|今后)?(?:我希望|我喜欢|我不喜欢|我不想|我不再希望|我不再喜欢)你(看完电影|电影散场后|看完这部电影|观星后|聊完答辩后)(?:主动)?(?:来)?(?:找我|跟我|和我)(?:聊聊|聊|说说)(?:电影|观后感|片尾|感想|这件事)?[。！!]?$/;
const historyQuestion = /(?:以前|之前|原先|原来|上次|过去).{0,18}(?:叫我|喊我|称呼|怎么叫|怎么回|说话|回复)|(?:称呼|叫法).{0,12}(?:改过|变过)/;
const openTopic = /^(?:下次|回头|稍后|待会儿?|明天)(?:我们)?(?:再|接着|继续)(?:聊聊|聊|讨论|说说|说)(.{2,70}?)[。！!]?$/;
const closeTopic = /^(?:这(?:个话题|件事)|刚才的事)(?:已经|就)?(?:聊完了|结束了|解决了|先放下|不用再聊了)[。！!]?$/;
const changeTopic = /^(?:换个话题|说点别的)(?:[，,。].*)?$/;

export function createConversationMemory(dir) {
  const file = path.join(dir, 'conversation-memory-v1.json');
  let groupNotes;
  function notesFor(key) {
    if (!/^group:\d+$/.test(key)) return {};
    if (!groupNotes) {
      try { groupNotes = JSON.parse(fs.readFileSync(path.join(dir, 'qq-group-notes.json'), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') console.warn('[记忆] 群内称呼与用词暂不可读');
        groupNotes = {};
      }
    }
    return groupNotes?.[key] || {};
  }
  function groupTerms(key, text, lookup = false) {
    const line = String(text || '').trim().replace(/[。！？!?～~]+$/u,'');
    if (!line) return [];
    return (notesFor(key).terms || []).filter(({term,forms = []}) => {
      if (line === term) return true;
      if (lookup) return term.includes(line) || forms.some(form => form.includes(line) || line.includes(form));
      return forms.some(form => line.split(form).slice(1).some(tail => !tail || /^[了啊呀吧呢嘛哦哈笑，。！？、～~!?\s]/u.test(tail)));
    }).slice(0,3).map(({term,meaning}) => ({term,meaning}));
  }
  function member(key,id) {
    if (!/^group:\d+$/.test(key) || !/^\d+$/.test(String(id))) return undefined;
    const known = notesFor(key).members?.[id];
    let self;
    try { self = read().events.findLast(e => e.key === key && e.type === 'memberAddress' && e.speaker === String(id)); }
    catch { return known; }
    return self ? {...known, names:[self.value]} : known;
  }
  let cached;
  function read() {
    if (cached) return cached;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.events)) throw Error('invalid conversation memory');
      cached = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      cached = { version: 1, events: [] };
    }
    return cached;
  }
  function observe(key, msg, owner, raw) {
    if (!msg.messageId || !msg.userId || msg.hasForward || msg.hasMedia || !/^(private|group):\d+$/.test(key)) return;
    const text = String(raw).trim();
    if (text.length > 100) return;
    const ownPrivate = msg.isOwner && msg.userId === String(owner) && key === 'private:' + owner;
    const groupSelf = /^group:\d+$/.test(key) && !msg.isSelf && !msg.history && !msg.mentionedIds?.length;
    const name = (ownPrivate || groupSelf) && nameRequest.exec(text);
    const style = ownPrivate && styleRequest.exec(text);
    const activity = ownPrivate && activityPreference.exec(text);
    const topic = openTopic.exec(text);
    let type, value;
    if (name && !/还是|或者|的话|可以吗|行不行|怎么样|行吗|好吗|是不是/.test(name[1]) && !name[1].endsWith('吗')) { type = groupSelf ? 'memberAddress' : 'address'; value = name[1]; }
    else if (style) { type = style[1].includes('表情包') ? 'stickers' : style[1].includes('一条') ? 'messageStyle' : 'length'; value = style[1]; }
    else if (activity) {
      type = 'activity:' + (/电影/.test(activity[1]) ? '电影' : activity[1]);
      value = text;
    }
    else if (topic) { type = 'topic'; value = topic[1]; }
    else if (closeTopic.test(text) || changeTopic.test(text)) { type = 'topic'; value = ''; }
    else return;
    const state = read();
    if (state.events.some(e => e.key === key && e.messageId === msg.messageId)) return;
    if (!value && !state.events.some(e => e.key === key && e.type === 'topic')) return;
    const event = { key, type, value, text, at: msg.time, speaker: msg.userId, messageId: msg.messageId };
    const next = { ...state, events: [...state.events, event] };
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(next), { flag:'wx' });
      fs.renameSync(tmp,file);
      cached = next;
    } finally { fs.rmSync(tmp,{force:true}); }
  }
  function view(key, owner, query = '', notes = [], now = Date.now()) {
    const events = read().events.filter(e => e.key === key);
    const privateOwner = key === 'private:' + owner;
    const preferences = privateOwner ? events.filter(e => e.type !== 'topic' && e.speaker === String(owner)) : [];
    const current = new Map(preferences.map(e => [e.type,e.value]));
    const old = privateOwner && notes.map(line => legacyName.exec(line)).filter(Boolean).at(-1);
    const address = current.get('address') || (old ? old[1] : '');
    const lines = [];
    if (address) lines.push('当前称呼：' + (current.has('address') ? address : old[1] + '或' + old[2]));
    for (const [slot,value] of current) if (slot !== 'address' && (!slot.startsWith('activity:') || query.includes(slot.slice(9)) || /相处|偏好|主动/.test(query))) lines.push((slot.startsWith('activity:') ? '当前明确约定（仅此情境）：' : '当前表达偏好：') + value);
    if (privateOwner && historyQuestion.test(query)) {
      if (old) lines.push('早期语感笔记记载的称呼：' + old[1] + '或' + old[2]);
      for (const e of preferences.slice(-8)) lines.push(new Date(e.at).toLocaleDateString('zh-CN') + ' 主人原话 ' + JSON.stringify(e.text) + '（QQ 消息 ' + e.messageId + '）');
    }
    const topic = events.filter(e => e.type === 'topic').at(-1);
    if (topic?.value && now-topic.at < 7*86400000) lines.push('本会话明确留待续聊：' + JSON.stringify(topic.value));
    const effective = [...current.keys()].map(slot => preferences.filter(e => e.type === slot).at(-1));
    if (topic?.value && now-topic.at < 7*86400000) effective.push(topic);
    const evidence = effective.map(e => evidenceOf(key,e.messageId,e.at,[e.messageId],e.type === 'topic' ? 'working-topic' : 'explicit'));
    if (old && !current.has('address')) evidence.push(evidenceOf(key,'legacy-address',null,['style-notes.md'],'legacy-note'));
    return { address, lines, evidence, notes: address ? notes.filter(line => !legacyName.test(line)) : notes };
  }
  function shareTopics(key) {
    const profile = notesFor(key).shareTopics;
    return profile?.note && Array.isArray(profile.prefer) && profile.prefer.length
      ? profile : null;
  }
  return { observe, view, member, groupTerms, shareTopics };
}
