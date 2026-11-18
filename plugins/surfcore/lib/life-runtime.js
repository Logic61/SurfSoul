/** Pure support for adopting a new Bilibili rhythm without resetting activity. */
import { createHash } from 'node:crypto'

export function nightSettingsFingerprint(night = {}) {
  const selected = {
    schedulePolicy: 'strict-gap-v1',
    windows: night.windows ?? [],
    maxWakesPerDay: night.maxWakesPerDay ?? 12,
    skipChance: night.skipChance ?? 0.3,
    minGapMin: night.minGapMin ?? 20,
  }
  return createHash('sha256').update(JSON.stringify(selected)).digest('hex')
}

/** Retain completed slots and counters. Pending opportunities may be replanned. */
export function reconcileNightPlanState(state = {}, night = {}, {
  now = new Date(), revision = 0,
} = {}) {
  const date = now.toLocaleDateString('sv-SE')
  const fingerprint = nightSettingsFingerprint(night)
  if (state.date !== date) return state
  if (state.scheduleSettingsFingerprint === fingerprint) {
    return { ...state, scheduleSettingsFingerprint: fingerprint }
  }
  return {
    date,
    wakes: Math.max(0, Number(state.wakes) || 0),
    watchWakes: Math.max(0, Number(state.watchWakes ?? state.wakes) || 0),
    wokeAt: state.wokeAt ?? null,
    replannedAt: now.toISOString(),
    scheduleSettingsFingerprint: fingerprint,
    scheduleChanges: [
      ...(Array.isArray(state.scheduleChanges) ? state.scheduleChanges : []),
      {
        at: now.toISOString(), revision, previousFingerprint: state.scheduleSettingsFingerprint ?? null,
        // This is the real previous plan, not a newly inferred experience.
        previousAction: state.action ?? null,
        previousSlots: Array.isArray(state.slots) ? state.slots : [],
      },
    ],
  }
}

/** Respect the gap to the most recent real wake across a same-day replan. */
export function nightNotBeforeMinute(state, minGapMin, now = new Date()) {
  const minute = now.getHours() * 60 + now.getMinutes()
  if (!(Number(state?.wakes) > 0)) return minute
  const at = new Date(state.wokeAt || state.replannedAt || 0)
  if (!Number.isFinite(at.getTime()) || at.toLocaleDateString('sv-SE') !== now.toLocaleDateString('sv-SE')) return minute
  return Math.max(minute, at.getHours() * 60 + at.getMinutes() + Math.max(0, Number(minGapMin) || 0))
}

export function plannedWakeTime(state, now = new Date()) {
  if (!state || state.date !== now.toLocaleDateString('sv-SE') || state.fired
    || !['wake', 'skip'].includes(state.action) || !Number.isFinite(Number(state.at))) return null
  const at = new Date(now)
  // The scheduler compares integer minutes; a fractional slot first becomes
  // eligible at the next whole minute, rather than the truncated earlier one.
  at.setHours(0, Math.ceil(Number(state.at)), 0, 0)
  return at.toISOString()
}
