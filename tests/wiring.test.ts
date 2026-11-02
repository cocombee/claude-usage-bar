import { test, expect, mock } from 'claude-code/testing'

import { shown, exactly } from './shown'
import { repairStore, foldLimits, parseLive, parseProfile, creditText, prepaidUrl, LIVE_URL, PROFILE_URL } from '../hooks/register'

// Wiring: every figure comes from the engine's own events, as a session raises them.

const props = (bodyColumns: number) => ({
  hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns,
  scroll: { offset: 0, bodyRows: 20 }, view: {},
})
const HOUR = 3600_000
// Reads the row on either surface: on the desktop these figures are drawn into
// one SVG, so looking only for Text elements there finds nothing at all — which
// silently turned the "is not shown" checks below into assertions about nothing.
const count = async (ui: any, s: string | RegExp) => exactly(await shown(ui), s)
const has = async (ui: any, s: string | RegExp) => (await count(ui, s)) > 0

test('session start reads $.session.usage: 5-hour, weekly and context', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { tokens: 50_000, window: 200_000, percent: 25 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 62.5, resetsAt: new Date(clock.now() + 3 * HOUR + 20 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(clock.now() + 4 * 24 * HOUR + 5 * HOUR).toISOString() },
    ],
  } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  // remaining = 100 − used, rounded
  expect(await has(ui, '37%')).toBe(true)   // 5-hour: 62.5 used is "63% used" in the app, so 37 left
  expect(await has(ui, '59%')).toBe(true)   // weekly: 100 − 41
  expect(await has(ui, '25%')).toBe(true)   // context
  expect(await has(ui, '3h 20m')).toBe(true)
  expect(await has(ui, '4d 5h')).toBe(true)
})

test('a measurement moves the bar; a window past its reset shows — not a stale number', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 10, window: 100, percent: 10 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 95, resetsAt: new Date(clock.now() - 1000).toISOString() },
      { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(clock.now() + 2 * HOUR).toISOString() },
    ],
    changed: ['context', 'rateLimits'],
  })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '88%')).toBe(true)          // weekly
  expect(await has(ui, '5%')).toBe(false)          // expired 5-hour is not shown as 5%
  expect(await has(ui, 'Updating')).toBe(true)     // its countdown says it is resetting
  expect(await has(ui, '10%')).toBe(true)
})

test('no subscription reading: every quota value is —, never 0%', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, /^0%$/)).toBe(false)
  expect((await count(ui, '—')) >= 3).toBe(true)
})

// Speed: output tokens over the model-response time of the turn's steps.
async function step($: any, turnId: string, index: number, agentId?: string) {
  const stream = $.turn.step({ turnId, index, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) { /* drain */ }
  return stream.result
}

test('token speed: output tokens / response seconds, during the turn; — after', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  // Each step: the model takes 2s and writes 300, then 100 output tokens.
  const outputs = [300, 100]
  on('turn.step', async function* (_$, e) {
    await clock.sleep(2000)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: outputs[e.index] ?? 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' } }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'hi', turnId: 't1' })
  const mount = () => $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(await mount(), '—')).toBe(true)   // nothing measured yet

  let run = step($, 't1', 0); await clock.advance(2000); await run
  expect(await has(await mount(), '~150')).toBe(true) // 300 / 2s

  // Tool time between steps is not counted: only the step's own 2s.
  await clock.advance(10_000)
  run = step($, 't1', 1); await clock.advance(2000); await run
  expect(await has(await mount(), '~100')).toBe(true) // (300+100) / (2s+2s)

  await $.turn.complete({ answer: '', durationMs: 14_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await has(await mount(), /^~/)).toBe(false)  // cleared to —
})

test("a subagent's steps never count toward the main turn's speed", async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    await clock.sleep(1000)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' } }
  })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const run = step($, 't1', 0, 'agent-1'); await clock.advance(1000); await run
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  // The bar did draw — so the absent speed below is a real absence, not an empty tree.
  expect(await has(ui, '—')).toBe(true)
  expect(await has(ui, /^~/)).toBe(false)
})

test('countdowns move on the engine clock without a new API response', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: {
    startedAt: 0, context: { window: 100 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: new Date(2 * HOUR).toISOString() }],
  } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const mount = () => $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(160) })
  expect(await has(await mount(), '2h 0m')).toBe(true)
  await clock.advance(HOUR + 30 * 60_000)
  expect(await has(await mount(), '30m')).toBe(true)
})

