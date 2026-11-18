import assert from 'node:assert/strict';
import { studyReply, cloudSpeech } from '../lib/study-model.js';
import { createStudyAudio } from '../lib/study-audio.js';
const body = { provider: 'local', frame: '/9j/2Q==', model: 'qwen3.5:latest' };
const role = { name: '甘棠' };
let requests = [];
async function infer(privacy, ollama) {
  requests = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/api/version')) return Response.json(ollama ? { version: '0.40' } : {});
    const payload = JSON.parse(init.body);
    requests.push(payload);
    const message = { content: JSON.stringify({ privacy, reply: '五' }) };
    return Response.json(ollama ? { message, eval_count: 14 } : { choices: [{ message }] });
  };
  return studyReply(body, { role, fetchImpl, signal: AbortSignal.timeout(1000) });
}
assert.equal((await infer('none', true)).text, '五');
assert.equal(requests[0].think, false);
assert.ok(requests[0].format.required.includes('privacy'));
assert.equal(requests[0].messages[0].images[0], body.frame);
assert.equal((await infer('sensitive', true)).text, '');
assert.equal((await infer('none', false)).text, '五');
assert.equal(requests[0].response_format.type, 'json_object');

let syntheses = 0;
const audio = createStudyAudio({ chat: { synthesize: async () => { syntheses++; return {ok:true,key:'42'}; } },
  audioUrlFor:key=>'/fixture/'+key, prefix:'/study/audio/', token:()=> 'test' });
const ticket = audio.issue('五', 'pet');
assert.equal(syntheses, 0);
const id = ticket.url.split('/').pop().split('?')[0];
function response() { return { writeHead(code, headers) {this.code=code;this.headers=headers;},end() {this.writableEnded=true;} }; }
const first = response(), second = response();
await Promise.all([audio.serve(id,first),audio.serve(id,second)]);
assert.equal(syntheses,1);
assert.equal(first.code,302);
assert.equal(second.headers.Location,'/fixture/42');

const upstreamVoices = [];
const previousFetch = globalThis.fetch;
try {
  globalThis.fetch = async (_url, request) => {
    upstreamVoices.push(JSON.parse(request.body).voice_id);
    const wav = Buffer.alloc(48);
    wav.write('WAVE', 8);
    return new Response(wav);
  };
  const stream = createStudyAudio({ chat:{}, keyFor:()=>'fixture', prefix:'/study/audio/', token:()=>'fixture' });
  const output = () => ({ ...response(), write() { return true; } });
  const spoken = stream.issue('同一句', 'deepseek', 'tide');
  const key = spoken.url.slice('/study/audio/'.length).split('?')[0];
  await stream.serve(key, output());
  await stream.serveChat('old', {text:'同一句'}, output());
  await stream.serveChat('new', {text:'同一句',voiceId:'tide'}, output());
  await stream.serveChat('new', {text:'同一句',voiceId:'tide'}, output());
  await cloudSpeech('同一句', ()=>'fixture', undefined, 'tide');
  assert.deepEqual(upstreamVoices, ['tide','stella','tide','tide']);
} finally { globalThis.fetch = previousFetch; }
console.log('PASS local structured vision, private frames, compatible endpoint, deferred and deduplicated audio.');
