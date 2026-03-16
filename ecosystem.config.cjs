function buildPaperPaths(profile) {
  return {
    DB_PATH: `data/${profile}/darwin.db`,
    LOG_DIR: `logs/${profile}`,
    TRADES_PATH: `data/${profile}/trades.jsonl`,
    GRAVEYARD_PATH: `data/${profile}/graveyard.jsonl`,
    GENERATION_LOG_PATH: `logs/${profile}/generation_log.jsonl`,
    BANKROLL_PATH: `logs/${profile}/bankroll.jsonl`,
    SIGNAL_SKIPS_PATH: `logs/${profile}/signal_skips.jsonl`,
  }
}

module.exports = {
  apps: [
    {
      name: 'darwin-paper-stable',
      script: 'dist/index.js',
      cwd: __dirname,
      env: {
        DARWIN_MODE: 'paper',
        DARWIN_RESEARCH_MODE: 'false',
        DARWIN_GENERATION_INTERVAL_MIN: process.env.DARWIN_STABLE_GENERATION_INTERVAL_MIN || '60',
        DARWIN_GENERATION_TRADE_THRESHOLD: process.env.DARWIN_STABLE_GENERATION_TRADE_THRESHOLD || '75',
        ...buildPaperPaths('stable'),
      },
    },
    {
      name: 'darwin-paper-research',
      script: 'dist/index.js',
      cwd: __dirname,
      env: {
        DARWIN_MODE: 'paper',
        DARWIN_RESEARCH_MODE: process.env.DARWIN_RESEARCH_MODE || 'true',
        DARWIN_GENERATION_INTERVAL_MIN: process.env.DARWIN_GENERATION_INTERVAL_MIN || '20',
        DARWIN_GENERATION_TRADE_THRESHOLD: process.env.DARWIN_GENERATION_TRADE_THRESHOLD || '25',
        ...buildPaperPaths('research'),
      },
    },
    {
      name: 'darwin-live',
      script: 'dist/index.js',
      cwd: __dirname,
      autostart: false,
      env: {
        DARWIN_MODE: 'live',
        LIVE_TRADE_SIZE_SOL: process.env.LIVE_TRADE_SIZE_SOL || '0.001',
      },
    },
    {
      name: 'darwin-autoresearch',
      script: 'meta_agent.py',
      cwd: __dirname,
      interpreter: 'python3',
      env: {
        AUTORESEARCH_TARGET_APP: 'darwin-paper-research',
        DB_PATH: 'data/research/darwin.db',
      },
    },
  ],
}
