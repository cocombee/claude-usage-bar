import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit, SessionContextUsage } from 'claude-code'

import type { Usage, Window } from '../types'

// Order adopted from cocombee/codex-usage-bar:
//   Weekly → 5-hour → Token speed → Context
// One open row, no container around any figure: the four readings sit side by
// side with a thin divider between them. A remaining-quota track, yellow at ≤20%
// left, red at ≤10% (the figure takes the same colour), missing values shown as
// "—" (never a fabricated zero), and staged shortening of labels as the row
// narrows so it always stays one row — on the terminal one line, not three.
// Colors are the chat box's own theme keys (promptBorder, inactive, subtle),
// so the bar follows the person's theme and light/dark mode like the prompt.

const usage = atom({ plugin: 'usage-bar', key: 'usage' } as const, null)
const speed = atom({ plugin: 'usage-bar', key: 'speed' } as const, null)
const tick = atom({ plugin: 'usage-bar', key: 'tick' } as const, 0)

// ---- pure presentation rules (same policy as the original metrics.mjs) ----

export const clampPercent = (n: number) => Math.max(0, Math.min(100, n))
// What is left, from what is used rounded to a whole point the way the Claude
// app's own usage panel rounds it (Math.round): 1.5% used is "2% used" there and
// 98% left here, never 99%.
export const remainingPercent = (n: number | null | undefined) =>
  Number.isFinite(n) ? 100 - Math.round(clampPercent(n as number)) : null
export const percentText = (n: number | null | undefined) =>
  Number.isFinite(n) ? `${Math.round(n as number)}%` : '—'

// `withMinutes: false` stops the full form at hours ("15h", "2d 2h"): a week-long
// window counted to the minute only adds noise, so Weekly leaves them out.
export function resetText(resetsAtMs: number | null, now: number, compact = false, withMinutes = true) {
  if (resetsAtMs == null || !Number.isFinite(resetsAtMs)) return '—'
  const seconds = Math.ceil((resetsAtMs - now) / 1000)
  if (seconds <= 0) return 'Updating'
  const minutes = Math.ceil(seconds / 60)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (compact) return days ? `${days}d` : hours ? `${hours}h` : `${minutes}m`
  return days ? `${days}d ${hours}h` : hours ? (withMinutes ? `${hours}h ${mins}m` : `${hours}h`) : `${minutes}m`
}

export type Tone = 'normal' | 'warning' | 'low'
export function quotaTone(remaining: number | null): Tone {
  return remaining == null ? 'normal' : remaining <= 10 ? 'low' : remaining <= 20 ? 'warning' : 'normal'
}
// Context counts up, so its warning mirrors the quotas': 80% used is 20% left.
export function contextTone(used: number | null): Tone {
  return quotaTone(used == null ? null : 100 - Math.round(clampPercent(used)))
}

function pickWindow(limits: readonly SessionRateLimit[], kind: string): Window | null {
  const w = limits.find(l => l.kind === kind)
  return w && Number.isFinite(w.percentUsed) ? { percentUsed: w.percentUsed, resetsAt: w.resetsAt } : null
}

export function toUsage(limits: readonly SessionRateLimit[], context: SessionContextUsage): Usage {
  return {
    fiveHour: pickWindow(limits, 'five_hour'),
    weekly: pickWindow(limits, 'seven_day'),
    context: Number.isFinite(context?.percent) ? (context.percent as number) : null,
  }
}

// Remaining %, or null once the window's reset time has passed (stale reading).
function windowState(w: Window | null, now: number) {
  const resetsAt = w?.resetsAt ? Date.parse(w.resetsAt) : null
  const expired = resetsAt != null && Number.isFinite(resetsAt) && resetsAt <= now
  const remaining = !w || expired ? null : remainingPercent(w.percentUsed)
  return { remaining, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }
}

// Track: 3px, fully rounded; the text colour (yellow or red by tone) over the
// text colour at 10%.
export const TRACK_HEIGHT = 3
// The least cells a track takes for a size to count as fitting; it then grows
// into whatever the row has spare.
const TRACK_BASE = 2
// Drawings cannot name theme keys, so the tones are spelled out for them.
const TONE_HEX: Record<Tone, string | null> = { normal: null, warning: '#e3b341', low: '#e54d4d' }

// A desktop cell in points, and the share of a cell one character of the
// desktop's proportional text takes ("Ctx" measures 18pt, "8%" 16pt).
const CELL = 7.75
export const DESKTOP_TEXT = 0.85

