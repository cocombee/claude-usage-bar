export type Window = { percentUsed: number; resetsAt?: string }
// Credit for plans without a 5-hour window, every open source added up (promo
// credit, Claude Code and Cowork credit, bought credit): what is left and, where
// every source has one, their limits together; in whole currency units.
export type Credit = { left: number; limit: number | null; currency: string }
export type Usage = { fiveHour: Window | null; weekly: Window | null; credit: Credit | null; context: number | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { usage: Usage | null; speed: number | null; tick: number; plan: boolean | null }
  }
}