// A new chat has no limits of its own until its first reply arrives. The last
// reading any session saw is the account's and still holds, so the bar shows it
// from the start instead of sitting at "—" until the first message.
test('a new chat shows the last saved limits at once, before its first message', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { lastRateLimits: [
    { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(clock.now() + 2 * HOUR).toISOString() },
    { kind: 'seven_day', percentUsed: 6, resetsAt: new Date(clock.now() + 3 * 24 * HOUR).toISOString() },
  ] })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '80%')).toBe(true)   // 5-hour: 100 − 20
  expect(await has(ui, '94%')).toBe(true)   // weekly: 100 − 6
})

test('a saved reading past its reset time shows —, not a stale figure', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  mock.store(on, { lastRateLimits: [
    { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(clock.now() - 1000).toISOString() },
    { kind: 'seven_day', percentUsed: 6, resetsAt: new Date(clock.now() + 24 * HOUR).toISOString() },
  ] })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '80%')).toBe(false)
  expect(await has(ui, '94%')).toBe(true)
})

test('every reading with limits in it is saved for the next chat', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 100 }, rateLimits: [] } }))
  await $.session.measure({
    context: { window: 100 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 33, resetsAt: new Date(clock.now() + HOUR).toISOString() }],
    changed: ['rateLimits'],
  })
  // a reading with no limits in it (no subscription, or not yet) keeps the saved one
  await $.session.measure({ context: { window: 100 }, rateLimits: [], changed: ['context'] })
  // the next chat starts with no limits of its own, and shows the saved reading
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '67%')).toBe(true)   // 100 − 33
})

// A new chat raises a measurement for its context before any reply, with no
// limits in it. That must not wipe the saved limits the chat started with.
test('a context-only measurement at the start keeps the saved limits on screen', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { lastRateLimits: [
    { kind: 'five_hour', percentUsed: 22, resetsAt: new Date(clock.now() + 2 * HOUR).toISOString() },
    { kind: 'seven_day', percentUsed: 7, resetsAt: new Date(clock.now() + 15 * HOUR).toISOString() },
  ] })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { tokens: 9_000, window: 200_000, percent: 4 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '78%')).toBe(true)   // 5-hour: 100 − 22
  expect(await has(ui, '93%')).toBe(true)   // weekly: 100 − 7
  expect(await has(ui, '4%')).toBe(true)    // this chat's own context
})

// A long turn: session.measure waits for the turn's end, but each response
// reports what it was answered over, so Context follows it during the turn.
test('context follows each response during a turn, not only at its end', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 100_000, window: 1_000_000, percent: 10 }, rateLimits: [] } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 166, output_tokens: 50, cache_read_input_tokens: 190_000, cache_creation_input_tokens: 7_000, model: 'm' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '10%')).toBe(true)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await step($, 't1', 0)
  expect(await has(ui, '20%')).toBe(true)   // 197,166 of 1,000,000
  expect(await has(ui, '10%')).toBe(false)
  // a subagent's own, smaller context never replaces the chat's
  await step($, 't1', 1, 'sub')
  expect(await has(ui, '20%')).toBe(true)
})

// A question in the band: the bar stays, drawn above it, instead of vanishing.
test('a survey in the band keeps the bar above it', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Text', children: ['Survey question'] }) as any)
  await $.session.measure({ context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: { ...props(160), hasSurvey: true } })
  expect(await has(ui, 'Survey question')).toBe(true)
  expect(await has(ui, '20%')).toBe(true)
})

// The fill is read when the response starts streaming, not only when it ends.
test('context moves at the first piece of a response, before it ends', async ($, on) => {
  mock.clock(on, { now: 0 })
  let live = 10
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: live * 10_000, window: 1_000_000, percent: live }, rateLimits: [] } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    live = 20 // the request went out over a fuller context
    yield { kind: 'text', index: 0, text: 'Hel' } as any
    yield { kind: 'text', index: 0, text: 'lo' } as any
    return { turnId: e.turnId, index: e.index, answer: 'Hello', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '10%')).toBe(true)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  await stream.next() // the first piece is out; the response has not ended
  await stream.next()
  expect(await has(ui, '20%')).toBe(true)
  for await (const _ of stream) { /* drain */ }
})

