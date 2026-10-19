export type Window = { percentUsed: number; resetsAt?: string }
export type Usage = { fiveHour: Window | null; weekly: Window | null; context: number | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { usage: Usage | null; speed: number | null; tick: number }
  }
}
