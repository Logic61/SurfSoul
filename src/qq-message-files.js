import { execFile } from 'node:child_process';
import { safeFetchFileBuffer } from './safe-fetch.js';

// Only the main document XML is read. Never extract zip paths to disk or follow relationships.
const wordReader = `import sys, io, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    entry = z.getinfo("word/document.xml")
    if entry.file_size > 4000000: raise ValueError("large document")
    xml = z.read(entry)
    if b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper(): raise ValueError("DTD")
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    root = ET.fromstring(xml)
    text = "\\n".join("".join(t.text or "" for t in p.iter(ns+"t")) for p in root.iter(ns+"p"))
    sys.stdout.buffer.write(text[:12001].encode("utf-8"))`;

function extractText(exe, args, bytes) {
  return new Promise((resolve,reject) => {
    const child = execFile(exe,args,{timeout:8000,maxBuffer:512*1024,windowsHide:true},(error,text) =>
      error ? reject(error) : resolve(text));
    child.stdin.on('error',() => {});
    child.stdin.end(bytes);
  });
}

export async function readQqMessageFiles({bot,kind,peer,messageId,maxCount,maxBytes,acceptImage,imagesEnabled,download = safeFetchFileBuffer}) {
  const raw = await bot.getMessage(Number(messageId));
  const group = raw?.group_id ?? raw?.groupId;
  const sender = raw?.user_id ?? raw?.userId ?? raw?.sender?.user_id;
  if ((kind === 'group' ? String(group) !== String(peer) : group != null || String(sender) !== String(peer))
      || String(raw?.message_id ?? raw?.messageId ?? messageId) !== String(messageId)) {
    throw new Error('无法确认该文件来自当前会话');
  }
  const files = [];
  let remaining = maxBytes;
  for (const {data = {}} of (Array.isArray(raw?.message) ? raw.message : []).filter(s => s?.type === 'file').slice(0,maxCount)) {
    const name = String(data.name || data.file_name || data.file || 'QQ 文件').split(/[\\/]/).pop().slice(0,150);
    const ext = name.split('.').at(-1).toLowerCase();
    const image = /^(png|jpe?g|gif|webp)$/.test(ext);
    const file = {name};
    files.push(file);
    if (image && !imagesEnabled) { file.note = '当前会话已关闭看图'; continue; }
    if (!image && !/^(txt|md|csv|json|log|pdf|docx)$/.test(ext)) { file.note = '此格式仅提供文件名'; continue; }
    const id = data.file_id ?? data.fileId ?? data.id ?? (data.name ? data.file : undefined);
    if (!id || !/^[\w/+={}.-]{1,512}$/.test(String(id)) || String(id).includes('..') || !remaining || Number(data.file_size ?? data.size) > remaining) {
      file.note = '缺少可用文件标识或文件超过大小上限'; continue;
    }
    try {
      const ref = kind === 'group'
        ? await bot.getGroupFileUrl(peer,String(id),{busid:Number(data.busid ?? data.bus_id) || 0})
        : await bot.getPrivateFileUrl(peer,String(id),String(data.file_hash ?? data.fileHash ?? ''));
      const {buffer} = await download(ref.url,remaining);
      remaining -= buffer.length;
      if (image) {
        const valid = acceptImage(buffer);
        if (!valid) throw Error('invalid image');
        file.mimeType = valid.mimeType;
        file.data = buffer.toString('base64');
      } else {
        let text;
        if (ext === 'pdf') {
          if (!buffer.subarray(0,5).equals(Buffer.from('%PDF-'))) throw Error('invalid PDF');
          text = await extractText('pdftotext',['-enc','UTF-8','-f','1','-l','12','-','-'],buffer);
          file.note = '文字预览，最多前 12 页';
        } else if (ext === 'docx') {
          text = await extractText(process.platform === 'win32' ? 'python' : 'python3',['-I','-S','-c',wordReader],buffer);
        } else {
          text = new TextDecoder('utf-8',{fatal:true}).decode(buffer);
          if (text.includes('\u0000')) throw Error('binary file');
        }
        file.text = text.trim().slice(0,12000);
        if (text.trim().length > 12000) file.truncated = true;
        if (!file.text) file.note = '没有提取到文字';
      }
    } catch { file.note = '未能读取文件内容'; }
  }
  return files;
}
