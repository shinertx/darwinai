import dotenv from 'dotenv'
import path from 'path'

// Load main .env
dotenv.config()

// Load local overrides if present
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
} catch (_) {}

import { Orchestrator } from './Orchestrator'

const orch = new Orchestrator()
orch.start().catch((err) => {
  console.error('[Darwin] Fatal error:', err)
  process.exit(1)
})
