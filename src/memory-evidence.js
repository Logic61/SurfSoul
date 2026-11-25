import fs from 'node:fs';
import { loadNarrative, sceneOfRecord } from './memcard-narrative.js';
import { scanFullRecords } from './memory-card.js';

// Evidence is local to one character directory. Each reference must resolve independently.
export function readEpisodeEvidence(paths) {
  const card = JSON.parse(fs.readFileSync(paths.json, 'utf8'));
  const episodes = loadNarrative(paths.dir).episodes;
  const records = new Map(card.records.map(record => [record.id, record]));
  const missing = new Set(episodes.flatMap(ep => ep.covers).filter(id => !records.has(id)));
  if (missing.size) {
    scanFullRecords(paths, record => {
      if (missing.has(record.id)) records.set(record.id, record);
    }, { maxScanBytes: Infinity });
  }
  const rows = [];
  for (const ep of episodes) {
    if (!ep.covers.length) continue;
    const sources = ep.covers.map(id => records.get(id));
    const key = sceneOfRecord(sources[0]);
    if (!key || sources.some(record => sceneOfRecord(record) !== key)) continue;
    if (ep.sceneKey && ep.sceneKey !== key) continue;
    rows.push({ key, ep, sources, evidence: evidenceOf(key, ep.id, ep.date, ep.covers, 'episode') });
  }
  return rows;
}
export function evidenceOf(key, id, at, refs, kind) {
  return { key, id, at, refs, kind, visibility: 'same-conversation' };
}

// Classify only concrete activities supported by source text. No preference is inferred.
const activities = [
  ['聊电影', /看电影|聊电影|电影散场|散场后|片尾/],
  ['聊观星', /看星星|看星空|观星/],
  ['聊答辩', /答辩/],
  ['聊起话题怎么开始', /主动开启话题|先开口|谁来起话头|主动找话/],
];
export function consolidateActivities(rows) {
  const byScene = new Map();
  for (const row of rows) {
    if (!row.key.startsWith('private:')) continue;
    for (const [label, pattern] of activities) {
      const matching = row.sources.filter(r => pattern.test(r.text || '') && !r.isSelf);
      if (!matching.length) continue;
      const bucket = row.key + '/' + label;
      const list = byScene.get(bucket) || [];
      const identities = matching.map(r => r.sourceId || r.id);
      if (list.some(old => old.date === row.ep.date || old.identities.some(id => identities.includes(id)))) continue;
      // Copied accounts with different IDs are still a single piece of evidence.
      const texts = matching.map(r => String(r.text).replace(/\s+/g,''));
      if (list.some(old => old.texts.some(text => texts.includes(text)))) continue;
      list.push({ date:row.ep.date, identities, texts, ep:row.ep.id });
      byScene.set(bucket, list);
    }
  }
  return [...byScene].filter(([,list]) => list.length >= 2).map(([bucket,list]) => {
    const [key,label] = bucket.split('/');
    return { key, label, kind:'repeated_observation', evidence:list.map(r => r.ep) };
  });
}
