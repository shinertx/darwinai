// ============================================================================
// FitnessScorer — compatibility wrapper around the shared mission assessment
// ============================================================================

import { ClosedTrade, FitnessScore } from '../types'
import { assessTrades } from './MissionAssessment'

export class FitnessScorer {
  public score(
    strategyId: string,
    genomeId: string,
    trades: ClosedTrade[],
    startedAt: number
  ): FitnessScore {
    return assessTrades({
      strategyId,
      genomeId,
      trades,
      startedAt,
    })
  }
}