// One store every chat shares: a test writes to it as another chat would.
function sharedStore(on: any, initial: Record<string, unknown> = {}) {
  const db: Record<string, unknown> = { ...initial }
  on('store.get', (_$: any, e: any) => ({ value: db[e.key] }))
  on('store.set', (_$: any, e: any) => { db[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete db[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(db) }))
  return db
}

// The bar can be drawn before this chat's hooks have read anything: the saved
// reading is in the store already, so it shows at once, not at the first sync tick.
test('the first draw shows the saved limits before any hook has run', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  sharedStore(on, { latestRateLimits: { at: clock.now(), limits: [
    { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(clock.now() + 2 * HOUR).toISOString() },
    { kind: 'seven_day', percentUsed: 9, resetsAt: new Date(clock.now() + 3 * 24 * HOUR).toISOString() },
  ] } })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '70%')).toBe(true)   // 5-hour: 100 − 30
  expect(await has(ui, '91%')).toBe(true)   // weekly: 100 − 9
})

// A crash mid-write left the store file as null bytes; the engine refused every
// call on it until the file was replaced, so the file its error names is reset.
// (A store hook that throws is skipped by the test engine rather than raised, so
// the repair is checked against the engine's own wording here.)
test('a store the engine calls malformed is reset to an empty one; other errors are left alone', async () => {
  const file = 'C:\\Users\\u\\.claude\\plugins\\store\\usage-bar_cocombee-c8e91c72c9b9.json'
  const writes: [string, string][] = []
  const $ = { fs: { write: async (path: string, text: string) => { writes.push([path, text]) } } }
  const malformed = new Error(`usage-bar: store file ${file} is malformed (JSON Parse error: Unrecognized token '\0')`)
  expect(await repairStore($, malformed)).toBe(true)
  expect(writes).toEqual([[file, '{}\n']])
  expect(await repairStore($, new Error(`usage-bar: store file ${file} is unreadable (EACCES)`))).toBe(false)
  expect(await repairStore($, new Error('usage-bar: $.store.set failed: EBUSY'))).toBe(false)
  expect(writes.length).toBe(1)
})

// Another chat's newer reading (a reply there, or limits reset early) reaches
// this chat on its next clock tick, not at its own next reply.
test('a newer reading saved by another chat shows here within seconds', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const db = sharedStore(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [
    { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(clock.now() + 2 * HOUR).toISOString() },
  ] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const mount = () => $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(await mount(), '88%')).toBe(true)
  db.latestRateLimits = { at: clock.now() + 1000, limits: [
    { kind: 'five_hour', percentUsed: 13, resetsAt: new Date(clock.now() + 2 * HOUR).toISOString() },
  ] }
  await clock.advance(6_000)
  expect(await has(await mount(), '87%')).toBe(true)
})

// The limits are read with each response of this chat, not only when a
// measurement comes, and saved for the other chats with when they were read.
test('each response reads the limits and shares them with the other chats', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  const db = sharedStore(on)
  let used = 12
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 10, window: 100, percent: 10 }, rateLimits: [
    { kind: 'five_hour', percentUsed: used, resetsAt: new Date(clock.now() + 2 * HOUR).toISOString() },
  ] } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    used = 13
    yield { kind: 'text', index: 0, text: 'Hi' } as any
    return { turnId: e.turnId, index: e.index, answer: 'Hi', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '88%')).toBe(true)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await step($, 't1', 0)
  expect(await has(ui, '87%')).toBe(true)
  const saved: any = db.latestRateLimits
  expect(saved.limits[0].percentUsed).toBe(13)
  expect(saved.at).toBe(clock.now())
})

// The live reading: the usage panel's own figure, from the endpoint the app
// reads, not the whole-point figure a reply's headers carried.
// Answers the usage endpoint with `body` and the profile with `profile` (none: 404).
// `calls` holds the usage reads only.
function liveUsage(on: any, body: () => unknown, calls: any[] = [], profile?: unknown) {
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', (_$: any, e: any) => {
    if (e.url === PROFILE_URL) {
      return { value: profile ? { status: 200, ok: true, headers: {}, text: JSON.stringify(profile) } : { status: 404, ok: false, headers: {}, text: '' } }
    }
    calls.push(e)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body()) } }
  })
  return calls
}
const MAX = { account: { has_claude_max: true, has_claude_pro: false }, organization: { organization_type: 'claude_max' } }
const PRO = { account: { has_claude_max: false, has_claude_pro: true }, organization: { organization_type: 'claude_pro' } }

