export type DarwinMode = 'paper' | 'live'

export interface RuntimeConfig {
  mode: DarwinMode
  warnings: string[]
  liveEnvErrors: string[]
}

const LEGACY_MODE_KEYS = ['PAPER_TRADING', 'PAPER_TRADE'] as const

function parseMode(value?: string): DarwinMode | null {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'paper' || normalized === 'live') {
    return normalized
  }
  return null
}

function parseLegacyMode(key: string, value: string | undefined, warnings: string[]): DarwinMode | null {
  if (value == null || value.trim() === '') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') {
    return 'paper'
  }
  if (normalized === 'false') {
    return 'live'
  }

  warnings.push(`Ignoring invalid legacy ${key}="${value}". Expected "true" or "false".`)
  return null
}

export function getPrimaryRpcUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.RPC_URLS || env.RPC_URL || '')
    .split(',')
    .map((entry) => entry.trim())
    .find(Boolean)

  return value || null
}

export function getLiveEnvErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  const errors: string[] = []

  if (!getPrimaryRpcUrl(env)) {
    errors.push('RPC_URL or RPC_URLS')
  }

  if (!(env.PRIVATE_KEY || '').trim()) {
    errors.push('PRIVATE_KEY')
  }

  return errors
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const warnings: string[] = []
  const explicitMode = parseMode(env.DARWIN_MODE)

  if (env.DARWIN_MODE && !explicitMode) {
    warnings.push(`Ignoring invalid DARWIN_MODE="${env.DARWIN_MODE}". Expected "paper" or "live".`)
  }

  const legacyModes: Array<{ key: (typeof LEGACY_MODE_KEYS)[number]; mode: DarwinMode }> = []
  for (const key of LEGACY_MODE_KEYS) {
    const mode = parseLegacyMode(key, env[key], warnings)
    if (mode) {
      legacyModes.push({ key, mode })
    }
  }

  if (explicitMode) {
    if (legacyModes.length > 0) {
      warnings.push('DARWIN_MODE is set; legacy PAPER_TRADING/PAPER_TRADE values are ignored.')
    }

    return {
      mode: explicitMode,
      warnings,
      liveEnvErrors: explicitMode === 'live' ? getLiveEnvErrors(env) : [],
    }
  }

  if (legacyModes.length === 0) {
    return { mode: 'paper', warnings, liveEnvErrors: [] }
  }

  const uniqueModes = new Set(legacyModes.map((entry) => entry.mode))
  if (uniqueModes.size > 1) {
    warnings.push('Conflicting legacy PAPER_TRADING/PAPER_TRADE values detected. Defaulting to DARWIN_MODE=paper for safety.')
    return { mode: 'paper', warnings, liveEnvErrors: [] }
  }

  warnings.push(`Legacy mode compatibility is active via ${legacyModes.map((entry) => entry.key).join(', ')}. Set DARWIN_MODE explicitly to remove this warning.`)

  const mode = legacyModes[0].mode
  return {
    mode,
    warnings,
    liveEnvErrors: mode === 'live' ? getLiveEnvErrors(env) : [],
  }
}
