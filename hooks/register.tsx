import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit, SessionContextUsage } from 'claude-code'

import type { Usage, Window } from '../types'

// Design adopted from cocombee/codex-usage-bar:
//   Weekly → 5-hour (in the Files-changed slot) → Token speed → Context
// Rounded pills, a remaining-quota track, yellow at ≤20% left, red at ≤10%,
// missing values shown as "—" (never a fabricated zero), and staged shortening
// of labels as the row narrows so it always stays one row.
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

// The track: 4.5px tall (the user's pick over the original's 5.6px), fully rounded; fill = text color,
// warning #e3b341, low #e54d4d; the empty part is the text color at 10%.
export const TRACK_HEIGHT = 4.5
// Inner left/right padding of every pill, in cells (desktop draws its own size).
export const PILL_PADDING = 2
// Cells between two pills, at every size.
export const PILL_GAP = 1
// How much of a cell one character of text takes on the desktop, whose font is
// proportional: measured off the desktop at about 7.75pt a cell, "Ctx" is 18pt
// and "8%" 16pt.
export const DESKTOP_TEXT = 0.85

// Desktop only: what the row adds at its left and right, in points, so the gap
// from the band's edge to the pills there equals the band's gap above them.
// Measured off the desktop at 2x: 18-19px above the pills, 14px at their side
// with no inset, so about 2.5pt short a side. A cell (7.75pt) was far too much,
// and a margin comes only in whole cells, so it is a blank drawing this wide
// (CSS pixels, as Svg sizes are). An empty drawing with a blank alt was dropped
// by the desktop, so it holds a clear rect and says what it is.
export const SIDE_INSET = 2.5
export const SIDE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE_INSET}" height="${TRACK_HEIGHT}" viewBox="0 0 ${SIDE_INSET} ${TRACK_HEIGHT}">` +
  `<rect width="${SIDE_INSET}" height="${TRACK_HEIGHT}" fill="#000" fill-opacity="0"/></svg>`

export const FIGURE_SPACE = '\u2007'
// The token-speed bolt on the desktop, drawn rather than typed. The ⚡ character
// is an emoji there, and an emoji carries side bearings of its own: its ink began
// 3px (1.5pt) further in than any other pill's text, so that pill's left padding
// looked wider than its right. A drawing has no bearings, so its ink starts
// exactly at the padding. Sized and coloured to the emoji it replaces (8 × 11pt).
export const BOLT_WIDTH = 8
export const BOLT_HEIGHT = 11
export const BOLT_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${BOLT_WIDTH}" height="${BOLT_HEIGHT}" viewBox="0 0 8 11">` +
  `<path fill="#e9a23b" d="M5.2 0 0 6.3h3.3L2.7 11 8 4.6H4.6z"/></svg>`

// Sized by percentages, not a viewBox, so it stretches to its slot while the
// rounded ends stay round.
export function trackSvg(remaining: number | null, tone: Tone) {
  const r = TRACK_HEIGHT / 2
  const pct = remaining == null ? 0 : Math.round(clampPercent(remaining) * 10) / 10
  const fill = tone === 'low' ? 'fill:#e54d4d' : tone === 'warning' ? 'fill:#e3b341' : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${TRACK_HEIGHT}">` +
    `<style>.b{fill:#0b0b0b;opacity:.1}.f{fill:#0b0b0b;${fill}}@media(prefers-color-scheme:dark){.b{fill:#eeeeee}.f{fill:#eeeeee;${fill}}}</style>` +
    `<clipPath id="c"><rect width="100%" height="${TRACK_HEIGHT}" rx="${r}"/></clipPath>` +
    `<g clip-path="url(#c)"><rect class="b" width="100%" height="${TRACK_HEIGHT}"/>` +
    (pct > 0 ? `<rect class="f" width="${pct}%" height="${TRACK_HEIGHT}"/>` : '') + `</g></svg>`
}