test('the usage panel figure replaces the headers’ one and is shared, read with the session credential', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const db = sharedStore(on)
  const resets = new Date(clock.now() + 4 * 24 * HOUR).toISOString()
  const calls = liveUsage(on, () => ({ five_hour: { utilization: 1, resets_at: null }, seven_day: { utilization: 44, resets_at: resets } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [
    { kind: 'seven_day', percentUsed: 43, resetsAt: resets },
  ] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '56%')).toBe(true)          // 100 − 44, the panel's figure
  expect(await has(ui, '57%')).toBe(false)         // not the headers' 43
  expect(calls[0].url).toBe(LIVE_URL)
  expect(calls[0].init.auth).toBe('h1')
  const saved: any = db.latestRateLimits
  expect(saved.live).toBe(true)
  expect(saved.limits.find((l: any) => l.kind === 'seven_day').percentUsed).toBe(44)
})

test('a later reply’s headers never pull the figure back below the panel’s', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  sharedStore(on)
  const resets = new Date(clock.now() + 4 * 24 * HOUR).toISOString()
  liveUsage(on, () => ({ seven_day: { utilization: 44, resets_at: resets } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  await $.session.measure({ context: { window: 200_000 }, changed: ['rateLimits'], rateLimits: [
    { kind: 'seven_day', percentUsed: 43, resetsAt: new Date(Date.parse(resets) - 1000).toISOString() },
  ] })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '56%')).toBe(true)
})

test('several open chats read the panel once a minute between them', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  sharedStore(on, { liveReadAtV3: 1_000_000 - 10_000 })   // another chat read it 10s ago
  const calls = liveUsage(on, () => ({ seven_day: { utilization: 44, resets_at: null } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(30_000)
  expect(calls.length).toBe(0)
  await clock.advance(30_000)
  expect(calls.length).toBe(1)
})

test('a refused panel read leaves the headers’ figure and waits before trying again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  sharedStore(on)
  const calls: any[] = []
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', (_$: any, e: any) => { if (e.url !== PROFILE_URL) calls.push(e); return { value: { status: 429, ok: false, headers: {}, text: '' } } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [
    { kind: 'seven_day', percentUsed: 43, resetsAt: new Date(clock.now() + HOUR).toISOString() },
  ] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(2 * 60_000)
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(await has(ui, '57%')).toBe(true)
  expect(calls.length).toBe(1)
})

test('folding: same window keeps the higher figure; a new window is taken as it is', () => {
  const t = '2026-11-02T16:00:00.000Z'
  expect(foldLimits([{ kind: 'seven_day', percentUsed: 44, resetsAt: t }], [{ kind: 'seven_day', percentUsed: 43, resetsAt: t }])[0]?.percentUsed).toBe(44)
  expect(foldLimits([{ kind: 'seven_day', percentUsed: 44, resetsAt: t }], [{ kind: 'seven_day', percentUsed: 2, resetsAt: '2026-11-09T16:00:00.000Z' }])[0]?.percentUsed).toBe(2)
  expect(parseLive('{"five_hour":{"utilization":12.345,"resets_at":"2026-10-29T16:19:59.912+00:00"},"seven_day":null}').filter(l => l.kind !== 'credit_all'))
    .toEqual([{ kind: 'five_hour', percentUsed: 12.3, resetsAt: '2026-10-29T16:19:59.912Z' }])
  expect(parseLive('{"five_hour":{"utilization":null,"resets_at":null},"seven_day":{"utilization":44,"resets_at":null}}').filter(l => l.kind !== 'credit_all'))
    .toEqual([{ kind: 'seven_day', percentUsed: 44 }])
})

// Plans without a 5-hour window show their extra-usage credit in its place.
const credit = { is_enabled: true, monthly_limit: 5000, used_credits: 1240, utilization: 24.8, currency: 'usd' }

