// Both QQ Codex models advertise these effort IDs in the local model catalog.
export const CODEX_DEFAULT_EFFORT = 'low';
export const CODEX_EFFORTS = [
  { id: 'low', name: '轻度' },
  { id: 'medium', name: '中等' },
  { id: 'high', name: '高' },
  { id: 'xhigh', name: '很高' },
  { id: 'max', name: '极高' },
  { id: 'ultra', name: '最高' },
];

export function validateCodexEffort(value) {
  if (!CODEX_EFFORTS.some(({ id }) => id === value)) throw new Error('未知的 Codex 思考强度');
  return value;
}
