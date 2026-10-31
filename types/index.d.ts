export type Window = { percentUsed: number; resetsAt?: string }
// Extra-usage credit for plans without a 5-hour window: what is used of the
// month's limit (0–100, null with no limit), and the amounts in minor units.
// `balance`: credit bought and not yet spent, where the plan reports one. Amounts
// are in units of 10^-exponent of `currency` (cents for USD).
export type Credit = { percentUsed: number | null; used: number | null; limit: number | null; balance?: number | null; exponent?: number; currency: string }
export type Usage = { fiveHour: Window | null; weekly: Window | null; credit: Credit | null; context: number | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { usage: Usage | null; speed: number | null; tick: number; plan: boolean | null }
  }
}
