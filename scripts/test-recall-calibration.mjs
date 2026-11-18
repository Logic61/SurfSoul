import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEpisodeRecall } from '../src/episode-recall.js';
import { resolveMemoryCardPaths } from '../src/memory-card.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(),'recall-calibration-'));
const paths = resolveMemoryCardPaths(dir);
const cases = [
 ['development','天气怎么样',''], ['development','今晚吃什么夜宵',''],
 ['development','上次山顶看星星天气怎么样','山顶看星星'], ['development','你怎么又说完就跑了','话题的开头'],
 ['heldout','要不要现在去山顶看星星',''], ['heldout','给我推荐一部电影',''],
 ['heldout','现在陪我买一把雨伞吧',''], ['heldout','今天还要交答辩材料',''],
 ['heldout','咱俩头回去山顶的时候看到什么','山顶看星星'],
 ['heldout','那天答辩材料里改的是哪一页','目录那一页'],
 ['heldout','是谁提起去买雨伞这件事的','他提起去买雨伞'],
 ['heldout','每回都得我先开个头','话题的开头'],
];
const entries = [
 ['山顶看星星','我们去山顶看星星，天气怎么样影响视野。'],
 ['电影散场','他让我推荐一部电影，散场后又聊了一会儿。'],
 ['准备答辩材料','交答辩材料之前我们改过目录那一页。'],
 ['路边买雨伞','回家路上下雨了，他提起去买雨伞。'],
 ['话题的开头','我们聊过活人感，他说想听我也主动开启话题。'],
 ['买夜宵','今晚吃什么夜宵，当时决定去吃馄饨。'],
];
try {
 const records=entries.map(([title,text],i)=>({id:'r'+i,title,text,conversationKey:'private:7'}));
 fs.writeFileSync(paths.json,JSON.stringify({records}));
 fs.writeFileSync(paths.narrative,JSON.stringify({episodes:entries.map(([title,text],i)=>({id:'e'+i,date:'2026-11-01',title,text,covers:['r'+i]}))}));
 const recall=createEpisodeRecall(paths);
 const result=[];
 for(const [split,q,wanted] of cases){
   const block=recall('private:7',q);
   const hit=wanted ? block.includes(wanted) : Boolean(block);
   result.push({split,q,wanted,hit});
 }
 for(const split of ['development','heldout']){
   const rows=result.filter(r=>r.split===split);
   console.log(split,JSON.stringify({falsePositives:rows.filter(r=>!r.wanted&&r.hit).length,ordinary:rows.filter(r=>!r.wanted).length,correctRecall:rows.filter(r=>r.wanted&&r.hit).length,recall:rows.filter(r=>r.wanted).length}));
 }
 if(!process.argv.includes('--baseline')){
   for(const r of result) assert.equal(r.hit,Boolean(r.wanted),r.q);
   for(const [,q] of cases) assert.equal(recall('group:8',q),'');
 }
}finally{fs.rmSync(dir,{recursive:true,force:true});}

import { consolidateActivities } from '../src/memory-evidence.js';
const rows = [0,1].map(i => ({
  key:'private:7', ep:{id:'ep'+i,date:'2026-11-0'+(i+1)},
  sources:[{id:'r'+i,sourceId:'same-message',text:'我们去看电影。'}],
}));
assert.deepEqual(consolidateActivities(rows),[]);
rows[1].sources[0].sourceId='different-message';
assert.deepEqual(consolidateActivities(rows),[]);
rows[1].sources[0].text='电影散场后我们聊过片尾。';
assert.equal(consolidateActivities(rows)[0].kind,'repeated_observation');
assert.deepEqual(consolidateActivities(rows.slice(1)),[]);

// A misleading narrative can locate an event, but cannot corroborate a detail.
const evidenceDir=fs.mkdtempSync(path.join(os.tmpdir(),'recall-source-'));
try {
 const p=resolveMemoryCardPaths(evidenceDir);
 const records=[{id:'a',text:'电影散场约在东出口。',speaker:'友',conversationKey:'private:7'},
   {id:'b',text:'电影散场约在南出口。',conversationKey:'group:8'},
   {id:'c',text:'东出口旁是绿邮筒，值班邮箱 test@example.com。',conversationKey:'private:7'}];
 const episodes=[{id:'e',title:'红亭',text:'电影散场后在红亭旁等。',covers:['a','c']},
   {id:'x',title:'南出口',text:'电影散场后在南出口等。',covers:['a','b']}];
 fs.writeFileSync(p.json,JSON.stringify({records}));
 fs.writeFileSync(p.narrative,JSON.stringify({episodes}));
 const recall=createEpisodeRecall(p);
 const q='上次电影散场在哪个出口等，旁边有什么？';
 const out=recall('private:7',q);
 assert.match(out,/东出口/);assert.match(out,/绿邮筒/);assert.match(out,/邮箱已隐藏/);
 assert.doesNotMatch(out,/红亭|南出口|example.com/);assert.equal(recall('group:8',q),'');
 episodes[0].covers=['a'];fs.writeFileSync(p.narrative,JSON.stringify({episodes}));
 assert.doesNotMatch(recall('private:7',q),/红亭|绿邮筒|南出口/);
} finally {fs.rmSync(evidenceDir,{recursive:true,force:true});}
