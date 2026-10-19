import { test, expect, mock } from 'claude-code/testing'

import { resetText, quotaTone, trackSvg, fitLevel, layoutFor, rowWidth, LEVELS, TRACK_HEIGHT, SIDE_INSET } from '../hooks/register'
import { shown, exactly, like } from './shown'

const props = (bodyColumns: number) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
})

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: shows 5-hour, weekly and context from the session's measurement`, async ($, on) => {
    mock.clock(on, { now: Date.now() })
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    await $.session.measure({
      context: { tokens: 42_000, window: 200_000, percent: 21 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 85, resetsAt: inHours(2.5) },
        { kind: 'seven_day', percentUsed: 30, resetsAt: inHours(50) },
      ],
      changed: ['context', 'rateLimits'],
    })
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(140) })
    const words = await shown(ui)
    expect(like(words, '5-hour')).toBeGreaterThan(0)
    expect(exactly(words, '15%')).toBe(1)
    expect(like(words, /left/)).toBe(0)
    expect(exactly(words, '70%')).toBe(1)
    expect(like(words, '21%')).toBe(1)
  })

  test(`${surface}: missing data is a dash, never zero`, async ($, on) => {
    mock.clock(on, { now: Date.now() })
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(140) })
    const words = await shown(ui)
    expect(like(words, '0%')).toBe(0)
    expect(exactly(words, '—')).toBeGreaterThan(0)
  })

  test(`${surface}: narrow rows shorten labels`, async ($, on) => {
    mock.clock(on, { now: Date.now() })
    // 74 sits in the small size's range on both surfaces (64–79 with no data yet)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(74) })
    const words = await shown(ui)
    expect(exactly(words, '5h')).toBe(1)
    expect(exactly(words, 'Ctx')).toBe(1)
  })

  test(`${surface}: the smaller size still keeps the Wk and 5h labels`, async ($, on) => {
    mock.clock(on, { now: Date.now() })
    // 55: the smaller size on both surfaces with no data yet (desktop 35–63, terminal 41–63)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(55) })
    const words = await shown(ui)
    expect(exactly(words, 'Wk')).toBe(1)
    expect(exactly(words, '5h')).toBe(1)
    expect(like(words, /tok/)).toBe(0)
  })

  test(`${surface}: the narrow size drops the Wk and 5h labels but keeps Ctx`, async ($, on) => {
    mock.clock(on, { now: Date.now() })
    // the narrow size with no data yet: desktop 29–34, terminal 35–40
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(surface === 'desktop' ? 32 : 38) })
    const words = await shown(ui)
    expect(exactly(words, 'Wk') + exactly(words, '5h') + exactly(words, 'Weekly') + exactly(words, '5-hour')).toBe(0)
    expect(exactly(words, 'Ctx')).toBe(1)
  })
}

// The pills are Boxes of Text on both surfaces; on the desktop each quota pill's
// track is a small SVG of its own, 4.5px tall with fully rounded ends.
test('desktop draws a rounded 4.5px track in each quota pill', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 92, resetsAt: inHours(1) }],
    changed: ['rateLimits'],
  })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(140) })
  const tracks = (await ui.findAll({ type: 'Svg' })).map((t: any) => String(t.props.source)).filter(src => src.includes('clipPath'))
  expect(tracks.length).toBe(2)
  expect(tracks.every(t => t.includes(`height="${TRACK_HEIGHT}"`))).toBe(true)
  expect(tracks.every(t => t.includes(`rx="${TRACK_HEIGHT / 2}"`))).toBe(true)
})

test('track svg geometry', () => {
  const svg = trackSvg(15, 'warning')
  expect(svg.includes('height="4.5"')).toBe(true)
  expect(svg.includes('rx="2.25"')).toBe(true)
  expect(svg.includes('width="15%"')).toBe(true)
  expect(svg.includes('#e3b341')).toBe(true)
})

test('presentation rules match the original', () => {
  const now = 0
  expect(resetText(now + 2.5 * 3600_000, now)).toBe('2h 30m')
  expect(resetText(now + 50 * 3600_000, now)).toBe('2d 2h')
  expect(resetText(now + 50 * 3600_000, now, true)).toBe('2d')
  // Weekly's countdown stops at hours: no minutes
  expect(resetText(now + 15 * 3600_000 + 40 * 60_000, now, false, false)).toBe('15h')
  expect(resetText(now + 50 * 3600_000, now, false, false)).toBe('2d 2h')
  expect(resetText(now + 45 * 60_000, now, false, false)).toBe('45m')
  expect(resetText(now - 1, now)).toBe('Updating')
  expect(resetText(null, now)).toBe('—')
  expect(quotaTone(10)).toBe('low')
  expect(quotaTone(20)).toBe('warning')
  expect(quotaTone(21)).toBe('normal')
})

