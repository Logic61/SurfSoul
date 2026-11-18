async function cloudRequest(route, keyFor, signal, body, json = false) {
  const key = await keyFor('DEEPSEEK_API_KEY');
  if (!key) throw new Error('请在 DSH 配置 DeepSeek API 密钥');
  const headers = { Authorization: 'Bearer ' + key };
  if (json) headers['Content-Type'] = 'application/json';
  const response = await fetch('https://api.deepseek.com/' + route, {
    method: 'POST', headers, signal, body, redirect: 'error',
  });
  if (!response.ok) throw new Error('DeepSeek ' + (json ? '对话' : '转写') + ' HTTP ' + response.status);
  return response.json();
}

export async function transcribe(audio, keyFor, signal) {
  if (typeof audio !== 'string' || audio.length > 1400000) throw new Error('录音过长或无效');
  const bytes = Buffer.from(audio, 'base64');
  if (bytes.length < 46 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 16) !== 'WAVEfmt '
      || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 16000
      || bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii', 36, 40) !== 'data'
      || bytes.readUInt32LE(40) !== bytes.length - 44) throw new Error('录音须为 16 kHz 单声道 PCM WAV');
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'audio/wav' }), 'speech.wav');
  const data = await cloudRequest('v1/tools/asr', keyFor, signal, form);
  return String(data.text ?? '').trim().slice(0, 2000);
}

export async function fastVoiceReply({ system, user, maxTokens }, keyFor, signal) {
  const model = 'deepseek-flash';
  const data = await cloudRequest('chat/completions', keyFor, signal, JSON.stringify({
    model, thinking: { type: 'disabled' }, max_tokens: maxTokens,
    messages: [{ role: 'system', content: system + '\n正在面对面说话。优先用一两句直接回应。' }, { role: 'user', content: user }],
  }), true);
  return { model, text: data.choices?.[0]?.message?.content, usage: data.usage && {
    inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens,
  } };
}