// Cells either side of a divider: one terminal character, two desktop cells.
export const DIVIDER_GAP = { terminal: 1, desktop: 2 } as const
// Desktop divider: a 1px hairline in the text colour at 18%. The terminal draws
// │ in the prompt border's colour.
export const DIVIDER_HEIGHT = 12
export const DIVIDER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="${DIVIDER_HEIGHT}" viewBox="0 0 1 ${DIVIDER_HEIGHT}">` +
  `<style>.d{fill:#0b0b0b;opacity:.18}@media(prefers-color-scheme:dark){.d{fill:#eeeeee}}</style>` +
  `<rect class="d" width="1" height="${DIVIDER_HEIGHT}"/></svg>`

// Desktop edge spacers, so the first and last reading sit one divider gap from
// the band's edge. The band leaves 7pt itself; margins come only in whole cells,
// hence a blank drawing for the rest (with a clear rect: an empty one is dropped).
const BAND_SIDE = 7
export const SIDE_INSET = DIVIDER_GAP.desktop * CELL - BAND_SIDE
export const SIDE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE_INSET}" height="${TRACK_HEIGHT}" viewBox="0 0 ${SIDE_INSET} ${TRACK_HEIGHT}">` +
  `<rect width="${SIDE_INSET}" height="${TRACK_HEIGHT}" fill="#000" fill-opacity="0"/></svg>`
export const SIDE_CELLS = Math.ceil((2 * SIDE_INSET) / CELL)

export const FIGURE_SPACE = '\u2007'
// Desktop bolt, drawn rather than typed: the ⚡ emoji's side bearings set its ink
// 1.5pt further in than any other reading's text. Sized to the emoji (8 × 11pt).
export const BOLT_WIDTH = 8
export const BOLT_HEIGHT = 11
export const BOLT_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${BOLT_WIDTH}" height="${BOLT_HEIGHT}" viewBox="0 0 8 11">` +
  `<path fill="#e9a23b" d="M5.2 0 0 6.3h3.3L2.7 11 8 4.6H4.6z"/></svg>`

// Sized by percentages, not a viewBox, so it stretches while its ends stay round.
export function trackSvg(remaining: number | null, tone: Tone) {
  const r = TRACK_HEIGHT / 2
  const pct = remaining == null ? 0 : Math.round(clampPercent(remaining) * 10) / 10
  const fill = TONE_HEX[tone] ? `fill:${TONE_HEX[tone]}` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${TRACK_HEIGHT}">` +
    `<style>.b{fill:#0b0b0b;opacity:.1}.f{fill:#0b0b0b;${fill}}@media(prefers-color-scheme:dark){.b{fill:#eeeeee}.f{fill:#eeeeee;${fill}}}</style>` +
    `<clipPath id="c"><rect width="100%" height="${TRACK_HEIGHT}" rx="${r}"/></clipPath>` +
    `<g clip-path="url(#c)"><rect class="b" width="100%" height="${TRACK_HEIGHT}"/>` +
    (pct > 0 ? `<rect class="f" width="${pct}%" height="${TRACK_HEIGHT}"/>` : '') + `</g></svg>`
}

// Ring, drawn in place of a track from size M down on the desktop: 13px across,
// a 2px line filled clockwise from the top with what is left, toned as the track.
export const RING_SIZE = 13
export const RING_STROKE = 2
const RING_CELLS = RING_SIZE / CELL
export function ringSvg(remaining: number | null, tone: Tone) {
  const c = RING_SIZE / 2
  const r = (RING_SIZE - RING_STROKE) / 2
  const length = Math.round(2 * Math.PI * r * 100) / 100
  const arc = Math.round(((remaining == null ? 0 : clampPercent(remaining)) / 100) * length * 100) / 100
  const stroke = TONE_HEX[tone] ? `stroke:${TONE_HEX[tone]}` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RING_SIZE}" height="${RING_SIZE}" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}">` +
    `<style>.b{stroke:#0b0b0b;opacity:.1}.f{stroke:#0b0b0b;${stroke}}@media(prefers-color-scheme:dark){.b{stroke:#eeeeee}.f{stroke:#eeeeee;${stroke}}}</style>` +
    `<circle class="b" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${RING_STROKE}"/>` +
    (arc > 0 ? `<circle class="f" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${RING_STROKE}" stroke-linecap="round" stroke-dasharray="${arc} ${length}" transform="rotate(-90 ${c} ${c})"/>` : '') +
    `</svg>`
}

// ---- sizes ----