test('plan unknown and no 5-hour window: the credit takes its slot, as label, bar and amount', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  sharedStore(on)
  const resets = new Date(clock.now() + 4 * 24 * HOUR).toISOString()
  liveUsage(on, () => ({ five_hour: null, seven_day: { utilization: 97, resets_at: resets }, extra_usage: credit }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const mount = () => $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  let words = await shown(await mount())
  expect(exactly(words, 'Credit')).toBe(1)
  expect(exactly(words, '$37.60')).toBe(1)     // 50.00 − 12.40 = 37.60 left
  expect(exactly(words, '75%')).toBe(0)        // no percentage: the bar shows it
  expect((await (await mount()).findAll({ type: 'Svg' })).some((x: any) => /75%? left|75% left/.test(String(x.props?.alt)))).toBe(true)
  expect(exactly(words, '5-hour')).toBe(0)
  // A later reply's headers have no credit in them: the panel's stays.
  await $.session.measure({ context: { window: 200_000 }, changed: ['rateLimits'], rateLimits: [
    { kind: 'seven_day', percentUsed: 97, resetsAt: resets },
  ] })
  words = await shown(await mount())
  expect(exactly(words, '$37.60')).toBe(1)
})

test('a 5-hour window, when the plan has one, keeps its slot over the credit', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  sharedStore(on)
  const soon = new Date(clock.now() + 2 * HOUR).toISOString()
  liveUsage(on, () => ({ five_hour: { utilization: 40, resets_at: soon }, seven_day: { utilization: 10, resets_at: soon }, extra_usage: credit }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const words = await shown(await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) }))
  expect(exactly(words, '5-hour')).toBe(1)
  expect(exactly(words, 'Credit')).toBe(0)
})

test('Max: credit replaces the 5-hour reading even while one is reported', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const db = sharedStore(on)
  const soon = new Date(clock.now() + 2 * HOUR).toISOString()
  liveUsage(on, () => ({ five_hour: { utilization: 40, resets_at: soon }, seven_day: { utilization: 10, resets_at: soon }, extra_usage: credit }), [], MAX)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const words = await shown(await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) }))
  expect(exactly(words, 'Credit')).toBe(1)
  expect(exactly(words, '$37.60')).toBe(1)
  expect(exactly(words, '5-hour')).toBe(0)
  expect((db.plan as any).max).toBe(true)
})

test('Pro: the 5-hour reading stays, and another chat reuses the saved plan', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  sharedStore(on, { plan: { max: false, org: null, at: 1_000_000 - HOUR } })
  const soon = new Date(clock.now() + 2 * HOUR).toISOString()
  let profileReads = 0
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', (_$: any, e: any) => {
    if (e.url === PROFILE_URL) profileReads++
    const body = e.url === PROFILE_URL ? PRO : { five_hour: null, seven_day: { utilization: 10, resets_at: soon }, extra_usage: credit }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const words = await shown(await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) }))
  expect(exactly(words, '5-hour')).toBe(1)     // no window reported: "—", not credit
  expect(exactly(words, 'Credit')).toBe(0)
  expect(profileReads).toBe(0)
})

test('the profile says Max, not Max, or nothing', () => {
  expect(parseProfile(JSON.stringify(MAX))?.max).toBe(true)
  expect(parseProfile(JSON.stringify({ organization: { organization_type: 'claude_max', uuid: 'org-1' } }))).toEqual({ max: true, org: 'org-1' })
  expect(parseProfile(JSON.stringify(PRO))?.max).toBe(false)
  expect(parseProfile('{}')).toBe(null)
})

test('Max with credit switched off: the slot shows the $0 balance, not —', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  sharedStore(on, { plan: { max: true, at: 1_000_000 } })
  const soon = new Date(clock.now() + 2 * HOUR).toISOString()
  liveUsage(on, () => ({ five_hour: null, seven_day: { utilization: 97, resets_at: soon },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0, enabled: false, balance: null } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const words = await shown(await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) }))
  expect(exactly(words, 'Credit')).toBe(1)
  expect(exactly(words, '$0')).toBe(1)
  expect(exactly(words, '3%')).toBe(1)
})

