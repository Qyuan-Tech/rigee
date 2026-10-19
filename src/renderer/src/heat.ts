/**
 * Workspace heat: how much each workspace has been used lately, worked out from its activity
 * record, for the side bar to colour the list by and order it by — unless the user has it ordered
 * by when anything last happened in each, by when each was added, or by name (`rankWorkspaces`).
 *
 * Pure, as `groups.ts` and `tabs.ts` are, so `pnpm panes:selftest` can hold it to its numbers:
 * everything in here fails quietly. A decay that ran on the calendar would greet somebody back
 * from a fortnight away with every workspace cold and an offer to remove the lot; a terminal left
 * printing that counted for as much as the user would make a forgotten `tail -f` the hottest thing
 * in the list.
 *
 * Heat is minutes of use, each worth a quarter less for every day of use since — plus a tenth as
 * much for minutes in which a workspace's terminals printed on their own, capped short of hot. So
 * an agent at work keeps its workspace from going cold, but only the user makes one hot.
 *
 * AGE IS COUNTED IN DAYS OF USE, NOT CALENDAR DAYS: today, and each day on which the user did
 * something in any workspace. A weekend or a holiday adds none, so the list comes back from one
 * looking as it was left, and "cold" means passed over while other things were being worked on —
 * which is the only sense in which it is a reason to remove anything.
 */

import type { ActivityDay, WorkspaceActivity, WorkspaceSort } from '@shared/types'

export type Temperature = 'hot' | 'warm' | 'cool' | 'cold'

/** What a day of use is worth against the one after it: halved in about two and a half. */
export const DAILY_DECAY = 0.75
/** A minute of a workspace's terminals printing is worth a tenth of a minute of the user's… */
export const OUTPUT_WEIGHT = 0.1
/** …and all of it together no more than this, which is warm and short of hot. */
export const OUTPUT_CEILING = 20
/** About an hour of use today, or a few hours spread over the last few days of use. */
export const HOT = 40
/** About ten minutes today. */
export const WARM = 8
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
export function heatOf(activity: WorkspaceActivity | undefined, clock: readonly string[]): number {
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
 * Hot, warm or cool by heat — or cold, which goes by recency alone: COLD_AFTER days of use with
 * nothing at all in it, however busy it once was. Cold is what the side bar offers to remove, and
 * "not touched in your last ten days of work" is a reason anybody can check, where "its score
 * dropped below eight" is not.
 *
 * No record at all is evidence of nothing, so it is cool rather than cold.
 */
export function temperatureOf(activity: WorkspaceActivity | undefined, clock: readonly string[]): Temperature {
  if (!activity) return 'cool'
  const newest = activity.days[0]?.day
  const latest = newest && newest > activity.since ? newest : activity.since
  if (ageOf(latest, clock) >= COLD_AFTER) return 'cold'
  const heat = heatOf(activity, clock)
  return heat >= HOT ? 'hot' : heat >= WARM ? 'warm' : 'cool'
}

/** When anything last happened in a workspace — the user, or its terminals — or null if nothing has. */
export function lastActiveAt(activity: WorkspaceActivity | undefined): number | null {
  const at = Math.max(activity?.usedAt ?? 0, activity?.outputAt ?? 0)
  return at > 0 ? at : null
}

/** What the side bar orders a workspace by. */
export interface Warmth {
  temperature: Temperature
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
  const aCold = a.temperature === 'cold'
  const bCold = b.temperature === 'cold'
  if (aCold !== bCold) return aCold ? 1 : -1
  if (!aCold && a.heat !== b.heat) return b.heat - a.heat
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
    recent: sorted.filter((w) => w.temperature !== 'cold').map((w) => w.id),
    cold: sorted.filter((w) => w.temperature === 'cold').map((w) => w.id)
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

/** How long ago, as short as the side bar has room for: `now`, `5m`, `3h`, `2d`, `3w`, `4mo`, `2y`. */
export function shortAgo(then: number, now: number): string {
  const minutes = Math.floor((now - then) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  if (days < 61) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

const UNITS: Record<string, string> = { m: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year' }

/** The same in words, for a tooltip: `just now`, `5 minutes ago`, `3 weeks ago`. */
export function longAgo(then: number, now: number): string {
  const short = shortAgo(then, now)
  if (short === 'now') return 'just now'
  const n = parseInt(short, 10)
  return `${n} ${UNITS[short.replace(/^\d+/, '')]}${n === 1 ? '' : 's'} ago`
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