const texts = { weekly: ['70%', '2d 2h', '2d'], five: ['15%', '2h 30m', '2h'], speed: '~84', context: '21%' }

test('sizes step down in order, fullest that fits', () => {
  const widthAt = (level: number) => {
    const L = layoutFor(level)
    return rowWidth(L, { weekly: ['70%', L.compactReset ? '2d' : '2d 2h'], five: ['15%', L.compactReset ? '2h' : '2h 30m'], speed: '~84', context: '21%' }, true)
  }
  expect(fitLevel(160, true, texts)).toBe(0)
  let previous = 0
  for (let columns = 160; columns >= widthAt(LEVELS - 1); columns--) {
    const level = fitLevel(columns, true, texts)
    expect(level >= previous).toBe(true)
    previous = level
  }
  const small = layoutFor(1)
  expect(small.compactLabels && small.compactReset && small.bolt && small.reset && small.speed).toBe(true)
  const smaller = layoutFor(2)
  expect(smaller.reset || smaller.speed).toBe(false)
  expect(fitLevel(widthAt(LEVELS - 1), true, texts)).toBe(LEVELS - 1)
})

// Five sizes. Small shortens the labels and countdowns; smaller gives up the reset
// times and the token-speed pill; narrow the Wk / 5h labels; smallest Context.
test('five sizes, each giving up the next thing', () => {
  expect(LEVELS).toBe(5)
  const ladder = Array.from({ length: LEVELS }, (_, i) => layoutFor(i))
  expect(ladder.map(L => L.reset)).toEqual([true, true, false, false, false])
  expect(ladder.map(L => L.speed)).toEqual([true, true, false, false, false])
  expect(ladder.map(L => L.quotaLabels)).toEqual([true, true, true, false, false])
  expect(ladder.map(L => L.context)).toEqual([true, true, true, true, false])
  expect(ladder.map(L => L.compactLabels)).toEqual([false, true, true, true, true])
  // nothing is ever given up and then taken back lower down
  for (const key of ['reset', 'speed', 'quotaLabels', 'context'] as const) {
    const kept = ladder.map(L => L[key])
    expect(kept.slice(1).every((v, i) => !(v && !kept[i]))).toBe(true)
  }
})

test('only the narrowest size drops the Context pill', () => {
  expect(layoutFor(LEVELS - 1).context).toBe(false)
  for (let level = 0; level < LEVELS - 1; level++) {
    expect(layoutFor(level).context).toBe(true)
  }
})

test('every chosen layout fits its row, down to the smallest', () => {
  for (const isTerminal of [true, false]) {
    const S = layoutFor(LEVELS - 1)
    const floor = rowWidth(S, { weekly: ['70%', ''], five: ['15%', ''], speed: '~84', context: '21%' }, isTerminal)
    for (let columns = 160; columns >= floor; columns--) {
      const L = layoutFor(fitLevel(columns, isTerminal, texts))
      const t = { weekly: ['70%', L.compactReset ? '2d' : '2d 2h'], five: ['15%', L.compactReset ? '2h' : '2h 30m'], speed: '~84', context: '21%' }
      expect(rowWidth(L, t, isTerminal) <= columns).toBe(true)
    }
  }
})

test('quota pills show their figures with no padding in the text, parts spaced by the gap', async ($, on) => {
    mock.clock(on, { now: Date.now() })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 0, resetsAt: inHours(150) },
      { kind: 'five_hour', percentUsed: 92, resetsAt: inHours(0.5) },
    ],
    changed: ['rateLimits'],
  })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(140) })
  const words = await shown(ui)
  expect(exactly(words, '100%')).toBe(1)
  // values sit in same-size slots, so the text itself carries no padding
  expect(exactly(words, '8%')).toBe(1)
  expect(exactly(words, '30m')).toBe(1)
  // the parts sit straight in the pill, spaced by its one-cell gap alone: no
  // fixed-width box around any of them to leave spare room in that gap
  const sized = (await ui.findAll({ type: 'Box' })).filter((b: any) => typeof b.props.width === 'number')
  expect(sized.length).toBe(0)
})

test('the smaller size drops the token-speed pill but keeps Context', async ($, on) => {
    mock.clock(on, { now: Date.now() })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(46) })
  expect((await ui.findAll({ type: 'Text', text: /tok/ })).length).toBe(0)
  expect((await ui.findAll({ type: 'Text', text: /^Ctx$/ })).length).toBe(1)
})

