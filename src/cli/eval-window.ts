import dotenv from 'dotenv'
import path from 'path'
import { evaluateTradeWindow, formatAssessmentForOutput } from '../evaluation/EvalWindow'

dotenv.config()
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

function main(): void {
  const sinceArg = process.argv[2] || '0'
  const sinceTsMs = Number.parseInt(sinceArg, 10)
  if (!Number.isFinite(sinceTsMs) || sinceTsMs < 0) {
    console.error('Usage: npm run eval-window -- <since_timestamp_ms>')
    process.exit(1)
  }

  const assessment = evaluateTradeWindow({ sinceTsMs })
  process.stdout.write(JSON.stringify(formatAssessmentForOutput(assessment), null, 2) + '\n')
}

main()
