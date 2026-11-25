// Stored DSH messages remain readable. The index points into that same text so a
// stateless adapter can carry a setting forward without parsing display headings.
const notice = '【QQ上下文索引 v1】';
const fields = [
  ['agreement', '当前约定', 2000], ['setting', '会话设置', 2500],
  ['rules', '适用规矩', 2000], ['actions', 'QQ里的动作', 1400],
  ['persona', '角色卡', 6000], ['group', '群聊里的人', 1000],
  ['alignment', '群内身份对齐', 900], ['notebook', '语感与日记', 1100],
  ['terms', '黑话', 700], ['limits', '工具限额', 180], ['cross', '跨场合能力', 500],
];
const dialogueReasons = new Set(['private','atMention','mention','at','keyword','nameMention',
  'anyMessage','question','replyCheck','active','poke','probability','speaker']);

export function isQqDialogueWake(reason) {
  return dialogueReasons.has(String(reason || '').trim()) || /^(?:keyword|speaker):.+$/u.test(reason || '');
}

export function indexQqSessionContext(text, key, sections, changed) {
  const refs = {};
  for (const [id, label] of fields) {
    if (changed && !changed.has(label)) continue;
    const value = sections[label] || '';
    let start = text.indexOf(value);
    if (start < 0) {
      text += '\n【' + label + '】';
      start = text.length;
      text += value;
    }
    refs[id] = [start, value.length];
  }
  if (!Object.keys(refs).length) return text;
  const split = text.indexOf('\n');
  const line = notice + JSON.stringify({key, full: !changed, refs});
  return split < 0 ? text + '\n' + line : text.slice(0, split) + '\n' + line + text.slice(split);
}

export function readQqSessionContext(text) {
  const start = text.indexOf('\n');
  if (start < 0 || !text.startsWith(notice, start + 1)) return null;
  const end = text.indexOf('\n', start + 1);
  try {
    const {key, full, refs} = JSON.parse(text.slice(start + 1 + notice.length, end < 0 ? undefined : end));
    if (!/^(private|group):\d+$/.test(key) || typeof full !== 'boolean' || !refs) return null;
    const body = text.slice(0, start) + (end < 0 ? '' : text.slice(end));
    const values = {};
    for (const [id] of fields) {
      if (!Object.hasOwn(refs, id)) {
        if (full) return null;
        continue;
      }
      const [offset, length] = refs[id];
      if (![offset, length].every(n => Number.isSafeInteger(n) && n >= 0) || offset + length > body.length) return null;
      values[id] = body.slice(offset, offset + length);
    }
    return {key, full, values, body};
  } catch { return null; }
}

export function qqCheckpointValues(sections) {
  return Object.fromEntries(fields.map(([id,label,limit])=>[id,(sections[label] || '').slice(0,limit)]));
}

const fixedTags = new Set(['当前角色','你的身份','来源判断','场合','管理员·温柔模式','两段对话','你对自己的记录（你自己写下的，不是别人给你的设定）','反AI味','说话']);
export function fixedQqContext(text) {
  const marks=[...text.matchAll(/^【([^】\r\n]{1,64})】/gmu)];
  return marks.flatMap((m,i)=>fixedTags.has(m[1]) ? [text.slice(m.index,marks[i+1]?.index ?? text.length).trim().slice(0,1000)] : []).join('\n');
}

export function renderQqSessionContext(values) {
  return fields.flatMap(([id, label, limit]) => {
    const value = values[id];
    if (!value) return [];
    const text = value.length > limit ? value.slice(0, limit - 1) + '…' : value;
    return ['【' + label + '】' + text];
  }).join('\n');
}
