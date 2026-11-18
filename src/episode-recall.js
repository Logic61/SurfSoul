import fs from 'node:fs';
import { gramsOf } from './memory-search.js';
import { formatEpisodeLine, redactForOutbound } from './memcard-narrative.js';
import { readEpisodeEvidence, consolidateActivities } from './memory-evidence.js';


export function stripEpisodeSections(text) {
  let skip = false;
  return text.split(/\r?\n/).filter(line => {
    if (/^##\s/.test(line)) skip = /^## (我们一起经历过的|更早还记得的)\s*$/.test(line);
    return !skip;
  }).join('\n').trim();
}

const topics = [
  /活人感|主体性|主动一点|说完就跑|说完就走|只会听命令|(?:我|你).{0,5}(?:起话头|开个头|开启话题|先开口)/,
  /答辩|论文陈述|毕业汇报/,
];
function terms(text) {
  const content = text.replace(/今天|现在|之前|以前|当时|最近|什么|怎么样|怎么|还记得|记不记得|你说|我说|那次|那个|一下/g, ' ');
  const result = gramsOf(content);
  for (const term of result) if (term.length < 2) result.delete(term);
  topics.forEach((topic, i) => { if (topic.test(text)) result.add('topic-' + i); });
  return result;
}

// The summary locates an episode. Only the covered records supply details for explicit recall.
function evidenceExcerpts(sources) {
  return sources.flatMap(record => {
    const who = record.isSelf ? '甘棠' : record.speaker || '记录';
    const clean = value => redactForOutbound(String(value || '')).replace(/\s+/g, ' ').trim();
    return [[who, record.text], ['甘棠', record.botReply]].filter(([,value]) => clean(value)).map(([speaker,value]) => {
      const full = clean(value);
      const text = full.length > 180 ? full.slice(0,179) + '…' : full;
      return { speaker:clean(speaker).slice(0,20), text, tokens:terms(text) };
    });
  });
}

export function createEpisodeRecall(paths) {
  let stamp = '';
  let index = [];
  let observations = [];
  let sourcesByEpisode = new Map();
  function refresh() {
    const next = [paths.narrative, paths.json, paths.fullJsonl].map(file => {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      return stat ? stat.mtimeMs + '/' + stat.size : '-';
    }).join('|');
    if (next === stamp) return;
    const rows = readEpisodeEvidence(paths);
    index = rows.map(({ key, ep, sources, evidence }) => ({
      key, ep, evidence, tokens: terms(ep.title + ' ' + ep.text),
      sourceTokens: terms(sources.map(r => r.text || '').join(' '))
    }));
    sourcesByEpisode = new Map(rows.map(row => [row.ep, row.sources]));
    observations = consolidateActivities(rows);
    stamp = next;
  }
  function inspect(key, message, recent = []) {
    if (!key || !message) return {reason:'empty', hits:[], text:''};
    const relationship = /我们|咱俩|相处|跟我|陪我|每次|每回|总是|总要|又.{0,6}(?:跑|走)/.test(message);
    const explicit = /还记得|记不记得|那(?:天|回|晚|时候)|上(?:次|回)|以前|当时|头回|第一次|原话|谁.{0,8}(?:说过|提起)|之前.{1,20}(?:怎么|什么|哪)/.test(message);
    const empty = reason => ({reason, explicit, hits:[], text:''});
    const recurring = relationship && /一般|往往|平常|以前|总|每|习惯|又|为什么/.test(message);
    if (!explicit && !recurring) return empty('present-turn');
    try { refresh(); } catch { return empty('no-readable-evidence'); }
    const query = terms(message);
    if (!query.size) return empty('no-topic');
    const nearby = terms(recent.slice(-3).filter(item => item.text !== message).map(item => item.text).join(' '));
    const candidates = index.filter(row => row.key === key);
    const hits = [];
    const weights = new Map();
    for (const term of query) {
      const count = candidates.filter(row => row.tokens.has(term) || row.sourceTokens.has(term)).length;
      weights.set(term, Math.max(1, Math.log(1 + candidates.length / Math.max(1,count))));
    }
    for (const row of candidates) {
      const matched = [...query].filter(t => row.tokens.has(t) || row.sourceTokens.has(t));
      const strength = matched.reduce((sum,t) => sum + (t.startsWith('topic-') ? 2 : 1), 0);
      const score = matched.reduce((sum,t) => sum + weights.get(t) * (t.startsWith('topic-') ? 4 : 1), 0);
      if (strength < 2 && !(query.size === 1 && score >= 3)) continue;
      const context = [...nearby].filter(t => row.tokens.has(t));
      hits.push({ ep:row.ep, evidence:row.evidence, matched, sourceTerms:matched.filter(t => row.sourceTokens.has(t)), summaryTerms:matched.filter(t => row.tokens.has(t)), context, score:score + Math.min(context.length,5)*0.2 });
    }
    hits.sort((a,b) => b.score-a.score || b.ep.at-a.ep.at);
    const selected = hits.slice(0,2);
    if (!selected.length) return empty('no-match');
    const observation = recurring && observations.find(o => o.key === key && selected.length === 2 && selected.every(h => o.evidence.includes(h.ep.id)));
    if (explicit) {
      const lines = [];
      const seen = new Set();
      for (const hit of selected) {
        const scored = evidenceExcerpts(sourcesByEpisode.get(hit.ep) || []).map((item, index) => ({
          item, index, score:[...query].filter(t => item.tokens.has(t)).length
        }));
        const best = scored.sort((a,b) => b.score - a.score || a.index - b.index);
        let taken = 0;
        for (const { item } of best) {
          const line = JSON.stringify({记录者或说话人:item.speaker, 内容:item.text});
          if (seen.has(line)) continue;
          seen.add(line);
          lines.push(line);
          if (++taken === 2 || lines.length === 3) break;
        }
        if (lines.length === 3) break;
      }
      const text = lines.length
        ? '【回忆依据】下面是同场的记忆卡资料。对方问哪几件事，就从片段里答哪几件。答完就停；像“我在那儿等过”“你后来还……”这样的回忆尾句也得有记录。某一项没记下来，直说那一项忘了。要逐字原话用 qq_recall。\n' + lines.join('\n')
        : '';
      return { reason:text ? 'explicit-recall' : 'no-readable-evidence', explicit, hits:selected, text };
    }
    const usage = '用来理解眼前的话，通常无需向对方复述旧事。';
    const lines = selected.map(h => formatEpisodeLine(h.ep));
    if (observation) lines.push('【相处线索】不同日子都' + observation.label + '。这是重复观察，不能据此断定喜好。依据：' + selected.map(h => h.ep.id).join('、'));
    return { reason:'implicit-pattern', hits:selected, text:'【相关经历·摘要】' + usage + '\n' + lines.join('\n') };
  }
  const recall = (key, message, recent) => inspect(key, message, recent).text;
  recall.inspect = inspect;
  recall.maintain = () => { refresh(); return observations.length; };
  return recall;
}