type Size = {
  name: string
  from: number // breakpoint in bar columns; 0 = wherever it fits
  labels: 'full' | 'short' | null
  meter: 'bar' | 'ring'
  countdown: 'full' | 'short' | null
  speed: 'token/s' | 'tok/s' | 't/s' | null
  context: 'Context' | 'Ctx' | null
}

// Widest first. A size is used from its breakpoint until a wider one takes over,
// and only where its content fits; otherwise the next one down is tried. The
// breakpoints were designed as desktop band widths and converted with
// floor((pt - 14) / CELL) - SIDE_CELLS: 642pt, 543pt, 459pt and 410pt. Wk / 5h
// outlast Context, as an unlabelled figure is the harder thing to read.
const SIZES: readonly Size[] = [
  { name: 'XXL', from: 78, labels: 'full', meter: 'bar', countdown: 'full', speed: 'token/s', context: 'Context' },
  { name: 'XL', from: 65, labels: 'short', meter: 'bar', countdown: 'full', speed: 'tok/s', context: 'Ctx' },
  { name: 'L', from: 54, labels: 'short', meter: 'bar', countdown: 'short', speed: 'tok/s', context: 'Ctx' },
  { name: 'M', from: 48, labels: 'short', meter: 'ring', countdown: null, speed: 't/s', context: 'Ctx' },
  { name: 'S', from: 0, labels: 'short', meter: 'ring', countdown: null, speed: null, context: 'Ctx' },
  { name: 'XS', from: 0, labels: 'short', meter: 'ring', countdown: null, speed: null, context: null },
  { name: 'XXS', from: 0, labels: null, meter: 'ring', countdown: null, speed: null, context: null },
]
export const LEVELS = SIZES.length

export type Layout = {
  name: string
  minColumns: number
  quotaLabels: boolean
  shortLabels: boolean
  ring: boolean // desktop only; the terminal draws tracks at every size
  reset: boolean
  compactReset: boolean
  speed: boolean
  speedUnit: string
  context: boolean
  contextLabel: string
}

export function layoutFor(level: number): Layout {
  const s = SIZES[Math.max(0, Math.min(LEVELS - 1, level))]!
  return {
    name: s.name,
    minColumns: s.from,
    quotaLabels: s.labels !== null,
    shortLabels: s.labels === 'short',
    ring: s.meter === 'ring',
    reset: s.countdown !== null,
    compactReset: s.countdown === 'short',
    speed: s.speed !== null,
    speedUnit: s.speed ?? '',
    context: s.context !== null,
    contextLabel: s.context ?? '',
  }
}

type Texts = { weekly: string[]; five: string[]; speed: string; context: string }

// The row's width at a layout, in cells, with tracks at their base: what the
// drawing below lays out. Readings carry no chrome; a divider is counted as a
// whole cell (the desktop's 1px hairline included) plus DIVIDER_GAP each side.
export function rowWidth(L: Layout, t: Texts, isTerminal: boolean) {
  const divider = 1 + 2 * DIVIDER_GAP[isTerminal ? 'terminal' : 'desktop']
  const gap = 1 // never 0: a terminal would run the texts together
  const k = isTerminal ? 1 : DESKTOP_TEXT
  const textWidth = (parts: string[]) => {
    const shown = parts.filter(Boolean)
    return Math.ceil(k * shown.reduce((sum, x) => sum + x.length, 0)) + gap * Math.max(0, shown.length - 1)
  }
  // label · meter · figure · countdown, a gap between each
  const quota = (label: string, value: string, reset: string) => {
    const meter = L.ring && !isTerminal ? RING_CELLS : TRACK_BASE
    return textWidth([label, value, L.reset ? reset : '']) + meter + gap
  }
  const vw = Math.max((t.weekly[0] ?? '—').length, (t.five[0] ?? '—').length)
  const rw = Math.max((t.weekly[1] ?? '').length, (t.five[1] ?? '').length)
  const wk = quota(!L.quotaLabels ? '' : L.shortLabels ? 'Wk' : 'Weekly', (t.weekly[0] ?? '—').padStart(vw), (t.weekly[1] ?? '').padEnd(rw))
  const fh = quota(!L.quotaLabels ? '' : L.shortLabels ? '5h' : '5-hour', (t.five[0] ?? '—').padStart(vw), (t.five[1] ?? '').padEnd(rw))
  const sp = L.speed ? textWidth(['⚡', t.speed, L.speedUnit]) : 0
  const cx = L.context ? textWidth([L.contextLabel, t.context]) : 0
  const readings = 2 + (L.speed ? 1 : 0) + (L.context ? 1 : 0)
  return wk + fh + sp + cx + divider * (readings - 1)
}

