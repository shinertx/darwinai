import dotenv from 'dotenv'
import path from 'path'

// Load main .env
dotenv.config()

// Explicit process settings (for example PM2 paper mode) must win over files.
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false })
} catch (_) {}

import { Orchestrator } from './Orchestrator'

async function main(): Promise<void> {
  const orch = new Orchestrator()
  await orch.start()
}

main().catch((err) => {
  console.error('[Darwin] Fatal error:', err)
  process.exit(1)
})