test('a live reading from a chat on an older version, without credit, keeps the credit held', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const db = sharedStore(on, { plan: { max: true, at: 1_000_000 }, liveReadAt: 1_000_000 - 5_000 })
  const soon = new Date(clock.now() + 2 * HOUR).toISOString()
  const calls = liveUsage(on, () => ({ five_hour: null, seven_day: { utilization: 97, resets_at: soon }, extra_usage: credit }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(calls.length).toBe(1)                  // the older chats' read time does not hold it back
  db.latestRateLimits = { at: clock.now() + 1000, live: true, limits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: soon }] }
  await clock.advance(6_000)
  const words = await shown(await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) }))
  expect(exactly(words, '$37.60')).toBe(1)
})

test('a long credit balance keeps 5-hour\'s width: the ring goes first, then the label', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  sharedStore(on, { plan: { max: true, at: 1_000_000 } })
  const soon = new Date(clock.now() + 2 * HOUR).toISOString()
  const usd = (n: number) => ({ amount_minor: n, currency: 'USD', exponent: 2 })
  liveUsage(on, () => ({ five_hour: null, seven_day: { utilization: 15, resets_at: soon },
    spend: { used: usd(0), limit: null, percent: 0, enabled: true, balance: usd(1234500) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const at = async (cols: number) => {
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(cols) })
    const rings = (await ui.findAll({ type: 'Svg' })).filter((x: any) => String(x.props?.source).includes('<circle')).length
    return { words: await shown(ui), rings }
  }
  // The same sizes as 5-hour: XL from 68 columns keeps full labels' short form and countdowns.
  const xl = await at(68)
  expect(exactly(xl.words, 'Cr')).toBe(1)
  expect(exactly(xl.words, '$12,345')).toBe(1)
  expect(exactly(xl.words, '5d')).toBe(0)
  // M (rings): "$12,345" is 3 cells wider than "99%": its ring goes, and then its label.
  const m = await at(51)
  expect(exactly(m.words, 'Wk')).toBe(1)
  expect(exactly(m.words, 'Cr')).toBe(0)
  expect(exactly(m.words, '$12,345')).toBe(1)
  expect(m.rings).toBe(1)                       // Weekly's ring only
})

test('credit adds up every open source: promo, Claude Code and Cowork, and bought', () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const later = '2026-11-20T00:00:00+00:00', gone = '2026-10-30T00:00:00+00:00'
  const usd = (n: number) => ({ amount_minor: n, currency: 'USD', exponent: 2 })
  const credit = (body: object) => parseLive(JSON.stringify(body), now).find(l => l.kind === 'credit_all') as any
  // Promo credit alone, in dollars.
  const promo = credit({ wattle_ember: { utilization: 0, resets_at: later, label: 'Credit', limit_dollars: 200, used_dollars: 0, remaining_dollars: 200 } })
  expect(creditText(promo)).toBe('$200')
  expect(promo.limit).toBe(200)
  // Promo plus bought credit (cents) plus Cowork credit: one total.
  const all = credit({
    wattle_ember: { utilization: 10, resets_at: later, limit_dollars: 200, used_dollars: 20, remaining_dollars: 180 },
    cinder_cove: { utilization: 50, resets_at: later, limit_dollars: 50, used_dollars: 25, remaining_dollars: null },
    spend: { used: usd(1240), limit: usd(5000), percent: 24.8, enabled: true, balance: null },
  })
  expect(all.left).toBe(242.6)                  // 180 + 25 + 37.60
  expect(creditText(all)).toBe('$242')
  expect(all.limit).toBe(300)
  // An ended promo is left out; a balance with no limit makes the total's limit unknown.
  const mixed = credit({ wattle_ember: { resets_at: gone, limit_dollars: 200, remaining_dollars: 200 }, spend: { used: usd(0), enabled: true, balance: usd(125037) } })
  expect(creditText(mixed)).toBe('$1,250')
  expect(mixed.limit).toBe(null)
  // Nothing anywhere: $0, not a blank.
  const none = credit({ spend: { used: usd(0), limit: null, percent: 0, enabled: false, balance: null }, extra_usage: { is_enabled: false } })
  expect(creditText(none)).toBe('$0')
  // The older extra_usage, in minor units.
  expect(creditText(credit({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1240, utilization: 24.8, currency: 'usd' } }))).toBe('$37.60')
})

