import { test, expect, mock } from 'claude-code/testing'

import { resetText, quotaTone, contextTone, ringSvg, RING_SIZE, RING_STROKE, trackSvg, fitLevel, layoutFor, rowWidth, LEVELS, TRACK_HEIGHT, SIDE_INSET } from '../hooks/register'
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
    expect(exactly(words, 't/s')).toBe(1)
  })

  test(`${surface}: the narrow size drops Ctx but keeps the Wk and 5h labels`, async ($, on) => {
    mock.clock(on, { now: Date.now() })
    // the widest row the narrow size is chosen at, with no data yet
    const none = { weekly: ['—', '—', '—'], five: ['—', '—', '—'], speed: '—', context: '—' }
    let columns = 160
    while (columns > 0 && fitLevel(columns, surface === 'terminal', none) !== LEVELS - 2) columns--
    expect(columns > 0).toBe(true)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(columns) })
    const words = await shown(ui)
    expect(exactly(words, 'Wk')).toBe(1)
    expect(exactly(words, '5h')).toBe(1)
    expect(exactly(words, 'Ctx')).toBe(0)
  })
}

// On the desktop each quota reading's track is a small SVG of its own, 3px
// tall with fully rounded ends.
test('desktop draws a rounded 3px track in each quota reading', async ($, on) => {
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
  expect(svg.includes('height="3"')).toBe(true)
  expect(svg.includes('rx="1.5"')).toBe(true)
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
  const xl = layoutFor(1)
  expect(xl.shortLabels && xl.reset && !xl.compactReset && xl.speedUnit === 'tok/s' && !xl.ring).toBe(true)
  const l = layoutFor(2)
  expect(l.compactReset && l.speedUnit === 't/s' && !l.ring).toBe(true)
  expect(fitLevel(widthAt(LEVELS - 1), true, texts)).toBe(LEVELS - 1)
})

// Seven sizes, as designed in the live breakpoint page: each from its breakpoint
// (in bar columns) where its content fits, giving things up widest to narrowest.
test('seven sizes, each giving up the next thing', () => {
  expect(LEVELS).toBe(7)
  const ladder = Array.from({ length: LEVELS }, (_, i) => layoutFor(i))
  expect(ladder.map(L => L.name)).toEqual(['XXL', 'XL', 'L', 'M', 'S', 'XS', 'XXS'])
  expect(ladder.map(L => L.minColumns)).toEqual([78, 65, 54, 48, 0, 0, 0])
  expect(ladder.map(L => L.ring)).toEqual([false, false, false, true, true, true, true])
  expect(ladder.map(L => L.reset)).toEqual([true, true, true, false, false, false, false])
  expect(ladder.map(L => L.compactReset)).toEqual([false, false, true, false, false, false, false])
  expect(ladder.map(L => L.speed)).toEqual([true, true, true, true, false, false, false])
  expect(ladder.slice(0, 4).map(L => L.speedUnit)).toEqual(['token/s', 'tok/s', 't/s', 't/s'])
  expect(ladder.map(L => L.context)).toEqual([true, true, true, true, true, false, false])
  expect(ladder.slice(0, 5).map(L => L.contextLabel)).toEqual(['Context', 'Ctx', 'Ctx', 'Ctx', 'Ctx'])
  expect(ladder.map(L => L.quotaLabels)).toEqual([true, true, true, true, true, true, false])
  expect(ladder.map(L => L.shortLabels)).toEqual([false, true, true, true, true, true, false])
  // nothing is ever given up and then taken back lower down
  for (const key of ['reset', 'speed', 'quotaLabels', 'context'] as const) {
    const kept = ladder.map(L => L[key])
    expect(kept.slice(1).every((v, i) => !(v && !kept[i]))).toBe(true)
  }
})

