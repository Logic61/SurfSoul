// 生活参数运维 CLI（操作者通道；不是 MCP 工具）。唯一的人工审批入口。
//
// 默认使用真实 DSH_HOME（env DSH_HOME 或 ~/.dsh）与脚本所在仓库的 root；
// `--dsh-home` / `--root` 可覆盖（隔离测试/演练用）。运行第一行会打印解析出的
// root / dshHome / scopeId —— 三个进程（bridge、B站 scheduler、MCP）必须用同一对值，
// 否则 scopeId 不同，看不到同一份 sidecar。
//
// 用法：
//   node scripts/life-settings.mjs state
//   node scripts/life-settings.mjs catalog [--query 群聊]
//   node scripts/life-settings.mjs explain --id purpose.enabled
//   node scripts/life-settings.mjs history [--offset 0 --limit 20]
//   node scripts/life-settings.mjs pending
//   node scripts/life-settings.mjs approve --plan <planId> --reason "<维护者说明>" [--revision N]
//   node scripts/life-settings.mjs recover-lock
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createManager } from '../src/life-settings/manager.js';
import { scopePaths, recoverStaleLock } from '../src/life-settings/file-store.js';

const args = process.argv.slice(2);
const command = args.shift() || 'help';
const option = (name) => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; };
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(option('root') || process.env.SURFCORE_ROOT || scriptRoot);
const dshHome = path.resolve(option('dsh-home') || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const paths = scopePaths({ root, dshHome });
process.stderr.write('root=' + root + '\n' + 'dshHome=' + dshHome + '\n' + 'scopeId=' + paths.scopeId + '\n');

try {
  let output;
  if (command === 'recover-lock') {
    // 只有 owner pid 已死才隔离锁目录；活进程/来源不明一律保留现场。
    output = recoverStaleLock(paths);
  } else {
    const manager = createManager({ root, dshHome });
    switch (command) {
      case 'state': output = manager.state(); break;
      case 'catalog': output = manager.catalog(option('query') || ''); break;
      case 'explain': output = manager.explain(option('id')); break;
      case 'history': output = manager.history({
        offset: option('offset') === undefined ? undefined : Number(option('offset')),
        limit: option('limit') === undefined ? undefined : Number(option('limit')),
      }); break;
      case 'pending': output = manager.pending(); break;
      case 'approve': {
        const planId = option('plan');
        const reason = option('reason');
        if (!planId) throw new Error('approve 需要 --plan <planId>');
        if (!reason) throw new Error('approve 需要 --reason <维护者说明>');
        const expectedRevision = option('revision') === undefined ? undefined : Number(option('revision'));
        output = manager.approve({ planId, reason, operator: 'cli-maintainer', expectedRevision });
        break;
      }
      default: output = {
        usage: 'node scripts/life-settings.mjs <state|catalog|explain|history|pending|approve|recover-lock> [--dsh-home <home>] [--root <repo>]',
        inputs: 'catalog --query <词>；explain --id <参数ID>；history --offset N --limit N；approve --plan <planId> --reason <说明> [--revision N]',
        home: dshHome, root,
        note: 'approve/recover-lock 是操作者动作；MCP 工具层没有 approve 入口。',
      };
    }
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  if (command === 'approve' && output && output.digest) process.stderr.write('planDigest=' + output.digest + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'rejected', error: String(error?.message ?? error) }) + '\n');
  process.exitCode = 1;
}