// The widest size whose breakpoint the row has reached and whose content fits.
export function fitLevel(columns: number, isTerminal: boolean, t: Texts) {
  for (let level = 0; level < LEVELS; level++) {
    const L = layoutFor(level)
    if (columns < L.minColumns) continue
    const texts = {
      weekly: [t.weekly[0] ?? '—', L.compactReset ? t.weekly[2] ?? '' : t.weekly[1] ?? ''],
      five: [t.five[0] ?? '—', L.compactReset ? t.five[2] ?? '' : t.five[1] ?? ''],
      speed: t.speed, context: t.context,
    }
    if (rowWidth(L, texts, isTerminal) <= columns) return level
  }
  return LEVELS - 1
}

// The last 5-hour and weekly reading any session saw, with when it was taken,
// kept in the plugin's own store: one JSON file every chat shares (see
// session.start below). The older key held the limits alone, with no time.
const LATEST_LIMITS = 'latestRateLimits'
const LAST_LIMITS = 'lastRateLimits'
// `live`: read from the usage panel's endpoint, not from a reply's headers.
type Reading = { at: number; limits: readonly SessionRateLimit[]; live?: boolean }
// How often a chat looks for a newer reading from another chat.
export const SYNC_EVERY = 5_000

// A crash while the store file is being written can leave it as a run of null
// bytes (seen on Windows after an unclean reboot). The engine then refuses every
// $.store call on it, get and set alike, so the saved reading never came back and
// every new chat sat at "—" until its first reply. Its error names the file; a
// store that is not JSON holds nothing worth keeping, so it is reset to an empty one.
const MALFORMED_STORE = /store file (.+?) is malformed \(/
export async function repairStore($: any, err: unknown) {
  const path = MALFORMED_STORE.exec(String((err as any)?.message ?? err))?.[1]
  if (!path) return false
  try { await $.fs.write(path, '{}\n'); return true } catch { return false }
}

async function savedReading($: any): Promise<Reading> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const v: any = await $.store.get(LATEST_LIMITS)
      if (v && Array.isArray(v.limits) && Number.isFinite(v.at)) return { at: v.at, limits: v.limits, live: v.live === true }
      const old = await $.store.get(LAST_LIMITS)
      return { at: 0, limits: Array.isArray(old) ? (old as SessionRateLimit[]) : [] }
    } catch (err) {
      if (attempt > 0 || !(await repairStore($, err))) break
    }
  }
  return { at: 0, limits: [] }
}

// A reading not kept is only a slower start next time; a store found broken is
// repaired and the reading written once more.
async function saveReading($: any, reading: Reading) {
  try { await $.store.set(LATEST_LIMITS, reading) } catch (err) {
    if (await repairStore($, err)) { try { await $.store.set(LATEST_LIMITS, reading) } catch { /* see above */ } }
  }
}
const sameLimits = (a: readonly SessionRateLimit[], b: readonly SessionRateLimit[]) =>
  JSON.stringify(a.map(l => [l.kind, l.percentUsed, l.resetsAt])) === JSON.stringify(b.map(l => [l.kind, l.percentUsed, l.resetsAt]))

// What a chat shows, held in a box its hooks share.
type Shown = { current: Reading; drawn?: readonly SessionRateLimit[] }

// Draws `limits`, keeping Context as it is; a no-op when that is what is on
// screen already.
async function draw($: any, box: Shown, limits: readonly SessionRateLimit[], context?: SessionContextUsage) {
  if (context === undefined && box.drawn && sameLimits(limits, box.drawn)) return
  box.drawn = limits
  await update($, usage, (u: any) => {
    const next = toUsage(limits, context ?? ({ window: 0 } as SessionContextUsage))
    return context === undefined ? { ...next, context: u?.context ?? null } : next
  })
}

// Two readings of one window: the same kind with reset times within a quarter
// hour (a reply's headers give the time to the minute, the usage panel's to
// the millisecond).
const sameWindow = (a: SessionRateLimit, b: SessionRateLimit) => {
  const ta = Date.parse(a.resetsAt ?? ''), tb = Date.parse(b.resetsAt ?? '')
  return a.kind === b.kind && Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) < 15 * 60_000
}