test('each size waits for its breakpoint even where it would fit', () => {
  const none = { weekly: ['—', '—', '—'], five: ['—', '—', '—'], speed: '—', context: '—' }
  for (const isTerminal of [true, false]) {
    expect(fitLevel(78, isTerminal, none)).toBe(0)
    expect(fitLevel(77, isTerminal, none)).toBe(1)
    expect(fitLevel(65, isTerminal, none)).toBe(1)
    expect(fitLevel(64, isTerminal, none)).toBe(2)
  }
})

test('Context goes before the Wk and 5h labels, which only the narrowest drops', () => {
  expect(layoutFor(LEVELS - 2).context).toBe(false)
  expect(layoutFor(LEVELS - 2).quotaLabels).toBe(true)
  expect(layoutFor(LEVELS - 1).quotaLabels).toBe(false)
  for (let level = 0; level < LEVELS - 2; level++) {
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

test('quota readings show their figures with no padding in the text, parts spaced by the gap', async ($, on) => {
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
  // the parts sit straight in the reading, spaced by its one-cell gap alone: no
  // fixed-width box around any of them to leave spare room in that gap
  const sized = (await ui.findAll({ type: 'Box' })).filter((b: any) => typeof b.props.width === 'number')
  expect(sized.length).toBe(0)
})

test('the smaller size keeps token speed as t/s and Context', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(55) })
  expect((await ui.findAll({ type: 'Text', text: /^t\/s$/ })).length).toBe(1)
  expect((await ui.findAll({ type: 'Text', text: /tok/ })).length).toBe(0)
  expect((await ui.findAll({ type: 'Text', text: /^Ctx$/ })).length).toBe(1)
})

// M and below draw a 13px ring with a 2px line for each quota on the desktop,
// coloured as the track; XXL, XL and L keep tracks, as does the terminal.
test('desktop draws rings from M down, tracks above and on the terminal', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 10, window: 100, percent: 10 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 85, resetsAt: inHours(50) },
      { kind: 'five_hour', percentUsed: 95, resetsAt: inHours(1) },
    ],
    changed: ['context', 'rateLimits'],
  })
  const t = { weekly: ['15%', '2d 2h', '2d'], five: ['5%', '1h 0m', '1h'], speed: '—', context: '10%' }
  for (let level = 0; level < LEVELS; level++) {
    let columns = 160
    while (columns > 0 && fitLevel(columns, false, t) !== level) columns--
    expect(columns > 0).toBe(true)
    // the desktop's own side spacers are three cells of the band's columns
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(columns + 3) })
    const rings = (await ui.findAll({ type: 'Svg' })).map((s: any) => String(s.props.source)).filter(src => src.includes('<circle'))
    expect(rings.length).toBe(layoutFor(level).ring ? 2 : 0)
    if (rings.length) {
      expect(rings.every(r => r.includes(`width="${RING_SIZE}"`) && r.includes(`stroke-width="${RING_STROKE}"`))).toBe(true)
      expect(rings.some(r => r.includes('#e3b341'))).toBe(true)
      expect(rings.some(r => r.includes('#e54d4d'))).toBe(true)
    }
  }
  const term = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(40) })
  expect((await term.findAll({ type: 'Svg' })).length).toBe(0)
})

test('ring svg geometry', () => {
  const full = ringSvg(100, 'normal')
  expect(full.includes('r="5.5"')).toBe(true)
  expect(full.includes('stroke-dasharray="34.56 34.56"')).toBe(true)
  expect(ringSvg(0, 'normal').includes('stroke-dasharray')).toBe(false)
  expect(ringSvg(null, 'normal').includes('stroke-dasharray')).toBe(false)
  expect(ringSvg(5, 'low').includes('#e54d4d')).toBe(true)
})

