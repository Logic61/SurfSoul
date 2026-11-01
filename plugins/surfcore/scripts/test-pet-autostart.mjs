// 桌宠「DSH 启动时自动打开」回归测试：
//   1. 纯判定 shouldAutoStartPet（装好 / 开关 / 已在跑 三种边界）；
//   2. petService.configure({autoStart}) 落盘与 status() 回读（用临时 stateDir，不碰真安装）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPetService, shouldAutoStartPet } from '../lib/pet.js';

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

console.log('## 1. 自动启动判定（纯函数）');
{
  ok(shouldAutoStartPet({ installed: false, autoStart: true, running: false }).start === false, '没装 → 不启动');
  ok(shouldAutoStartPet({ installed: false }).reason === 'not-installed', '没装 reason 可读');
  ok(shouldAutoStartPet({ installed: true, autoStart: false, running: false }).reason === 'disabled', '开关关 → 不启动');
  ok(shouldAutoStartPet({ installed: true, autoStart: true, running: true }).reason === 'already-running', '已在跑 → 不重复启动');
  const go = shouldAutoStartPet({ installed: true, autoStart: true, running: false });
  ok(go.start === true && go.reason === 'ok', '装好 + 开关开 + 没在跑 → 启动');
  ok(shouldAutoStartPet(undefined).start === false, '传 undefined 不抛');
  ok(shouldAutoStartPet({ installed: true, autoStart: 1 }).start === false, 'autoStart 非 true 一律视为关（不猜）');
}

console.log('## 2. 配置落盘与回读（临时 stateDir）');
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-pet-autostart-'));
  const pet = createPetService({ stateDir, pluginLog: () => {} });

  ok(pet.status().autoStart === false, '默认关闭（不会替用户打开）');

  pet.configure({ autoStart: true, source: 'https://example.com/pet-pack.zip' });
  ok(pet.status().autoStart === true, 'configure(autoStart:true) 后 status 回读为 true');
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'pet', 'config.json'), 'utf8'));
  ok(saved.autoStart === true, 'autoStart 真的落盘到 pet/config.json');
  ok(saved.source === 'https://example.com/pet-pack.zip', '同时保存的其它字段不丢');

  pet.configure({ electronPath: 'C:/x/electron.exe' });
  ok(pet.status().autoStart === true, '改别的字段不会把 autoStart 重置');

  pet.configure({ autoStart: false });
  ok(pet.status().autoStart === false, '可以关回去');
  ok(pet.status().electronPath === 'C:/x/electron.exe', '关 autoStart 不影响 electronPath');

  ok(pet.status().installed === false, '测试目录没装 app（判定会走 not-installed）');
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n✅ pet-autostart 通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
