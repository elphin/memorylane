// v2-entry. Standaard de echte tijdlijn-app; `?perf` toont de render-perf-harness.

import { AppShell } from './AppShell'
import { PerfHarness } from '../render/harness/PerfHarness'

export default function Root() {
  const perf =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('perf')
  return perf ? <PerfHarness /> : <AppShell />
}
