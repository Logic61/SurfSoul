// 直连 OneBot HTTP 的**只读动作白名单**（2026-11-03 冻结）。
//
// 背景：MCP 工具面里绝大多数 QQ 动作都经桥接 HTTP（127.0.0.1:3100）执行，由桥接统一做
// 会话令牌 / 白名单 / 模式 / 审计。但有 5 个只读动作是**直连 SnowLuma OneBot HTTP** 的：
//   · `qq_status`          → get_login_info / get_status
//   · `qq_list_groups`     → get_group_list
//   · `qq_get_group_members` → get_group_member_list
//   · `qq_get_group_history` → get_group_msg_history
// 这样桥接没起来时模型仍能回答「QQ 在不在线 / 有哪些群」，不会表现为「QQ 工具全挂」。
//
// 风险：这条旁路**绕开桥接的发送白名单与审计**。因此把它冻结成一张只读白名单：
//   · 只允许 `get_*` / `fetch_*` 这类读取动作；
//   · 任何写动作（send_* / set_* / delete_* / upload_*…）一律拒绝，必须走桥接；
//   · 新增动作要同时改这里、测试与文档，不能悄悄加一条直连发送。
//
// 测试：scripts/test-egress-boundary.mjs（静态断言 MCP 里所有 onebot() 调用都在名单内、
// 名单里没有写动作、且桥接的发送端点仍是唯一写路径）。
export const ONEBOT_DIRECT_READ_ACTIONS = Object.freeze([
  'get_login_info',
  'get_status',
  'get_group_list',
  'get_group_member_list',
  'get_group_msg_history',
]);

const READONLY_SET = new Set(ONEBOT_DIRECT_READ_ACTIONS);

/** 一个动作是否允许直连 OneBot HTTP。 */
export function isReadonlyOneBotAction(action) {
  return READONLY_SET.has(String(action ?? ''));
}

/**
 * 直连前必须过的闸：不是白名单里的动作直接抛错。
 * 抛错而不是静默改走桥接——静默回退会让「明明写错了路径」看起来像成功。
 */
export function assertReadonlyOneBotAction(action) {
  const name = String(action ?? '');
  if (!READONLY_SET.has(name)) {
    throw new Error(
      `禁止直连 OneBot HTTP 的非只读动作「${name || '(空)'}」：`
      + 'QQ 写动作必须经桥接执行（白名单/审计/频率闸都在桥接里）',
    );
  }
  return name;
}
