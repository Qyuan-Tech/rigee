/**
 * Workspace heat: how lately, and how much, each workspace has been used, worked out from its
 * activity record — for the side bar to colour the list by, and to order it by unless the user has
 * it ordered by when anything last happened in each, by when each was added, or by name
 * (`rankWorkspaces`).
 *
 * Pure, as `groups.ts` and `tabs.ts` are, so `pnpm panes:selftest` can hold it to its numbers:
 * everything in here fails quietly. A decay that ran on the calendar would greet somebody back
 * from a fortnight away with every workspace cold and an offer to remove the lot; a terminal left
 * printing that counted for as much as the user would make a forgotten `tail -f` the hottest thing
 * in the list.
 *
 * Heat runs from 0 to 1 and is mostly how recently the user was in a workspace: full the minute
 * they were, it fades by the hour once they leave, then by a day of use at a time. How much they
 * have used it lately makes up the rest — the same moment of use is half as hot for a glance as for
 * a workspace in heavy use — so the colour fades as a workspace goes unused, rather than standing
 * for minutes that piled up last week. Its terminals printing on their own warm it too, but never
 * past OUTPUT_GLOW: an agent at work keeps its workspace from going cold, but only the user makes
 * one hot.
 *
 * AGE IS COUNTED IN DAYS OF USE, NOT CALENDAR DAYS: today, and each day on which the user did
 * something in any workspace. A weekend or a holiday adds none, so the list comes back from one
 * looking as it was left, and "cold" means passed over while other things were being worked on —
 * which is the only sense in which it is a reason to remove anything. Only within today does heat
 * fade by the clock — which is what "a while ago" means while the user is there — and never
 * further than a day of use would take it: a lunch break dims the morning's work, and a weekend
 * dims Friday's no more than a night would.
 */

import { t, tn } from '@shared/l10n'
import type { ActivityDay, WorkspaceActivity, WorkspaceSort } from '@shared/types'

/** What each day of use leaves of what came before it — of a minute's worth, and of heat: 0.6. */
export const DAILY_DECAY = 0.6
/**
 * Hours in which the heat of a use today fades as far as a day of use would take it, and stops:
 * an hour after the user leaves a workspace it has 0.88 of the heat it had, four hours after 0.6.
 */
export const FADE_HOURS = 4
/** The hottest a workspace's terminals printing on their own can make it, against the user's 1. */
export const OUTPUT_GLOW = 0.4
/** How hot a glance makes a workspace, just now; use lately makes up the rest, up to 1. */
export const LEAST_GLOW = 0.5
/** Minutes of use lately that take a workspace most of the way — 63% — from a glance's heat to full. */
export const BUSY_MINUTES = 20
/** A minute of a workspace's terminals printing is worth a tenth of a minute of the user's… */
export const OUTPUT_WEIGHT = 0.1
/** …and all of it together no more than twenty minutes of the user's. */
export const OUTPUT_CEILING = 20
/** Days of use with nothing at all in a workspace before it is cold, and offered for removal. */
export const COLD_AFTER = 10
/** Days kept per workspace: past COLD_AFTER, and far enough back that decay has done its work. */
export const KEEP_DAYS = 28
/**
 * Characters a workspace's terminals must print in a minute for the minute to count. A shell
 * starting up — a prompt, a theme, a message of the day — stays under it, so restoring a terminal
 * does not warm the workspace it was in; an agent at work or a build goes well past it.
 */
export const OUTPUT_MINUTE_CHARS = 8192

/** The local date of `ms` as `YYYY-MM-DD`: what a day of use is called, and sortable as text. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * A record for a workspace nothing has happened in yet. Starting it today is what keeps a
 * workspace from being cold before it has had the chance — every workspace there was when heat
 * arrived, included.
 */
export function freshActivity(now: number): WorkspaceActivity {
  return { since: localDay(now), days: [] }
}

/**
 * The record with one more minute of `kind` in it, on today's entry. Counting each minute once is
 * the caller's business; this keeps the days newest first and a few weeks long.
 */
