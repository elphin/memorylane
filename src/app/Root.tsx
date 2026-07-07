// v2-entry. Tijdens fase 4 toont dit de render-perf-harness; latere fases
// vervangen dit door de echte tijdlijn-app (L0–L3) op de Rust-backend.

import { PerfHarness } from '../render/harness/PerfHarness'

export default function Root() {
  return <PerfHarness />
}
