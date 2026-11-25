import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// Resolve state only when real catalogue I/O runs; do not initialise QQ paths on model adapter import.
async function catalogFile() {
  const {STATE_DIR}=await import('./paths.js');
  return path.join(STATE_DIR,'runtime','openai-qq-model-catalog.json');
}
const MAX_AGE=24*60*60*1000;
const validIds=ids=>Array.isArray(ids) && ids.length>0 && ids.length<=100 &&
  ids.every(id=>typeof id==='string' && /^(?:gpt|chat)-[a-z0-9_.:-]{1,96}$/.test(id));

export async function rememberOpenAiQqModelIds(ids, {file, now=Date.now()}={}) {
  file ??= await catalogFile();
  const distinct=[...new Set(ids)].sort();
  if (!validIds(distinct)) return false;
  const temporary=file+'.'+randomUUID()+'.tmp';
  try {
    await writeFile(temporary,JSON.stringify({verifiedAt:now,modelIds:distinct})+'\n',{flag:'wx',mode:0o600});
    await rename(temporary,file);
    return true;
  } catch { return false; }
  finally { await unlink(temporary).catch(()=>{}); }
}
export async function readOpenAiQqModelIds({file, now=Date.now()}={}) {
  file ??= await catalogFile();
  try {
    const data=JSON.parse(await readFile(file,'utf8'));
    if (!Number.isSafeInteger(data?.verifiedAt) || data.verifiedAt>now || now-data.verifiedAt>MAX_AGE ||
        !validIds(data.modelIds)) return null;
    return {verifiedAt:data.verifiedAt,modelIds:[...new Set(data.modelIds)]};
  } catch { return null; }
}