export function recordMinute(
  activity: WorkspaceActivity | undefined,
  kind: 'used' | 'output',
  now: number
): WorkspaceActivity {
  const day = localDay(now)
  const base = activity ?? freshActivity(now)
  const prior = base.days.find((d) => d.day === day)
  const today: ActivityDay = { day, used: prior?.used ?? 0, output: prior?.output ?? 0 }
  today[kind] += 1
  // Sorted rather than prepended: a clock put back across midnight would leave a day out of place.
  const days = [today, ...base.days.filter((d) => d.day !== day)].sort(newestFirst).slice(0, KEEP_DAYS)
  return kind === 'used' ? { ...base, usedAt: now, days } : { ...base, outputAt: now, days }
}

const newestFirst = (a: ActivityDay, b: ActivityDay): number => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)

/**
 * The days of use, newest first: today, and every day on which the user did something in any
 * workspace. Output alone does not make one — a program left printing over a holiday would age
 * every other workspace by a day for each day of it.
 */
export function activityClock(records: Iterable<WorkspaceActivity | undefined>, today: string): string[] {
  const days = new Set<string>([today])
  for (const record of records) {
    for (const d of record?.days ?? []) if (d.used > 0 && d.day <= today) days.add(d.day)
  }
  return [...days].sort().reverse()
}

/** How many days of use there have been since `day`: 0 for today. */
export function ageOf(day: string, clock: readonly string[]): number {
  let age = 0
  while (age < clock.length && clock[age] > day) age++
  return age
}

/** How much a workspace has been used lately, in minutes of use as they count today. */
export function minutesOf(activity: WorkspaceActivity | undefined, clock: readonly string[]): number {
  let used = 0
  let output = 0
  for (const d of activity?.days ?? []) {
    const worth = DAILY_DECAY ** ageOf(d.day, clock)
    used += d.used * worth
    output += d.output * worth
  }
  return used + Math.min(output * OUTPUT_WEIGHT, OUTPUT_CEILING)
}

/**
 * How recently anything happened in a workspace, 1 for just now: the more of what the user's last
 * minute in it leaves and what its terminals' last minute of output leaves, at OUTPUT_GLOW the
 * strength.
 */
export function recencyOf(activity: WorkspaceActivity | undefined, clock: readonly string[], now: number): number {
  if (!activity) return 0
  const last = (kind: 'used' | 'output'): string | undefined => activity.days.find((d) => d[kind] > 0)?.day
  return Math.max(
    fadeOf(last('used'), activity.usedAt, clock, now),
    OUTPUT_GLOW * fadeOf(last('output'), activity.outputAt, clock, now)
  )
}

/**
 * What is left by `now` of something that happened on `day` — at `at`, if that was today: by the
 * clock within today, down to DAILY_DECAY in FADE_HOURS and no further, which is where the first
 * day of use leaves it, so midnight moves nothing; before today, DAILY_DECAY for each day of use.
 */
function fadeOf(day: string | undefined, at: number | undefined, clock: readonly string[], now: number): number {
  if (!day) return 0
  const age = ageOf(day, clock)
  if (age > 0) return DAILY_DECAY ** age
  // With no time of day to go by — a record somebody edited — as faded as today can make it.
  const hours = at === undefined ? FADE_HOURS : Math.max(0, now - at) / HOUR
  return DAILY_DECAY ** Math.min(hours / FADE_HOURS, 1)
}

const HOUR = 3_600_000

/**
 * How hot a workspace is, from 0 to 1: how recently it was used, scaled by how much it has been
 * used lately — LEAST_GLOW of it for a glance, all of it for a workspace in heavy use. So the one
 * the user is working in is at or near the top, a glance just now outshines a full day's work two
 * days of use ago, and of two used at the same moment the busier is the hotter.
 */
export function heatOf(activity: WorkspaceActivity | undefined, clock: readonly string[], now: number): number {
  const busy = 1 - Math.exp(-minutesOf(activity, clock) / BUSY_MINUTES)
  return recencyOf(activity, clock, now) * (LEAST_GLOW + (1 - LEAST_GLOW) * busy)
}

