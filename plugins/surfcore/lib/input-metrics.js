import fs from 'node:fs';
import path from 'node:path';
import { QQ_STATE_DIR } from './paths.js';

// Separate files for the two plugin producers. Each has one rotating backup.
export function recordInputMetrics(channel, numbers) {
  try {
    const file = path.join(QQ_STATE_DIR, channel + '-input-metrics.jsonl');
    if (fs.statSync(file, {throwIfNoEntry:false})?.size >= 1024 * 1024) fs.renameSync(file, file + '.1');
    fs.mkdirSync(QQ_STATE_DIR, {recursive:true});
    fs.appendFileSync(file, JSON.stringify({at:Date.now(), ...numbers}) + '\n');
  } catch { /* diagnostics must never block a model call */ }
}
