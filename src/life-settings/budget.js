import fs from 'node:fs';
import { scopePaths } from './file-store.js';
import { readBudget, readDailyUsage, SCOPES } from '../token-budget.js';

/**
 * 只读预算快照：复用本地 src/token-budget.js 的真实账本格式（DSH_HOME/surfcore 下的
 * token-budget.json + token-usage-daily.json），不调用任何计费 API。
 * 与参考实现结构保持一致（scopes/limits/used/remaining/stale/officialBookedAmount:null）；
 * 预算只展示、不可经生活参数接口修改（硬闸在 token-guard 侧）。
 */
export function budgetSnapshot(options={}) {
  const paths=scopePaths(options), limits=readBudget(paths.dir), usage=readDailyUsage(paths.dir);
  const ageMs=usage.at ? Date.now()-usage.at : null;
  const stale=usage.stale || ageMs===null || ageMs<0 || ageMs>5*60000;
  const scopes=Object.fromEntries(SCOPES.map((scope)=>{
    const pair=limits[scope], used=usage[scope];
    return [scope,{
      limits:pair,
      used:stale?null:{estimatedCny:used.cost,tokens:used.tokens},
      remaining:stale?null:{
        estimatedCny:pair.cny===null?null:Math.max(0,pair.cny-used.cost),
        tokens:pair.tokens===null?null:Math.max(0,pair.tokens-used.tokens),
      },
    }];
  }));
  return {
    scopes,day:usage.day,updatedAt:usage.at?new Date(usage.at).toISOString():null,ageMs,stale,
    limitsSource:fs.existsSync(paths.dir+'/token-budget.json')?'saved-token-budget':'existing-engine-defaults',
    localEstimateSource:usage.source || null,officialBookedAmount:null,officialUpdatedAt:null,latestCacheHitRate:null,
    status:'official-billing-and-latest-cache-unknown',
    note:'用量来自 SurfCore 会话事件和价格估算；过期时剩余未知，null 也可表示未设置该类限额；不等于官方扣款。',
  };
}