/**
 * Whether a workspace is cold: COLD_AFTER days of use with nothing at all in it, however busy it
 * once was. Cold is what the side bar offers to remove, and "not touched in your last ten days of
 * work" is a reason anybody can check, where "its heat dropped below a twentieth" is not.
 *
 * No record at all is evidence of nothing, so it is not cold.
 */
export function isCold(activity: WorkspaceActivity | undefined, clock: readonly string[]): boolean {
  if (!activity) return false
  const newest = activity.days[0]?.day
  const latest = newest && newest > activity.since ? newest : activity.since
  return ageOf(latest, clock) >= COLD_AFTER
}

/** When anything last happened in a workspace — the user, or its terminals — or null if nothing has. */
export function lastActiveAt(activity: WorkspaceActivity | undefined): number | null {
  const at = Math.max(activity?.usedAt ?? 0, activity?.outputAt ?? 0)
  return at > 0 ? at : null
}

/** What the side bar colours and orders a workspace by. */
export interface Warmth {
  /** `isCold`: faded, below the divider, and offered for removal. */
  cold: boolean
  /** `heatOf`, 0 to 1. */
  heat: number
  /** Epoch ms; 0 for never. */
  lastActive: number
}

/**
 * Hottest first; the cold ones last, the most recently active of them first. Equal heat goes to the
 * more recent, and anything still tied keeps its place — `Array.prototype.sort` is stable — so two
 * workspaces nobody has touched do not trade places from one render to the next.
 */
export function compareWarmth(a: Warmth, b: Warmth): number {
  if (a.cold !== b.cold) return a.cold ? 1 : -1
  if (!a.cold && a.heat !== b.heat) return b.heat - a.heat
  return b.lastActive - a.lastActive
}

/**
 * The side bar's two runs of workspaces, by id: those used lately, hottest first, then the cold.
 * Ordered by date added or by name, every workspace is in the first and the second is empty.
 */
export interface Ranking {
  recent: string[]
  cold: string[]
}

/** A workspace as the side bar orders it: its warmth, and what the other orders go by. */
export interface Listed extends Warmth {
  id: string
  name: string
  /** When it was added, epoch ms, as the workspace records it. */
  createdAt: number
}

/**
 * The side bar's two runs, in the order the user chose.
 *
 * By heat or by when anything last happened, the cold ones go below their divider: both are orders
 * by use, and a workspace passed over for ten days of use is at the end of either. By date added or
 * by name the list is one run, a cold workspace in its place and only faded, because an order chosen
 * for staying put must not move a workspace for going cold. Ties keep their places throughout.
 */
export function rankWorkspaces(listed: readonly Listed[], sort: WorkspaceSort): Ranking {
  if (sort === 'created' || sort === 'name') {
    return { recent: [...listed].sort(sort === 'created' ? newestAdded : byName).map((w) => w.id), cold: [] }
  }
  const sorted = [...listed].sort(sort === 'recent' ? latestActive : compareWarmth)
  return {
    recent: sorted.filter((w) => !w.cold).map((w) => w.id),
    cold: sorted.filter((w) => w.cold).map((w) => w.id)
  }
}

/** The most recently active first, and never last: the times down the right of the rows, in order. */
const latestActive = (a: Warmth, b: Warmth): number => b.lastActive - a.lastActive

/** The newest first. A time that is not one, from a hand-edited document, counts as the oldest. */
const newestAdded = (a: Listed, b: Listed): number => epochMs(b.createdAt) - epochMs(a.createdAt)
const epochMs = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** As a person files them: `api2` before `api10`, and `Rigee` beside `rigee`. */
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const byName = (a: Listed, b: Listed): number => names.compare(a.name, b.name)