// No container: no reading has a border, padding or fill of its own. A divider
// sits between each two readings (three with all four shown), and inside a
// reading the parts are one cell apart with no fixed-width slot around any.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: readings sit in one open row, a divider between each two`, async ($, on) => {
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
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(140) })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.filter((b: any) => b.props.borderStyle !== undefined).length).toBe(0)
    expect(boxes.filter((b: any) => b.props.backgroundColor !== undefined).length).toBe(0)
    const dividers = surface === 'desktop'
      ? (await ui.findAll({ type: 'Svg' })).filter((s: any) => s.props.alt === 'divider')
      : (await ui.findAll({ type: 'Text' })).filter((t: any) => t.text === '│')
    expect(dividers.length).toBe(3)
    for (const key of ['weekly', 'five-hour', 'speed', 'context']) {
      const [r] = boxes.filter((b: any) => b.key === key || b.props.key === key)
      expect(r!.props.columnGap).toBe(1)
      expect(r!.props.paddingX).toBeUndefined()
    }
  })
}

test('S gives up token speed but keeps Context', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  const none = { weekly: ['—', '—', '—'], five: ['—', '—', '—'], speed: '—', context: '—' }
  for (const isTerminal of [true, false]) {
    let columns = 160
    while (columns > 0 && fitLevel(columns, isTerminal, none) !== 4) columns--
    expect(columns > 0).toBe(true)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: isTerminal ? 'terminal' : 'desktop', component: 'AbovePrompt', props: props(columns) })
    const words = await shown(ui)
    expect(exactly(words, 'Ctx')).toBe(1)
    expect(exactly(words, 't/s')).toBe(0)
    expect(exactly(words, 'Wk')).toBe(1)
  }
})

test('one fewer divider for each reading a narrow row gives up', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  // the narrow size: no token speed and no Context, so one divider is left
  const none = { weekly: ['—', '—', '—'], five: ['—', '—', '—'], speed: '—', context: '—' }
  let columns = 160
  while (columns > 0 && fitLevel(columns, true, none) !== LEVELS - 2) columns--
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(columns) })
  expect((await ui.findAll({ type: 'Text' })).filter((t: any) => t.text === '│').length).toBe(1)
})

test('a low quota colours its figure as well as its track; Context warns as it fills', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 85, window: 100, percent: 85 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 30, resetsAt: inHours(50) },
      { kind: 'five_hour', percentUsed: 95, resetsAt: inHours(1) },
    ],
    changed: ['context', 'rateLimits'],
  })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(140) })
  const [low] = await ui.findAll({ type: 'Text', text: /^\u2007?5%$/ })
  expect(low!.props.color).toBe('error')
  const [fine] = await ui.findAll({ type: 'Text', text: /^70%$/ })
  expect(fine!.props.color).toBeUndefined()
  const [ctx] = await ui.findAll({ type: 'Text', text: /^85%$/ })
  expect(ctx!.props.color).toBe('warning')
  expect(contextTone(80)).toBe('warning')
  expect(contextTone(90)).toBe('low')
  expect(contextTone(79)).toBe('normal')
})

// The desktop's bolt is a drawing, whose ink starts exactly at the reading's edge;
// the ⚡ emoji's own side bearings set its ink 3px further in than any other reading's text.
test('desktop draws the bolt as an SVG; the terminal keeps the ⚡ character', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  const desk = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(140) })
  const bolts = (await desk.findAll({ type: 'Svg' })).filter((s: any) => s.props.alt === 'token speed')
  expect(bolts.length).toBe(1)
  expect(exactly(await shown(desk), '⚡')).toBe(0)
  const term = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props(140) })
  expect(exactly(await shown(term), '⚡')).toBe(1)
})

// The smallest size: a chat as narrow as about 26 columns. Context goes so that
// both quota figures fit whole instead of being cut at the row's right edge.
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
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(26) })
    const words = await shown(ui)
    expect(exactly(words, 'Ctx') + exactly(words, '8%')).toBe(0)
    expect(exactly(words, '94%')).toBe(1)
    expect(exactly(words, '82%')).toBe(1)
  })
}

// The countdowns hold their own width: a squeezed reading shortens its track, and its
// text never wraps onto a second line, which doubled the row's height.
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
    expect(holder!.props.flexShrink).toBe(0)
  }
})

// The row's sides: a SIDE_INSET-wide spacer at each end on the desktop, so the
// first and last reading sit one divider gap from the band's edge.
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