// ---- the original's fit levels (responsive.mjs fitBar), in cells ----
export type Layout = {
  stage: 0 | 1 | 2 | 3
  tight: boolean        // tighter pill spacing (original: gap 6px, then 3px)
  reset: boolean        // reset countdown shown at all (smallest drops it)
  compactReset: boolean // "2d" vs "2d 2h"
  compactLabels: boolean// Wk / 5h / tok/s / Ctx
  quotaLabels: boolean  // the Wk / 5h labels at all (the two narrowest drop them)
  context: boolean      // the Context pill at all (only the narrowest drops it)
  bolt: boolean
  speed: boolean        // token-speed pill shown (smallest drops it)
  trackBase: number     // cells a track needs at the least; it grows past that
}

// Five sizes, each giving up one more thing as the chat narrows:
//   0 biggest   everything
//   1 small     short labels (Wk, 5h, tok/s, Ctx), one countdown unit, ⚡ kept
//   2 smaller   no reset times and no token-speed pill
//   3 narrow    no Wk / 5h labels, so each quota pill is a track and a figure
//   4 smallest  no Context pill, so both quota figures still fit whole
// The labels have a step of their own: tied to the reset times, they went while
// there was still plenty of room for them.
export const LEVELS = 5
export function layoutFor(level: number): Layout {
  const stage = (level === 0 ? 0 : level === 1 ? 2 : 3) as Layout['stage']
  return {
    stage,
    tight: level >= 1,
    reset: level < 2,
    compactReset: level >= 1,
    compactLabels: level >= 1,
    quotaLabels: level < 3,
    context: level < 4,
    bolt: true, // the ⚡ stays wherever token speed shows
    speed: level < 2,
    // The least a track may be for a size to count as fitting. It grows into
    // whatever the row has spare, so it need not reserve a comfortable length:
    // reserving 12 cells at the biggest size asked for some 20 more columns than
    // the row needs, and the biggest size never showed in a real chat window.
    trackBase: 2,
  }
}

// The original's width thresholds (620 and 490 CSS px of composer) as cells
// at ~8px each: below them a size is the most the row may use.
export function minimumLevel(columns: number) {
  return columns <= 61 ? 2 : columns <= 77 ? 1 : 0
}

type Texts = { weekly: string[]; five: string[]; speed: string; context: string }

// Width of the row at a layout, in cells, tracks at their base — what the drawing
// below lays out. Measured on the desktop, a cell is about 7.75pt and a pill's
// border and padding are 15pt a side: its two padding cells, the hairline border
// taking none, where the terminal's takes a cell each side. Text there is
// proportional and narrower than its cells (DESKTOP_TEXT). Counting 7 cells of
// chrome a pill made sizes drop well before they ran out of room.
export function rowWidth(L: Layout, t: { weekly: string[]; five: string[]; speed: string; context: string }, isTerminal: boolean) {
  const chrome = (isTerminal ? 2 : 0) + PILL_PADDING * 2
  const gap = 1 // never 0: a terminal would run the texts together
  const k = isTerminal ? 1 : DESKTOP_TEXT
  const textPill = (parts: string[]) => {
    const shown = parts.filter(Boolean)
    return chrome + Math.ceil(k * shown.reduce((s, x) => s + x.length, 0)) + gap * Math.max(0, shown.length - 1)
  }
  // label · track · figure · countdown, a gap between each; the track is counted
  // at its base apart from the text, which on the desktop is narrower than cells
  const quota = (label: string, value: string, reset: string) => {
    const texts = [label, value, L.reset ? reset : ''].filter(Boolean)
    return chrome + Math.ceil(k * texts.reduce((a, x) => a + x.length, 0)) + L.trackBase + gap * texts.length
  }
  const vw = Math.max((t.weekly[0] ?? '—').length, (t.five[0] ?? '—').length)
  const rw = Math.max((t.weekly[1] ?? '').length, (t.five[1] ?? '').length)
  const wk = quota(!L.quotaLabels ? '' : L.compactLabels ? 'Wk' : 'Weekly', (t.weekly[0] ?? '—').padStart(vw), (t.weekly[1] ?? '').padEnd(rw))
  const fh = quota(!L.quotaLabels ? '' : L.compactLabels ? '5h' : '5-hour', (t.five[0] ?? '—').padStart(vw), (t.five[1] ?? '').padEnd(rw))
  const sp = L.speed ? textPill([L.bolt ? '⚡' : '', t.speed, L.compactLabels ? 'tok/s' : 'token/s']) : 0
  const cx = L.context ? textPill([L.compactLabels ? 'Ctx' : 'Context', t.context]) : 0
  const pills = 2 + (L.speed ? 1 : 0) + (L.context ? 1 : 0)
  return wk + fh + sp + cx + PILL_GAP * (pills - 1)
}

