// This is the event that scheduled the wake. Choosing an answer target and
// granting permissions are separate decisions.
export function formatWakeFocus(reason, anchor, now = Date.now(), includeText = false) {
  if (!anchor || anchor.isSelf || anchor.history || !Number.isSafeInteger(anchor.seq)) return '';
  if (reason === 'poke' && anchor.kind !== 'poke') return '';
  const sender = String(anchor.sender || '群友').replace(/\s+/g, ' ').slice(0, 24);
  const name = anchor.isOwner ? sender + '（主人账号）' : sender;
  const action = anchor.kind === 'poke' ? (anchor.poke?.targetIsSelf ? '戳了你' : '戳了别人')
    : anchor.quoteTargetIsSelf ? '引用了你的消息' : anchor.atSelf ? '@了你' : '发来消息';
  const age = Math.max(0, Math.floor((now - (anchor.time || now)) / 1000));
  const elapsed = age >= 60 ? `，${Math.floor(age / 60)} 分钟前` : `，${age} 秒前`;
  const text = includeText && anchor.kind !== 'poke' ? '「' + String(anchor.plain || anchor.text || '').replace(/\s+/g,' ').slice(0, 65) + '」' : '';
  return `${name}${action}${text}（seq=${anchor.seq}${elapsed}）`;
}

// Anchor the inference to the last delivered row. Cursor pages and compact
// snapshots may contain copies of rows; rows after that anchor are unseen.
export function readReactionScene(messages, recent, privateChat = false, nickname = '') {
  const last = messages?.at(-1);
  if (!last || last.isSelf || last.history) return {};
  const pos = recent.findIndex(m => m === last || (last.seq > 0 && m.seq === last.seq)
    || (last.messageId && m.messageId === last.messageId));
  const history = pos < 0 ? messages : recent.slice(0, pos + 1);
  const selfPoke = m => m.kind === 'poke' && m.poke?.targetIsSelf && !m.isSelf;
  const poked = selfPoke(last);
  const line = m => String(m?.plain || m?.text || '').trim();
  const repeated = poked && history.filter(m => selfPoke(m) && !m.history
    && m.time <= last.time && last.time - m.time <= 90 * 60000).length >= 3;
  const before = poked ? history.slice(0, -1).findLastIndex(m => m.kind !== 'poke') : history.length - 1;
  const focus = history[before];
  const previous = history.slice(0, Math.max(0, before)).findLast(m => m.kind !== 'poke');
  const previousIsMe = previous?.isSelf && (!focus?.time || !previous.time || focus.time - previous.time <= 30 * 60000);
  const mentioned = nickname && line(focus).toLowerCase().includes(nickname.toLowerCase());
  const directed = focus && (focus.quoteTargetIsSelf || focus.atSelf || privateChat || mentioned
    || (previousIsMe && !focus.mentionedIds?.length && !String(focus.text).includes('[引用')));
  // A teasing label on our last remark is a social move. Historical questions,
  // third-person stories and requests to actually correct an error stay literal.
  const tease = directed && !focus.isSelf && !focus.history && focus.kind !== 'poke'
    && (!poked || last.time - focus.time <= 30 * 60000)
    && /^(?:你这|你又|又是|又来|依旧|经典|好一[个篇]|每日|大型|现场|还是|开始|写上|写起|了|[\s，,])*(?:罪己诏|检讨大会|检讨书|自我批评大会|甩锅大会|认错大会)(?:了|呢|是吧|现场|啊|嘛|哈哈|[\s，,。！!])*$/.test(line(focus));
  const cue = repeated
    ? '这轮戳闹已经来回几次了。换个反应，别继续报数。可以只甩一张图、方便听时佯装发火说句语音，也可以晾着。'
    : '';
  const timing = poked && focus && !focus.isSelf && last.time - focus.time > 5 * 60000
    ? '前面的文字和刚才的戳隔了好一会儿。看还有没有人在等答复；散掉的闲话不用挨条补。' : '';
  return {
    cue: [cue, tease && '对方在学你刚才的口气逗你。顺势演一下，光给个表情就能接住。', timing].filter(Boolean).join(' '),
    stickerQuery: tease ? '无语 背锅 被甩锅 一脸无辜 顶锅' : repeated ? '生气 佯怒 气鼓鼓 炸毛 可恶' : '',
  };
}