test('Max with a $200 promo credit shows $200 with a full track', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  sharedStore(on, { plan: { max: true, at: 1_000_000 } })
  const soon = new Date(clock.now() + 2 * HOUR).toISOString(), month = new Date(clock.now() + 20 * 24 * HOUR).toISOString()
  liveUsage(on, () => ({ five_hour: null, seven_day: { utilization: 97, resets_at: soon },
    wattle_ember: { utilization: 0, resets_at: month, label: 'Credit', limit_dollars: 200, used_dollars: 0, remaining_dollars: 200 },
    spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0, enabled: false, balance: null } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) })
  expect(exactly(await shown(ui), '$200')).toBe(1)
  expect((await ui.findAll({ type: 'Svg' })).some((x: any) => x.props?.alt === '100% left')).toBe(true)
})

test('prepaid credit, read under the organization the profile names, adds to the total', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const db = sharedStore(on)
  const soon = new Date(clock.now() + 2 * HOUR).toISOString(), month = new Date(clock.now() + 20 * 24 * HOUR).toISOString()
  const urls: string[] = []
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', (_$: any, e: any) => {
    urls.push(e.url)
    const body = e.url === PROFILE_URL ? { account: { has_claude_max: true }, organization: { organization_type: 'claude_max', uuid: 'org-1' } }
      : e.url === prepaidUrl('org-1') ? { amount: 20000, currency: 'usd', auto_reload_settings: { enabled: false } }
      : { five_hour: null, seven_day: { utilization: 98, resets_at: soon },
          wattle_ember: { resets_at: month, limit_dollars: 50, used_dollars: 10, remaining_dollars: 40 },
          spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0, enabled: false, balance: null } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const words = await shown(await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) }))
  expect(exactly(words, '$240')).toBe(1)        // $200 prepaid + $40 promo
  expect(urls).toContain(prepaidUrl('org-1'))
  expect((db.prepaid as any).part.left).toBe(200)
  // Another read within five minutes reuses the saved balance.
  const before = urls.filter(u => u === prepaidUrl('org-1')).length
  await clock.advance(61_000)
  expect(urls.filter(u => u === prepaidUrl('org-1')).length).toBe(before)
})

test('an older chat\'s credit entry, in its earlier shape, neither shows nor replaces this one', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const db = sharedStore(on, { plan: { max: true, org: null, at: 1_000_000 } })
  const soon = new Date(clock.now() + 2 * HOUR).toISOString()
  liveUsage(on, () => ({ five_hour: null, seven_day: { utilization: 97, resets_at: soon }, extra_usage: credit }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  db.latestRateLimits = { at: clock.now() + 1000, live: true, limits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: soon },
    { kind: 'credit', percentUsed: null, used: 0, limit: null, balance: 0, exponent: 2, currency: 'USD' }] }
  await clock.advance(6_000)
  const words = await shown(await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(160) }))
  expect(exactly(words, '$37.60')).toBe(1)
})

test('credit keeps its cents up to four digits ($99.99); from $100 it is whole dollars', () => {
  const c = (left: number) => creditText({ left, limit: null, currency: 'USD' })
  expect(c(0.7)).toBe('$0.70')
  expect(c(9.999)).toBe('$9.99')               // rounded down, never up to $10.00
  expect(c(0)).toBe('$0')
  expect(c(37.6)).toBe('$37.60')
  expect(c(99.999)).toBe('$99.99')
  expect(c(100)).toBe('$100')
  expect(c(1250.37)).toBe('$1,250')
})

test('the account\'s real mix: spend over its limit plus a $0.70 prepaid balance reads $0.70', () => {
  const now = Date.parse('2026-11-03T00:00:00Z')
  const usd = (n: number) => ({ amount_minor: n, currency: 'USD', exponent: 2 })
  const parsed = parseLive(JSON.stringify({
    spend: { used: usd(4142), limit: usd(4000), percent: 100, enabled: false, cap: { money: null, credits: { amount_minor: 4000, exponent: 2 } }, balance: null },
    extra_usage: { is_enabled: false, monthly_limit: 4000, used_credits: 4142, utilization: 100, currency: 'USD', decimal_places: 2 },
  }), now, [{ left: 0.7, limit: 0.7, currency: 'USD' }]).find(l => l.kind === 'credit_all') as any
  expect(parsed.left).toBe(0.7)
  expect(creditText(parsed)).toBe('$0.70')
})
