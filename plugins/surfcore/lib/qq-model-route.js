import { readFileSync } from 'node:fs';
import { QQ_CONFIG } from './paths.js';
import { CODEX_DEFAULT_EFFORT, validateCodexEffort } from './qq-codex-effort.js';

export const name = 'surfcore-qq-model-route';

// The DSH driver fixes model.current() immediately after claiming inbox
// messages. Select on the scoped agent before that point so tool schemas,
// prompt variables, attachments, accounting and generation use the same route.
export function apply(ctx) {
  function select(agent) {
    const {dsh = {}} = JSON.parse(readFileSync(QQ_CONFIG,'utf8').replace(/^\uFEFF/,''));
    if (!['codex','deepseek'].includes(dsh.qqEngine)) return;
    const codex = dsh.qqEngine === 'codex';
    const model = codex ? dsh.qqCodexModel || 'gpt-6.1-sol' : dsh.model || 'deepseek-flash';
    if (codex && !['gpt-6.1-sol','gpt-6-astra'].includes(model)) throw new Error('Invalid QQ Codex model');
    const route = {model,provider:codex ? 'surfcore-codex-cli' : dsh.provider || 'deepseek-official',
      reasoningEffort:codex ? validateCodexEffort(dsh.qqCodexEffort ?? CODEX_DEFAULT_EFFORT) : dsh.reasoningEffort || 'low'};
    const held = agent.model.current();
    if (Object.entries(route).some(([key,value]) => held?.[key] !== value)) agent.model.select(route);
  }
  ctx.on('agent/inbox/claimed',({agent}) => select(agent));
}
