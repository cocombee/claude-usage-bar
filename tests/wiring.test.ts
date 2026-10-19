import { test, expect, mock } from 'claude-code/testing'

import { shown, exactly } from './shown'

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
  expect(await has(ui, '38%')).toBe(true)   // 5-hour: 100 − 62.5
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

// Another chat's newer reading (a reply there, or limits reset early) reaches
// this chat on its next clock tick, not at its own next reply.
test('a newer reading saved by another chat shows here within the tick', async ($, on) => {
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
  await clock.advance(31_000)
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
