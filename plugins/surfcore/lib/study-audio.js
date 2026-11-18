import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cloudSpeechStream } from './study-model.js';

// A short-lived ticket lets the bubble render immediately. Its player and replay
// button share one synthesis even if Chromium opens the media URL twice.
export function createStudyAudio({ chat, keyFor, audioUrlFor, prefix, token }) {
  const tickets = new Map();
  function remember(id, text, voice, voiceId) {
    if (tickets.size >= 32) tickets.delete(tickets.keys().next().value);
    const ticket = { text, voice, voiceId };
    tickets.set(id, ticket);
    const expiry = setTimeout(() => tickets.delete(id), 10 * 60_000);
    expiry.unref();
  }
  function issue(text, voice, voiceId) {
    const id = randomUUID();
    remember(id, text, voice, voiceId);
    return { url: prefix + id + '?token=' + encodeURIComponent(token()) };
  }
  async function synthesize(ticket, res) {
    if (ticket.voice === 'pet') {
      const audio = await chat.synthesize(ticket.text);
      if (!audio.ok) throw new Error(audio.error);
      return { location: audioUrlFor(audio.key) };
    }
    const signal = AbortSignal.timeout(60000);
    const upstream = await cloudSpeechStream(ticket.text, keyFor, signal, ticket.voiceId);
    const parts = [];
    let length = 0;
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
    for await (const part of upstream.body) {
      length += part.length;
      if (length > 4 * 1024 * 1024) throw new Error('朗读音频过长');
      parts.push(part);
      if (!res.destroyed && !res.write(part)) {
        const drained = once(res, 'drain', { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
        await drained.catch(() => { if (!res.destroyed) res.destroy(); });
      }
    }
    if (!res.destroyed) res.end();
    return { bytes: Buffer.concat(parts) };
  }
  async function serve(id, res) {
    const ticket = tickets.get(id);
    if (!ticket) { res.writeHead(404); res.end(); return; }
    try {
      ticket.ready ??= synthesize(ticket, res);
      const audio = await ticket.ready;
      if (res.writableEnded || res.destroyed) return;
      if (audio.location) { res.writeHead(302, { Location: audio.location, 'Cache-Control': 'no-store' }); res.end(); }
      else { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.bytes.length, 'Cache-Control': 'no-store' }); res.end(audio.bytes); }
    } catch {
      ticket.ready = null;
      if (!res.headersSent) { res.writeHead(502); res.end(); }
      else res.destroy();
    }
  }
  function serveChat(id, message, res) {
    if (!tickets.has(id)) remember(id, message.text, 'deepseek', message.voiceId);
    return serve(id, res);
  }
  return { issue, serve, serveChat };
}
