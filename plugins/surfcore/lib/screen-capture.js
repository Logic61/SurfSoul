/**
 * SurfCore · 屏幕截图（Windows / PowerShell + System.Drawing）
 *
 * 为什么不用 npm 包：桌面版 DSH 的插件不允许随便加依赖；Windows 自带的
 * PowerShell 5.1 + System.Drawing 已经能做 DPI 感知的多屏截图，够用且零安装。
 *
 * 约定：
 *   · 截图只落在临时目录，调用方读完即删（`keep` 只在排障时打开）；
 *   · 返回的是 JPEG 字节，不是路径 —— 视觉请求只要 bytes；
 *   · 任何失败都返回 `{ok:false, error}`，不抛异常（上层按 fail-open 处理）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// 用 UTF-16LE base64 传脚本（-EncodedCommand），不要用字符串拼命令行：
// 反斜杠/引号/中文在 cmd 和 PowerShell 之间会互相吃掉，过一遍 base64 最稳。
const CAPTURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not ('DshScreenDpi' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshScreenDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
}
try { [DshScreenDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { try { [DshScreenDpi]::SetProcessDPIAware() | Out-Null } catch {} }
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$sw = [int]$bounds.Width
$sh = [int]$bounds.Height
if ($sw -le 0 -or $sh -le 0) { throw 'screen bounds unavailable' }
$bmp = New-Object -TypeName System.Drawing.Bitmap -ArgumentList $sw, $sh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, (New-Object -TypeName System.Drawing.Size -ArgumentList $sw, $sh))
$g.Dispose()
$maxW = [int]$env:SURFCORE_SCREEN_MAXW
$q = [int]$env:SURFCORE_SCREEN_QUALITY
$w = $sw
$h = $sh
if ($w -gt $maxW) { $h = [int][Math]::Round($h * $maxW / $w); $w = $maxW }
$out = New-Object -TypeName System.Drawing.Bitmap -ArgumentList $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($out)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $w, $h)
$g2.Dispose()
$bmp.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$enc = New-Object -TypeName System.Drawing.Imaging.EncoderParameters -ArgumentList 1
$enc.Param[0] = New-Object -TypeName System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality), $q
$out.Save($env:SURFCORE_SCREEN_OUT, $codec, $enc)
$out.Dispose()
Write-Output ('{"ok":true,"width":' + $w + ',"height":' + $h + '}')
`;

function encodedScript() {
  return Buffer.from(CAPTURE_SCRIPT, 'utf16le').toString('base64');
}

function defaultOutFile() {
  const dir = path.join(os.tmpdir(), 'surfcore-screen');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `shot-${Date.now()}.jpg`);
}

function parseStdout(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && value.ok === true) return value;
    } catch {}
  }
  return null;
}

/**
 * 截一张屏幕（多显示器按虚拟桌面整体截），下采样成 JPEG。
 * @param {object} [opts]
 * @param {string} [opts.outFile] 临时文件路径；不传就放系统临时目录。
 * @param {number} [opts.maxWidth] 最大宽度（像素）。
 * @param {number} [opts.quality] JPEG 质量 1~100。
 * @param {number} [opts.timeoutMs] 子进程超时。
 * @param {boolean} [opts.keep] 保留临时文件（排障）。
 * @param {Function} [opts.execFileImpl] 测试注入。
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mediaType?:string, width?:number, height?:number, bytes?:number, ms?:number, path?:string, error?:string}>}
 */
export function captureScreen(opts = {}) {
  const outFile = String(opts.outFile || defaultOutFile());
  const maxWidth = Math.min(2560, Math.max(480, Math.round(Number(opts.maxWidth) || 1280)));
  const quality = Math.min(90, Math.max(40, Math.round(Number(opts.quality) || 70)));
  const timeoutMs = Math.min(180_000, Math.max(5_000, Math.round(Number(opts.timeoutMs) || 60_000)));
  const keep = opts.keep === true;
  const exec = typeof opts.execFileImpl === 'function' ? opts.execFileImpl : execFile;
  const started = Date.now();
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); } catch {}

  return new Promise((resolve) => {
    const cleanup = () => {
      if (keep) return;
      try { fs.rmSync(outFile, { force: true }); } catch {}
    };
    exec('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodedScript(),
    ], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        SURFCORE_SCREEN_OUT: outFile,
        SURFCORE_SCREEN_MAXW: String(maxWidth),
        SURFCORE_SCREEN_QUALITY: String(quality),
      },
    }, (error, stdout, stderr) => {
      if (error) {
        cleanup();
        const message = String(stderr || error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 200);
        resolve({ ok: false, error: `截图失败：${message || 'PowerShell 执行失败'}`, ms: Date.now() - started });
        return;
      }
      const meta = parseStdout(stdout);
      let buffer = null;
      try { buffer = fs.readFileSync(outFile); } catch {}
      cleanup();
      if (!buffer || buffer.length < 1024) {
        resolve({ ok: false, error: '截图失败：没有拿到有效的 JPEG 数据', ms: Date.now() - started });
        return;
      }
      resolve({
        ok: true,
        buffer,
        mediaType: 'image/jpeg',
        width: Number(meta?.width) || 0,
        height: Number(meta?.height) || 0,
        bytes: buffer.length,
        ms: Date.now() - started,
        ...(keep ? { path: outFile } : {}),
      });
    });
  });
}
