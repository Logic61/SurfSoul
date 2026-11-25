import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_DEFAULT_EFFORT, CODEX_EFFORTS } from './qq-codex-effort.js';

export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';
const legacy = [
  [DEFAULT_CODEX_MODEL, 500000],
  ['gpt-6-astra', 272000],
].map(([id, contextWindow]) => ({
  id, name: id, contextWindow, inputModalities: ['text', 'image'],
  reasoning: { efforts: CODEX_EFFORTS, defaultEffort: CODEX_DEFAULT_EFFORT },
}));
let saved;

export function readCodexCatalog() {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
  try {
    const { mtimeMs, size } = statSync(file);
    if (saved?.file === file && saved.mtimeMs === mtimeMs && saved.size === size) return saved.catalog;
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(parsed.models)) throw new Error('Invalid Codex model cache');
    const models = parsed.models
      .filter(row => row?.visibility === 'list' && typeof row.slug === 'string' && row.input_modalities?.includes('text'))
      .map(row => ({
        id: row.slug,
        name: row.display_name || row.slug,
        inputModalities: row.input_modalities.filter(kind => kind === 'text' || kind === 'image'),
        contextWindow: row.context_window,
        reasoning: {
          efforts: (row.supported_reasoning_levels ?? []).map(({ effort, description }) => ({
            id: effort, name: CODEX_EFFORTS.find(item => item.id === effort)?.name || effort, description,
          })),
          defaultEffort: row.default_reasoning_level,
        },
      }));
    const catalog = { models, source: 'codex' };
    saved = { file, mtimeMs, size, catalog };
    return catalog;
  } catch {
    return saved?.file === file ? saved.catalog : { models: legacy, source: 'fallback' };
  }
}

export function requireCodexModel(id) {
  const model = readCodexCatalog().models.find(row => row.id === id);
  if (!model) throw new Error('QQ 所选模型不在当前 Codex 目录：' + id);
  return model;
}

export function codexEffortFor(model, requested) {
  const { efforts, defaultEffort } = model.reasoning;
  const supports = id => efforts.some(item => item.id === id);
  if (supports(requested)) return requested;
  if (supports(CODEX_DEFAULT_EFFORT)) return CODEX_DEFAULT_EFFORT;
  return supports(defaultEffort) ? defaultEffort : efforts[0]?.id;
}

export function validateCodexEffort(model, value) {
  if (!model.reasoning.efforts.some(item => item.id === value)) throw new Error('所选 Codex 模型不支持该思考强度');
  return value;
}