/**
 * The workspaces in `live`, placed as they were in `held` — the list as it stood when the pointer
 * came over it. One added since goes at the end of the recent run; one removed since is gone.
 *
 * Without this the list re-sorts under the pointer. Clicking a workspace adds a minute to it, which
 * can be enough to move it up a place, and a terminal printing in another can move that one at any
 * moment — and the next click lands on whatever slid into the place being aimed at.
 */
export function holdRanking(held: Ranking, live: Ranking): Ranking {
  const alive = new Set([...live.recent, ...live.cold])
  const heldCold = new Set(held.cold)
  const recent = held.recent.filter((id) => alive.has(id))
  const placed = new Set(recent)
  for (const id of [...live.recent, ...live.cold]) {
    if (!placed.has(id) && !heldCold.has(id)) recent.push(id)
  }
  return { recent, cold: held.cold.filter((id) => alive.has(id)) }
}

/** How long ago, in the largest unit that fits — or null, under a minute. */
function age(then: number, now: number): { n: number; unit: 'm' | 'h' | 'd' | 'w' | 'mo' | 'y' } | null {
  const minutes = Math.floor((now - then) / 60_000)
  if (minutes < 1) return null
  if (minutes < 60) return { n: minutes, unit: 'm' }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { n: hours, unit: 'h' }
  const days = Math.floor(hours / 24)
  if (days < 14) return { n: days, unit: 'd' }
  if (days < 61) return { n: Math.floor(days / 7), unit: 'w' }
  if (days < 365) return { n: Math.floor(days / 30), unit: 'mo' }
  return { n: Math.floor(days / 365), unit: 'y' }
}

/** How long ago, as short as the side bar has room for: `now`, `5m`, `3h`, `2d`, `3w`, `4mo`, `2y`. */
export function shortAgo(then: number, now: number): string {
  const a = age(then, now)
  if (!a) return t('now')
  switch (a.unit) {
    case 'm': return t('{n}m', { n: a.n })
    case 'h': return t('{n}h', { n: a.n })
    case 'd': return t('{n}d', { n: a.n })
    case 'w': return t('{n}w', { n: a.n })
    case 'mo': return t('{n}mo', { n: a.n })
    case 'y': return t('{n}y', { n: a.n })
  }
}

/** The same in words, for a tooltip: `just now`, `5 minutes ago`, `3 weeks ago`. */
export function longAgo(then: number, now: number): string {
  const a = age(then, now)
  if (!a) return t('just now')
  switch (a.unit) {
    case 'm': return tn(a.n, '1 minute ago', '{n} minutes ago')
    case 'h': return tn(a.n, '1 hour ago', '{n} hours ago')
    case 'd': return tn(a.n, '1 day ago', '{n} days ago')
    case 'w': return tn(a.n, '1 week ago', '{n} weeks ago')
    case 'mo': return tn(a.n, '1 month ago', '{n} months ago')
    case 'y': return tn(a.n, '1 year ago', '{n} years ago')
  }
}

/**
 * An activity record from disk, made safe to compute with — or undefined when nothing in it is
 * usable. Main keeps the UI map exactly as it was handed over, and the document is a file anybody
 * can edit; a `days` that is not a list must not take the side bar down with it.
 */
export function sanitizeActivity(raw: unknown): WorkspaceActivity | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  const minutes = (v: unknown): number => (typeof v === 'number' && v > 0 && Number.isFinite(v) ? Math.floor(v) : 0)
  const time = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : undefined)

  const days: ActivityDay[] = []
  for (const entry of Array.isArray(record.days) ? (record.days as unknown[]) : []) {
    const d = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
    if (!isDay(d.day) || days.some((x) => x.day === d.day)) continue
    days.push({ day: d.day, used: minutes(d.used), output: minutes(d.output) })
  }
  days.sort(newestFirst)
  const since = isDay(record.since) ? record.since : days[days.length - 1]?.day
  if (!since) return undefined
  const usedAt = time(record.usedAt)
  const outputAt = time(record.outputAt)
  return {
    since,
    ...(usedAt ? { usedAt } : {}),
    ...(outputAt ? { outputAt } : {}),
    days: days.slice(0, KEEP_DAYS)
  }
}