export function fitLevel(columns: number, isTerminal: boolean, t: Texts) {
  for (let level = minimumLevel(columns); level < LEVELS; level++) {
    const L = layoutFor(level)
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
type Reading = { at: number; limits: readonly SessionRateLimit[] }
async function savedReading($: any): Promise<Reading> {
  try {
    const v: any = await $.store.get(LATEST_LIMITS)
    if (v && Array.isArray(v.limits) && Number.isFinite(v.at)) return { at: v.at, limits: v.limits }
    const old = await $.store.get(LAST_LIMITS)
    return { at: 0, limits: Array.isArray(old) ? (old as SessionRateLimit[]) : [] }
  } catch { return { at: 0, limits: [] } }
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

// Shows `limits` (keeping Context as it is) and, for a reading of this chat's
// own, saves it for the others.
async function adopt($: any, box: Shown, limits: readonly SessionRateLimit[], at: number, save: boolean) {
  if (!limits.length) return
  box.current = { at, limits }
  await draw($, box, limits)
  if (save) {
    try { await $.store.set(LATEST_LIMITS, { at, limits }) } catch { /* a reading not kept is only a slower start next time */ }
  }
}

// A reading of this chat's own: shown, and shared with the other chats.
async function ownReading($: any, box: Shown) {
  try {
    const u = await $.session.usage()
    if (u.rateLimits.length) await adopt($, box, u.rateLimits, await $.clock.now(), true)
  } catch { /* the next reading lands it */ }
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
    const own = u.rateLimits.length ? { at: await $.clock.now(), limits: u.rateLimits } : saved
    box.current = own
    await draw($, box, own.limits, u.context)
    if (u.rateLimits.length) {
      try { await $.store.set(LATEST_LIMITS, own) } catch { /* see adopt */ }
    }
    // Keep reset countdowns moving between API responses, and pick up a newer
    // reading another chat saved meanwhile.
    $.clock.every(30_000, () => void (async () => {
      const latest = await savedReading($)
      if (latest.at > box.current.at) await adopt($, box, latest.limits, latest.at, false)
      await update($, tick, t => t + 1)
    })())
    return result
  })

  // Fires whenever the 5-hour/weekly windows or context fill move.
  on('session.measure', async ($, e, next) => {
    if (Number.isFinite(e.context?.window)) contextWindow = e.context.window
    if (e.rateLimits.length) {
      const at = await $.clock.now()
      box.current = { at, limits: e.rateLimits }
      await draw($, box, e.rateLimits, e.context)
      try { await $.store.set(LATEST_LIMITS, box.current) } catch { /* a reading not kept is only a slower start next time */ }
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
    if (e.agentId === undefined) {
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
    const u = await read($, usage)
    const tps = await read($, speed)
    const now = await $.clock.now()
    // No inset of the row's own: the band's own gap above the pills is the gap
    // at their left and right too (see the row below).
    const INSET = 0
    const columns = e.props.bodyColumns - INSET * 2

    const weekly = windowState(u?.weekly ?? null, now)
    const five = windowState(u?.fiveHour ?? null, now)
    const context = u?.context ?? null
    const speedValue = tps == null ? '—' : `~${tps}`

    // Levels are tried in order and the fullest that fits is kept. Three sizes:
    //   biggest  everything
    // The remaining percentage never carries the word "left".
    //   small    short labels (Wk, 5h, tok/s, Ctx), one countdown unit, ⚡ kept
    //   smallest the reset times, the token-speed pill and the Wk / 5h labels go,
    //            leaving a track and a figure in each quota pill
    const isTerminal = e.surface === 'terminal'
    const level = fitLevel(columns, isTerminal, {
      weekly: [percentText(weekly.remaining), resetText(weekly.resetsAt, now, false, false), resetText(weekly.resetsAt, now, true)],
      five: [percentText(five.remaining), resetText(five.resetsAt, now), resetText(five.resetsAt, now, true)],
      speed: speedValue,
      context: percentText(context),
    })
    const L = layoutFor(level)

    const quotaParts = (label: string, short: string, w: ReturnType<typeof windowState>, withMinutes: boolean) => ({
      label: L.quotaLabels ? (L.compactLabels ? short : label) : '',
      value: percentText(w.remaining),
      reset: L.reset ? resetText(w.resetsAt, now, L.compactReset, withMinutes) : null,
    })
    const wk = quotaParts('Weekly', 'Wk', weekly, false)
    const fh = quotaParts('5-hour', '5h', five, true)
    // Same tracks for Weekly and 5-hour: their texts are padded to equal widths
    // (figure spaces, as wide as a tabular digit), so with equal pills the
    // tracks come out the same length at every size.
    const padTo = (a: string, b: string) => Math.max(a.length, b.length)
    const valueWidth = padTo(wk.value, fh.value)
    wk.value = wk.value.padStart(valueWidth, FIGURE_SPACE)
    fh.value = fh.value.padStart(valueWidth, FIGURE_SPACE)
    if (wk.reset != null && fh.reset != null) {
      const resetWidth = padTo(wk.reset, fh.reset)
      wk.reset = wk.reset.padEnd(resetWidth, FIGURE_SPACE)
      fh.reset = fh.reset.padEnd(resetWidth, FIGURE_SPACE)
    }
    const speedUnit = L.compactLabels ? 'tok/s' : 'token/s'
    const showBolt = L.bolt
    const ctxLabel = L.compactLabels ? 'Ctx' : 'Context'
    const sideSpacer = (key: string) => (!isTerminal && Svg
      ? <Box key={key} flexShrink={0}><Svg source={SIDE_SVG} alt="spacing" width={SIDE_INSET} height={TRACK_HEIGHT} /></Box>
      : null)

    // Terminal track: the original's base (100px ≈ 12 cells at full, 16px ≈ 2
    // cells after), plus 70% of the spare cells shared by the two tracks.
    const natural = rowWidth(L, {
      weekly: [percentText(weekly.remaining), wk.reset ?? ''], five: [percentText(five.remaining), fh.reset ?? ''], speed: speedValue, context: percentText(context),
    }, e.surface === 'terminal')
    const trackWidth = L.trackBase + Math.max(0, Math.floor(((columns - natural) * 0.7) / 2))

    const fillColor = (t: Tone) => (t === 'low' ? 'error' : t === 'warning' ? 'warning' : 'text')

    // Desktop: the Codex track, a 4.5px fully rounded bar (.cu-track's shape),
    // filled with the text color, yellow/red by tone, its rest the text color at 10%.
    // Terminal: a line of cells, the nearest a character grid can draw.
    const track = (remaining: number | null) => {
      const tone = quotaTone(remaining)
      if (e.surface !== 'terminal' && Svg) {
        // Centered, never stretched to the row's height: the bar stays 4.5px.
        return (
          // The track takes what its pill has left. Both quota pills are the same
          // width and hold same-size text slots, so both tracks are always the same
          // length, growing and shrinking together; nothing is fixed, nothing overflows.
          <Box flexDirection="column" justifyContent="center" alignSelf="center" flexGrow={1} flexShrink={1} minWidth={2}>
            <Svg source={trackSvg(remaining, tone)} alt={remaining == null ? 'unavailable' : `${Math.round(remaining)}% left`} height={TRACK_HEIGHT} />
          </Box>
        )
      }
      const filled = remaining == null ? 0 : Math.round((remaining / 100) * trackWidth)
      return (
        <Text>
          <Text color={fillColor(tone)}>{'─'.repeat(filled)}</Text>
          <Text color="subtle">{'─'.repeat(trackWidth - filled)}</Text>
        </Text>
      )
    }

    // Every pill keeps the same explicit left and right padding at every size.
    // The two quota pills share the row's spare width equally (grow 1 each) and
    // give it back equally when it is short; the others hug their content.
    const pill = (key: string, grow: number, children: any[]) => (
      <Box key={key} borderStyle="round" borderColor="promptBorder" paddingX={PILL_PADDING} columnGap={1} alignItems="center" flexGrow={grow} justifyContent="flex-start" flexShrink={grow > 0 ? 1 : 0} minWidth={0} overflow="hidden">
        {children}
      </Box>
    )

    // Inside a pill the parts sit side by side with the pill's columnGap between
    // them, one cell (about 7.75pt) and nothing more: the second padding, after
    // the pill's own padding at its two ends. Each label, figure and countdown used
    // to sit in a slot as wide as the longer of the two pills' texts, so "5-hour"
    // in a slot sized for "Weekly", or "2h" in one sized for "15h", left its spare
    // room inside the gap: from the "y" of Weekly to the track was 35px where the
    // gap is 14px. Without the slots the gaps are even; the two tracks can differ
    // by a few points instead, since Weekly is a little wider than 5-hour. The
    // terminal keeps its figure-space padding, whose cells hold its tracks equal.
    const fit = (t: string) => (isTerminal ? t : t.replace(/\u2007/g, ''))
    // Each text part is held at its own width (no width given, so it hugs the
    // text and leaves no slack in the gap). A bare Text in a pill that is short of
    // room shrinks before the track does and wraps: "15h 0m" broke onto two lines
    // and the pill doubled in height while its track still had room to spare.
    const part = (child: any) => <Box flexShrink={0}>{child}</Box>
    const quotaPill = (key: string, p: typeof wk, w: ReturnType<typeof windowState>) =>
      pill(key, 1, [
        ...(p.label ? [part(<Text color="inactive">{fit(p.label)}</Text>)] : []),
        track(w.remaining),
        part(<Text>{fit(p.value)}</Text>),
        ...(p.reset == null ? [] : [part(<Text color="inactive">{fit(p.reset)}</Text>)]),
      ])

    const bar = (
      // The gap from the band's edge to the pills is the same at the left and right
      // as above them: on the desktop a blank SIDE_INSET-wide drawing at each end
      // makes up the difference (a whole cell was too much, none too little). The
      // pills sit in an inner row so PILL_GAP falls only between pills, never
      // between a pill and a spacer. Spacing is in plain cells (older Claude Code
      // builds refuse named steps).
      // Nothing here sets a height or a font size: each pill stays one text row
      // in the app's own type, exactly as before.
      <Box flexDirection="row" flexWrap="nowrap" marginX={INSET} marginY={0} overflow="hidden">
      {sideSpacer('left')}
      <Box flexDirection="row" columnGap={PILL_GAP} flexWrap="nowrap" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        {quotaPill('weekly', wk, weekly)}
        {quotaPill('five-hour', fh, five)}
        {L.speed
          ? pill('speed', 0, [
              ...(showBolt
                ? [!isTerminal && Svg
                    ? <Svg source={BOLT_SVG} alt="token speed" width={BOLT_WIDTH} height={BOLT_HEIGHT} />
                    : <Text color="inactive">⚡</Text>]
                : []),
              <Text>{speedValue}</Text>,
              <Text color="inactive">{speedUnit}</Text>,
            ])
          : null}
        {L.context
          ? pill('context', 0, [
              <Text color="inactive">{ctxLabel}</Text>,
              <Text>{percentText(context)}</Text>,
            ])
          : null}
      </Box>
      {sideSpacer('right')}
      </Box>
    )
    return survey ? <Box flexDirection="column">{bar}{survey}</Box> : bar
  })
}
