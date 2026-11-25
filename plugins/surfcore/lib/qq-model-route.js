import { readFileSync } from 'node:fs';
import { QQ_CONFIG } from './paths.js';
import { DEFAULT_CODEX_MODEL, codexEffortFor, requireCodexModel } from './qq-codex-catalog.js';

import { OPENAI_QQ_PROVIDER, OPENAI_QQ_DEFAULT, requireOpenAiQqModel, requireOpenAiQqEffort } from './qq-openai-api.js';
import { MODELSNEXUS_ENGINE, MODELSNEXUS_PROVIDER, requireModelsNexusModel } from './qq-modelsnexus.js';

export const name = 'surfcore-qq-model-route';

// The DSH driver fixes model.current() immediately after claiming inbox
// messages. Select on the scoped agent before that point so tool schemas,
// prompt variables, attachments, accounting and generation use the same route.
export function apply(ctx) {
  function select(agent) {
    const {dsh = {}} = JSON.parse(readFileSync(QQ_CONFIG,'utf8').replace(/^\uFEFF/,''));
    if (dsh.qqEngine === MODELSNEXUS_ENGINE) {
      const {id:model} = requireModelsNexusModel(dsh.qqModelsNexusModel);
      const route = {model,provider:MODELSNEXUS_PROVIDER,reasoningEffort:undefined};
      const held = agent.model.current();
      if (Object.entries(route).some(([key,value]) => held?.[key] !== value)) agent.model.select(route);
      return;
    }
    if (dsh.qqEngine === 'openai-api') {
      const {id:model,supportsReasoning} = requireOpenAiQqModel(dsh.qqOpenAiModel || OPENAI_QQ_DEFAULT);
      const route = {model,provider:OPENAI_QQ_PROVIDER,
        reasoningEffort:supportsReasoning?requireOpenAiQqEffort(dsh.qqOpenAiEffort || 'low'):undefined};
      const held = agent.model.current();
      if (Object.entries(route).some(([key,value]) => held?.[key] !== value)) agent.model.select(route);
      return;
    }
    if (!['codex','deepseek'].includes(dsh.qqEngine)) return;
    const codex = dsh.qqEngine === 'codex';
    const model = codex ? dsh.qqCodexModel || DEFAULT_CODEX_MODEL : dsh.model || 'deepseek-flash';
    const route = {model,provider:codex ? 'surfcore-codex-cli' : dsh.provider || 'deepseek-official',
      reasoningEffort:codex ? codexEffortFor(requireCodexModel(model), dsh.qqCodexEffort) : dsh.reasoningEffort || 'low'};
    const held = agent.model.current();
    if (Object.entries(route).some(([key,value]) => held?.[key] !== value)) agent.model.select(route);
  }
  ctx.on('agent/inbox/claimed',({agent}) => select(agent));
}
