import { createHash } from 'node:crypto';

// Project MCP and HTTP arguments to the same actual operation, including its destination.
export function qqActionKey(tool, args = {}) {
  const key = String(args.key || '');
  const group = String(args.groupId ?? (key.startsWith('group:') ? key.slice(6) : ''));
  let parameters;
  switch (tool) {
    case 'qq_set_group_card': parameters = [group, String(args.userId ?? ''), String(args.card ?? '')]; break;
    case 'qq_set_group_ban': parameters = [group, String(args.userId ?? ''), Number(args.durationSeconds)]; break;
    case 'qq_send_cross_scene': parameters = [String(args.target ?? ''), String(args.message ?? '')]; break;
    case 'qq_list_friend_requests': parameters = []; break;
    case 'qq_handle_friend_request': parameters = [String(args.kind), String(args.flag), args.approve !== false]; break;
    case 'life_preview': case 'life_apply': case 'life_rollback': case 'life_observe':
      parameters = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'key' && k !== 'token'));
      break;
    default: return '';
  }
  const stable = (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v;
  return createHash('sha256').update(JSON.stringify([key, tool, parameters], stable)).digest('hex');
}