// Equal padding on both sides of a pill, and the second padding between parts:
// the countdown is the pill's last part and the label its first, each a bare Text
// right against the pill's own padding, with only the pill's one-cell gap between
// neighbours. A short countdown ("2h" beside "15h") therefore leaves no extra room
// on the right of its pill, and a short label none before its track.
test('parts sit right against the pill padding, a one-cell gap between them', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 10, window: 100, percent: 10 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 5, resetsAt: inHours(15.2) },
      { kind: 'five_hour', percentUsed: 15, resetsAt: inHours(2.1) },
    ],
    changed: ['context', 'rateLimits'],
  })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(140) })
  const pills = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props.borderStyle === 'round')
  expect(pills.length).toBe(4)
  for (const pill of pills) {
    expect(pill.props.paddingX).toBe(2)
    expect(pill.props.columnGap).toBe(1)
    // every part is a direct child: a Text, the bolt, or a track — never a slot
    for (const child of pill.children as any[]) {
      if (child && typeof child === 'object' && child.type === 'Box') expect(child.props.width).toBeUndefined()
    }
  }
})

// The desktop's bolt is a drawing, whose ink starts exactly at the pill's padding;
// the ⚡ emoji's own side bearings made that pill's left side 3px wider than its right.
test('desktop draws the bolt as an SVG; the terminal keeps the ⚡ character', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  const desk = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(140) })
  const bolts = (await desk.findAll({ type: 'Svg' })).filter((s: any) => s.props.alt === 'token speed')
  expect(bolts.length).toBe(1)
  expect(exactly(await shown(desk), '⚡')).toBe(0)
  const term = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(140) })
  expect(exactly(await shown(term), '⚡')).toBe(1)
})

// The smallest size: a chat as narrow as about 28 columns. Context goes so that
// both quota figures fit whole instead of being cut at their pills' right edge.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the narrowest chat drops Context and keeps both figures whole`, async ($, on) => {
    mock.clock(on, { now: Date.now() })
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    await $.session.measure({
      context: { tokens: 8, window: 100, percent: 8 },
      rateLimits: [
        { kind: 'seven_day', percentUsed: 6, resetsAt: inHours(15) },
        { kind: 'five_hour', percentUsed: 18, resetsAt: inHours(2) },
      ],
      changed: ['context', 'rateLimits'],
    })
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(30) })
    const words = await shown(ui)
    expect(exactly(words, 'Ctx') + exactly(words, '8%')).toBe(0)
    expect(exactly(words, '94%')).toBe(1)
    expect(exactly(words, '82%')).toBe(1)
  })
}

// The countdowns hold their own width: a squeezed pill shortens its track, and its
// text never wraps onto a second line, which doubled the pill's height.
test('quota text never shrinks, so it never wraps; Weekly shows no minutes', async ($, on) => {
  // one fixed moment for the clock and the reset times alike: reading Date.now()
  // twice let a few milliseconds turn "1h 40m" into "1h 41m" now and then
  const t0 = Date.now()
  const at = (h: number) => new Date(t0 + h * 3600_000).toISOString()
  mock.clock(on, { now: t0 })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 8, window: 100, percent: 8 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 6, resetsAt: at(15.01) },
      { kind: 'five_hour', percentUsed: 20, resetsAt: at(1 + 40 / 60) },
    ],
    changed: ['context', 'rateLimits'],
  })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(140) })
  const words = await shown(ui)
  expect(exactly(words, '15h')).toBe(1)
  expect(like(words, /^15h \d+m$/)).toBe(0)
  expect(exactly(words, '1h 40m')).toBe(1)
  for (const text of ['Weekly', '94%', '15h', '5-hour', '80%', '1h 40m']) {
    const [holder] = await ui.findAll({ type: 'Box', text: new RegExp(`^${text}$`) })
    expect(holder.props.flexShrink).toBe(0)
  }
})

// The row's sides: a SIDE_INSET-wide spacer at each end on the desktop, so the
// gap at the pills' left and right matches the band's gap above them.
test('desktop pads both ends of the row with a drawn spacer; the terminal does not', async ($, on) => {
  mock.clock(on, { now: 0 })
  const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160, scroll: { offset: 0, bodyRows: 20 }, view: {} }
  const desk = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props })
  const spacers = (await desk.findAll({ type: 'Svg' })).filter((s: any) => s.props?.alt === 'spacing')
  expect(spacers.length).toBe(2)
  for (const s of spacers) {
    expect(s.props.width).toBe(SIDE_INSET)
    expect(String(s.props.source)).toContain('<rect')
  }
  const term = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props })
  expect((await term.findAll({ type: 'Svg' })).length).toBe(0)
})
