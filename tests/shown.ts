// What the bar shows, whichever surface drew it.
//
// Both surfaces draw the pills as Boxes of Text, so the words are Text nodes; the
// desktop's tracks are small SVGs with no words in them. Words drawn inside an
// Svg's source (`<text>` nodes) are read too, so a drawing that moves text into an
// SVG is still seen rather than quietly read as empty.

const ENTITIES: [RegExp, string][] = [[/&lt;/g, '<'], [/&gt;/g, '>'], [/&amp;/g, '&']]
const FIGURE_SPACE = / /g

const unescape = (s: string) => ENTITIES.reduce((t, [re, c]) => t.replace(re, c), s)

/** Every string the bar put on screen, in document order, padding removed. */
export async function shown(ui: any): Promise<string[]> {
  const svgs = await ui.findAll({ type: 'Svg' })
  const drawn = svgs.flatMap((svg: any) =>
    [...String(svg.props?.source ?? '').matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
      .map(m => unescape(m[1])),
  )
  const typed = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text ?? ''))
  return [...drawn, ...typed].map(s => s.replace(FIGURE_SPACE, '')).filter(s => s !== '')
}

/** Matches a string exactly and a RegExp by test — the whole shown item, not a substring. */
export const exactly = (list: string[], q: string | RegExp) =>
  list.filter(s => (typeof q === 'string' ? s === q : q.test(s))).length

/** Matches a string by inclusion and a RegExp by test, as ElementQuery's `text` does. */
export const like = (list: string[], q: string | RegExp) =>
  list.filter(s => (typeof q === 'string' ? s.includes(q) : q.test(s))).length
