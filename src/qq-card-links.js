import { truncateText } from './md-to-plain.js';

const CARD_TYPES = new Set(['json', 'share', 'xml']);
const MAX_PAYLOAD = 64 * 1024;
const MAX_LINKS = 4;

function httpUrl(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text.length > 2048 || !/^https?:\/\//i.test(text) || /[\s\u0000-\u001f\u007f]/u.test(text)) return '';
  try {
    const url = new URL(text);
    return url.username || url.password ? '' : text;
  } catch { return ''; }
}

function cardTitle(value) {
  return typeof value === 'string' ? truncateText(value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim(), 80) : '';
}

function destination(data) {
  return [data?.jumpUrl, data?.qqdocurl, data?.webUrl, data?.web_url, data?.url].map(httpUrl).find(Boolean);
}

function decodeXml(text) {
  const entities = { amp:'&', quot:'"', apos:"'", lt:'<', gt:'>' };
  return text.replace(/&(amp|quot|apos|lt|gt);/g, (_, key) => entities[key]);
}

function xmlCard(xml) {
  if (typeof xml !== 'string' || xml.length > MAX_PAYLOAD) return null;
  const opening = /<msg\b((?:"[^"]*"|'[^']*'|[^'"<>])*)>/i.exec(xml)?.[1];
  if (!opening) return null;
  const attrs = Object.fromEntries(Array.from(opening.matchAll(/([\w]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
    ([,key,quoted,single]) => [key, decodeXml(quoted ?? single)]));
  return { url:attrs.url, title:attrs.title };
}

function cardSegment(type, data) {
  if (!CARD_TYPES.has(type)) return null;
  if (type === 'share') return data;
  if (type === 'xml') return xmlCard(data?.data ?? data?.xml);
  const payload = data?.data ?? data?.json ?? data;
  if (typeof payload !== 'string') return payload;
  if (payload.length > MAX_PAYLOAD) return null;
  try { return JSON.parse(payload); } catch { return null; }
}

function readCard(type, data) {
  const payload = cardSegment(type, data);
  if (!payload || typeof payload !== 'object' || payload.app === 'com.tencent.multimsg') return null;
  // SnowLuma's Bilibili mini-app shares put the web fallback in meta.detail_1.qqdocurl.
  // Read navigation fields only; thumbnails, app tokens and other service metadata stay out of chat.
  const entries = [
    payload.meta?.news, payload.meta?.detail_1,
    ...Object.values(payload.meta ?? {}).slice(0, 16),
    payload,
  ];
  for (const entry of entries) {
    const url = destination(entry);
    if (url) {
      const title = cardTitle(entry.title ?? payload.title);
      return { url, ...(title ? { title } : {}) };
    }
  }
  return null;
}

function replaceCqCards(text, render) {
  const entities = { '&#44;':',', '&#91;':'[', '&#93;':']', '&amp;':'&' };
  return text.replace(/\[CQ:(json|share|xml),([^\]]*)\]/g, (_, type, params) => {
    const data = Object.fromEntries(params.split(',').map(field => {
      const equal = field.indexOf('=');
      return equal > 0 ? [field.slice(0,equal), field.slice(equal+1).replace(/&#(?:44|91|93);|&amp;/g, code => entities[code])] : ['', ''];
    }));
    return render(type, data);
  });
}

export function formatQqCard(type, data, includeUrl = false) {
  const card = readCard(type, data);
  if (!card) return '[卡片消息]';
  const label = card.title ? `[链接卡片 ${card.title}]` : '[链接卡片]';
  return includeUrl ? label + ' ' + card.url + ' ' : label;
}

export function formatQqCqCards(text, includeUrl = false) {
  return replaceCqCards(text, (type,data) => formatQqCard(type,data,includeUrl));
}

export function extractQqCardLinks(segments) {
  const links = new Map();
  const add = (type,data) => {
    if (links.size < MAX_LINKS) {
      const card = readCard(type,data);
      if (card && !links.has(card.url)) links.set(card.url,card);
    }
    return '';
  };
  if (typeof segments === 'string') replaceCqCards(segments,add);
  else if (Array.isArray(segments)) for (const segment of segments) add(segment?.type,segment?.data);
  return [...links.values()];
}

export function qqMessageCardLinks(message) {
  const links = extractQqCardLinks(message?.message);
  return links.length ? links : extractQqCardLinks(message?.raw_message);
}