// A reply's headers carry usage as it stood when the request was let in, in
// whole points, so they run up to a point under the app's own panel. Within one
// window usage only grows: a header reading never pulls a figure back below the
// higher one already held. A new window (a later reset time) is taken as it is.
export function foldLimits(held: readonly SessionRateLimit[], incoming: readonly SessionRateLimit[]) {
  return incoming.map(l => {
    const prev = held.find(h => sameWindow(h, l))
    return prev && prev.percentUsed > l.percentUsed ? { ...l, percentUsed: prev.percentUsed } : l
  })
}

// Shows `limits` (keeping Context as it is) and, for a reading of this chat's
// own, saves it for the others. A live reading (the usage panel's own figure)
// replaces what is held; any other is folded into it.
async function adopt($: any, box: Shown, limits: readonly SessionRateLimit[], at: number, save: boolean, live = false) {
  if (!limits.length) return
  if (!live) limits = foldLimits(box.current.limits, limits)
  box.current = { at, limits, live }
  await draw($, box, limits)
  if (save) await saveReading($, { at, limits, live })
}

// A reading of this chat's own: shown, and shared with the other chats.
async function ownReading($: any, box: Shown) {
  try {
    const u = await $.session.usage()
    if (u.rateLimits.length) await adopt($, box, u.rateLimits, await $.clock.now(), true)
  } catch { /* the next reading lands it */ }
}

// ---- the live reading: the figure the Claude app's usage panel shows ----
// The account's usage, read from the same endpoint the app's panel and /usage
// read, with the session's own credential (the engine holds it; the mod sees
// only a handle). Unlike the headers it counts every chat and claude.ai, the
// reply just finished included, and is read on a clock, not only per reply.
export const LIVE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const LIVE_EVERY = 60_000
// After a refused or failed read, the next waits this long.
export const LIVE_BACKOFF = 5 * 60_000
// When any chat last read it, shared so several open chats read it once a minute
// between them; the others take the reading from the store on their sync tick.
const LIVE_AT = 'liveReadAt'

export function parseLive(text: string): SessionRateLimit[] {
  const body = JSON.parse(text)
  const out: SessionRateLimit[] = []
  for (const [key, kind] of [['five_hour', 'five_hour'], ['seven_day', 'seven_day']] as const) {
    const w = body?.[key]
    // `utilization` is 0–100, or null for a window with no reading: never 0%.
    const used = w?.utilization
    if (typeof used === 'number' && Number.isFinite(used)) {
      const resetsAt = typeof w.resets_at === 'string' && Number.isFinite(Date.parse(w.resets_at)) ? new Date(w.resets_at).toISOString() : undefined
      out.push({ kind, percentUsed: Math.round(used * 10) / 10, ...(resetsAt ? { resetsAt } : {}) })
    }
  }
  return out
}

type Live = { busy: boolean; waitUntil: number }

// Reads it unless any chat did within `gap`.
async function liveReading($: any, box: Shown, live: Live, gap = LIVE_EVERY - 5_000) {
  if (live.busy) return
  const now = await $.clock.now()
  if (now < live.waitUntil) return
  live.busy = true
  try {
    let last = 0
    try { last = Number(await $.store.get(LIVE_AT)) || 0 } catch { /* read anyway */ }
    if (now - last < gap) return
    const auth = await $.session.authorize()
    if (!auth?.handle) { live.waitUntil = now + LIVE_BACKOFF; return }
    try { await $.store.set(LIVE_AT, now) } catch { /* only costs a second read */ }
    const res = await $.http.fetch(LIVE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
    })
    const limits = res.ok ? parseLive(res.text) : []
    if (!limits.length) { live.waitUntil = now + LIVE_BACKOFF; return }
    await adopt($, box, limits, await $.clock.now(), true, true)
  } catch {
    live.waitUntil = now + LIVE_BACKOFF // the headers' reading stands meanwhile
  } finally {
    live.busy = false
  }
}

export const register: Register = on => {
  // ---- wiring: Claude's own usage figures ----
  let samples: { output: number; seconds: number }[] = []
  let activeTurn: string | null = null
  // The model's context window in tokens, from the last usage reading; the
  // per-response context fill below is measured against it.
  let contextWindow: number | null = null
  // The limits this chat shows and when they were read, by this chat or another.
  // Every chat writes its newest reading to the shared store and every chat looks
  // there on its clock tick, so a reading one chat gets (a reply, or the limits
  // Anthropic reset early) reaches the others within the tick, not at their own
  // next reply.
  const box: Shown = { current: { at: 0, limits: [] } }
  const live: Live = { busy: false, waitUntil: 0 }

  // The 5-hour and weekly limits arrive with the API's reply to a request, so a
  // new chat has none until its first message and the bar sat at "—" till then.
  // They are the account's, not the chat's, so the last reading any session saw
  // still holds in a new one until its own reset time — past which windowState
  // shows "—" rather than a stale figure. It is kept in the plugin's own store.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const u = await $.session.usage()
    if (Number.isFinite(u.context?.window)) contextWindow = u.context.window
    // This chat's own reading wins; until it has one, the newest one saved.
    const saved = await savedReading($)
    const own = u.rateLimits.length ? { at: await $.clock.now(), limits: foldLimits(saved.limits, u.rateLimits) } : saved
    box.current = own
    await draw($, box, own.limits, u.context)
    if (u.rateLimits.length) await saveReading($, own)
    // Pick up a newer reading another chat saved, within a few seconds: a read
    // of one small file, and a redraw only when the figures moved.
    $.clock.every(SYNC_EVERY, () => void (async () => {
      const latest = await savedReading($)
      if (latest.at > box.current.at) await adopt($, box, latest.limits, latest.at, false, latest.live)
    })())
    // The usage panel's own figure, now and then once a minute among all chats.
    void liveReading($, box, live)
    $.clock.every(15_000, () => void liveReading($, box, live))
    // Keep reset countdowns moving between API responses.
    $.clock.every(30_000, () => void update($, tick, t => t + 1))
    return result
  })

  // Fires whenever the 5-hour/weekly windows or context fill move.
  on('session.measure', async ($, e, next) => {
    if (Number.isFinite(e.context?.window)) contextWindow = e.context.window
    if (e.rateLimits.length) {
      const at = await $.clock.now()
      const limits = foldLimits(box.current.limits, e.rateLimits)
      box.current = { at, limits }
      await draw($, box, limits, e.context)
      await saveReading($, box.current)
    } else {
      // A measurement with no limits in it says only that context moved, as a new
      // chat's does before its first reply: it is not a reading of none. Taking
      // it as one wiped the saved limits the moment the chat opened, leaving dark
      // tracks and dashes. The last known limits stand; their reset times still
      // turn a stale one into "—".
      const saved = await savedReading($)
      const latest = saved.at >= box.current.at ? saved : box.current
      box.current = latest
      await draw($, box, latest.limits, e.context)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // Older builds raise turn.start for subagents too, with their agentId.
    if ((e as { agentId?: string }).agentId === undefined) {
      activeTurn = e.turnId
      samples = []
      await update($, speed, () => null)
    }
    return next(e)
  })

  // Token speed: output tokens / model-response seconds over up to 10 responses
  // in the running turn. Each step's timing covers the model's wait and
  // generation only, so tool execution is excluded by construction.
  //
  // Context: session.measure comes only when a turn ends (or a quota moves), so
  // through a long turn Context sat at the figure the turn began with: 10% while
  // the chat was really at 20%. Each response of the main chat reports what it
  // was answered over, so its fill is read here, as soon as it is known.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const started = await $.clock.now()
    // The request's fill is known once its response starts streaming, well
    // before the response ends: reading it at the first piece, not only at the
    // end, keeps Context from trailing the app's own figure through a long reply.
    const stream = next(e)
    let first = true
    let step = await stream.next()
    while (!step.done) {
      yield step.value
      if (first) {
        first = false
        try {
          const live = (await $.session.usage()).context
          if (Number.isFinite(live?.window)) contextWindow = live.window
          if (Number.isFinite(live?.percent)) {
            await update($, usage, u => ({ fiveHour: u?.fiveHour ?? null, weekly: u?.weekly ?? null, context: live.percent as number }))
          }
        } catch { /* the end-of-response reading below still lands */ }
        // The limits this request was answered under, as early as they are known.
        await ownReading($, box)
      }
      step = await stream.next()
    }
    const result = step.value
    const seconds = ((await $.clock.now()) - started) / 1000
    const input = result.usage
      ? (result.usage.input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0) + (result.usage.cache_read_input_tokens ?? 0)
      : 0
    if (input > 0 && contextWindow != null && contextWindow > 0) {
      const percent = Math.round((input / contextWindow) * 100)
      await update($, usage, u => ({ fiveHour: u?.fiveHour ?? null, weekly: u?.weekly ?? null, context: percent }))
    }
    await ownReading($, box)
    if (e.turnId !== activeTurn) return result
    const output = result.usage?.output_tokens ?? 0
    if (e.turnId === activeTurn && output > 0 && seconds >= 0.25) {
      samples = [...samples, { output, seconds }].slice(-10)
      const total = samples.reduce((s, x) => s + x.output, 0)
      const secs = samples.reduce((s, x) => s + x.seconds, 0)
      const rate = secs > 0 ? Math.round(total / secs) : null
      await update($, speed, () => (rate != null && rate > 0 && rate < 1e6 ? rate : null))
    }
    return result
  })

  // Clears to "—" when the turn finishes, as the original did.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // What the turn just used, as the panel counts it.
    if ((e as { agentId?: string }).agentId === undefined) void liveReading($, box, live, 10_000)
    if (e.turnId === activeTurn) {
      activeTurn = null
      samples = []
      await update($, speed, () => null)
    }
    return result
  })

  // ---- drawing ----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey holds the band: it is drawn as the engine draws it, with the bar
    // kept above it rather than giving way, so the figures never vanish while a
    // question waits.
    const survey = e.props.hasSurvey ? await next(e) : null
    const { Box, Text, Svg } = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Svg?: any }

    await read($, tick)
    // Until this chat's hooks have drawn a reading, the saved one is drawn straight
    // from the store: the figures are already there, and waiting for the hooks left
    // a new chat's quota readings at "—" for the first sync tick (5s).
    const held = await read($, usage)
    const saved = held?.fiveHour || held?.weekly ? null : (await savedReading($)).limits
    const u = saved?.length ? { ...toUsage(saved, { window: 0 } as SessionContextUsage), context: held?.context ?? null } : held
    const tps = await read($, speed)
    const now = await $.clock.now()
    const isTerminal = e.surface === 'terminal'
    const desktop = !isTerminal && !!Svg
    const columns = e.props.bodyColumns - (desktop ? SIDE_CELLS : 0)

    const weekly = windowState(u?.weekly ?? null, now)
    const five = windowState(u?.fiveHour ?? null, now)
    const context = u?.context ?? null
    const speedValue = tps == null ? '—' : `~${tps}`

    const level = fitLevel(columns, isTerminal, {
      weekly: [percentText(weekly.remaining), resetText(weekly.resetsAt, now, false, false), resetText(weekly.resetsAt, now, true)],
      five: [percentText(five.remaining), resetText(five.resetsAt, now), resetText(five.resetsAt, now, true)],
      speed: speedValue,
      context: percentText(context),
    })
    const L = layoutFor(level)

    const quotaParts = (label: string, short: string, w: ReturnType<typeof windowState>, withMinutes: boolean) => ({
      label: L.quotaLabels ? (L.shortLabels ? short : label) : '',
      value: percentText(w.remaining),
      reset: L.reset ? resetText(w.resetsAt, now, L.compactReset, withMinutes) : null,
    })
    const wk = quotaParts('Weekly', 'Wk', weekly, false)
    const fh = quotaParts('5-hour', '5h', five, true)
    // Pad Weekly's and 5-hour's texts to equal widths with figure spaces, so the
    // terminal's two tracks come out the same length.
    const valueWidth = Math.max(wk.value.length, fh.value.length)
    wk.value = wk.value.padStart(valueWidth, FIGURE_SPACE)
    fh.value = fh.value.padStart(valueWidth, FIGURE_SPACE)
    if (wk.reset != null && fh.reset != null) {
      const resetWidth = Math.max(wk.reset.length, fh.reset.length)
      wk.reset = wk.reset.padEnd(resetWidth, FIGURE_SPACE)
      fh.reset = fh.reset.padEnd(resetWidth, FIGURE_SPACE)
    }

    // Terminal tracks take all the spare cells between them, so no reading is
    // left with a wider gap before its divider than the rest. An odd cell goes to
    // Weekly; one is held back for the ⚡, which the terminal draws two cells wide.
    const natural = rowWidth(L, {
      weekly: [percentText(weekly.remaining), wk.reset ?? ''], five: [percentText(five.remaining), fh.reset ?? ''], speed: speedValue, context: percentText(context),
    }, isTerminal)
    const spare = Math.max(0, columns - natural - (L.speed ? 1 : 0))
    const trackWidth = TRACK_BASE + Math.floor(spare / 2)
    const oddCell = spare % 2

    const toneColor = (t: Tone) => (t === 'low' ? 'error' : t === 'warning' ? 'warning' : 'text')

    // A quota's meter. Desktop: a ring, or a 3px track that takes what its reading
    // has spare. Terminal: a heavy line for what is left over a light one.
    const meter = (remaining: number | null, extra = 0) => {
      const tone = quotaTone(remaining)
      const alt = remaining == null ? 'unavailable' : `${Math.round(remaining)}% left`
      if (desktop && L.ring) {
        return (
          <Box flexShrink={0} alignSelf="center">
            <Svg source={ringSvg(remaining, tone)} alt={alt} width={RING_SIZE} height={RING_SIZE} />
          </Box>
        )
      }
      if (desktop) {
        return (
          <Box flexDirection="column" justifyContent="center" alignSelf="center" flexGrow={1} flexShrink={1} minWidth={2}>
            <Svg source={trackSvg(remaining, tone)} alt={alt} height={TRACK_HEIGHT} />
          </Box>
        )
      }
      const width = trackWidth + extra
      const filled = remaining == null ? 0 : Math.round((remaining / 100) * width)
      return (
        <Text>
          <Text color={toneColor(tone)}>{'━'.repeat(filled)}</Text>
          <Text color="subtle">{'─'.repeat(width - filled)}</Text>
        </Text>
      )
    }

    // A reading: its parts one cell apart, with no border, padding or fill. Quota
    // readings with tracks share the row's spare width; the rest hug their content.
    const reading = (key: string, grow: boolean, children: any[]) => (
      <Box key={key} flexDirection="row" columnGap={1} alignItems="center" flexGrow={grow ? 1 : 0} flexShrink={grow ? 1 : 0} minWidth={0} overflow="hidden">
        {children}
      </Box>
    )
    const divider = (key: string) => (
      <Box key={key} flexShrink={0} alignSelf="center">
        {desktop
          ? <Svg source={DIVIDER_SVG} alt="divider" width={1} height={DIVIDER_HEIGHT} />
          : <Text color="promptBorder">│</Text>}
      </Box>
    )
    const sideSpacer = (key: string) => (desktop
      ? <Box key={key} flexShrink={0}><Svg source={SIDE_SVG} alt="spacing" width={SIDE_INSET} height={TRACK_HEIGHT} /></Box>
      : null)

    // The desktop's text is proportional, so the figure-space padding comes off
    // there. Each text part holds its width: a bare Text shrinks before a track
    // does and wraps ("15h 0m" broke onto two lines).
    const shown = (t: string) => (isTerminal ? t : t.split(FIGURE_SPACE).join(''))
    const part = (child: any) => <Box flexShrink={0}>{child}</Box>
    const figure = (text: string, tone: Tone) =>
      part(<Text color={tone === 'normal' ? undefined : toneColor(tone)}>{shown(text)}</Text>)
    const quotaReading = (key: string, p: typeof wk, w: ReturnType<typeof windowState>, extra = 0) =>
      reading(key, !(desktop && L.ring), [
        ...(p.label ? [part(<Text color="inactive">{shown(p.label)}</Text>)] : []),
        meter(w.remaining, extra),
        figure(p.value, quotaTone(w.remaining)),
        ...(p.reset == null ? [] : [part(<Text color="inactive">{shown(p.reset)}</Text>)]),
      ])

    const readings = [
      quotaReading('weekly', wk, weekly, oddCell),
      quotaReading('five-hour', fh, five),
      L.speed
        ? reading('speed', false, [
            desktop
              ? <Svg source={BOLT_SVG} alt="token speed" width={BOLT_WIDTH} height={BOLT_HEIGHT} />
              : <Text color="inactive">⚡</Text>,
            <Text>{speedValue}</Text>,
            <Text color="inactive">{L.speedUnit}</Text>,
          ])
        : null,
      L.context
        ? reading('context', false, [
            <Text color="inactive">{L.contextLabel}</Text>,
            figure(percentText(context), contextTone(context)),
          ])
        : null,
    ].filter(Boolean)

    // Readings with a divider between each two, DIVIDER_GAP either side of it;
    // the desktop's side spacers give the ends the same space. Rings don't
    // stretch, so where they are drawn the spare room is spread evenly instead.
    // Spacing is in plain cells: older Claude Code builds refuse named steps.
    const bar = (
      <Box flexDirection="row" flexWrap="nowrap" overflow="hidden">
        {sideSpacer('left')}
        <Box flexDirection="row" columnGap={DIVIDER_GAP[isTerminal ? 'terminal' : 'desktop']} alignItems="center" justifyContent={desktop && L.ring ? 'space-evenly' : 'flex-start'} flexWrap="nowrap" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          {readings.flatMap((r, i) => (i === 0 ? [r] : [divider(`divider-${i}`), r]))}
        </Box>
        {sideSpacer('right')}
      </Box>
    )
    return survey ? <Box flexDirection="column">{bar}{survey}</Box> : bar
  })
}
