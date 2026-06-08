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

function buildMetaObserverPaths() {
  return {
    PUMPSWAP_META_OUTPUT_DIR: 'data/meta-observer',
    PUMPSWAP_META_LOG_DIR: 'logs/meta-observer',
    PUMPSWAP_CYBORG_ALERT_WINDOW_MS: process.env.PUMPSWAP_CYBORG_ALERT_WINDOW_MS || '5000',
    PUMPSWAP_CYBORG_MAX_BUY_COMPETITORS: process.env.PUMPSWAP_CYBORG_MAX_BUY_COMPETITORS || '0',
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
      autorestart: false,
      stop_exit_codes: [0],
      env: {
        DARWIN_MODE: 'live',
        LIVE_TRADE_SIZE_SOL: process.env.LIVE_TRADE_SIZE_SOL || '0.001',
      },
    },
    {
      name: 'darwin-live-canary',
      script: 'dist/index.js',
      cwd: __dirname,
      autostart: false,
      autorestart: false,
      max_restarts: 0,
      stop_exit_codes: [0],
      out_file: 'logs/live-canary.pm2.out.log',
      error_file: 'logs/live-canary.pm2.error.log',
      env: {
        DARWIN_MODE: 'live',
        LIVE_TRADE_SIZE_SOL: process.env.LIVE_TRADE_SIZE_SOL || '0.0001',
        DARWIN_LIVE_MAX_NEW_ENTRIES: '1',
        DARWIN_LIVE_AUTO_STOP_AFTER_ENTRY: 'true',
        DB_PATH: 'data/live-canary/darwin.db',
        LOG_DIR: 'logs/live-canary',
        TRADES_PATH: 'data/live-canary/trades.jsonl',
        GRAVEYARD_PATH: 'data/live-canary/graveyard.jsonl',
        GENERATION_LOG_PATH: 'logs/live-canary/generation_log.jsonl',
        BANKROLL_PATH: 'logs/live-canary/bankroll.jsonl',
        SIGNAL_SKIPS_PATH: 'logs/live-canary/signal_skips.jsonl',
      },
    },
    {
      name: 'darwin-autoresearch',
      script: 'meta_agent.py',
      cwd: __dirname,
      interpreter: 'python3',
      env: {
        AUTORESEARCH_TARGET_APP: 'darwin-paper-research',
        AUTORESEARCH_ENABLE_SWARM: process.env.AUTORESEARCH_ENABLE_SWARM || 'false',
        AUTORESEARCH_RUNNER_ID: process.env.AUTORESEARCH_RUNNER_ID || 'darwin-runner-1',
        AUTORESEARCH_COORD_BRANCH: process.env.AUTORESEARCH_COORD_BRANCH || 'swarm/state',
        AUTORESEARCH_RESEARCH_BRANCH: process.env.AUTORESEARCH_RESEARCH_BRANCH || 'research/current',
        AUTORESEARCH_PUSH_REMOTE: process.env.AUTORESEARCH_PUSH_REMOTE || 'origin',
        AUTORESEARCH_COORD_WORKTREE: process.env.AUTORESEARCH_COORD_WORKTREE || '',
        AUTORESEARCH_CLAIM_TTL_MIN: process.env.AUTORESEARCH_CLAIM_TTL_MIN || '45',
        AUTORESEARCH_CLAIM_HEARTBEAT_MIN: process.env.AUTORESEARCH_CLAIM_HEARTBEAT_MIN || '5',
        AUTORESEARCH_SYNC_EVERY_EXPERIMENTS: process.env.AUTORESEARCH_SYNC_EVERY_EXPERIMENTS || '1',
        DB_PATH: 'data/research/darwin.db',
      },
    },
    {
      name: 'darwin-pumpswap-meta-observer',
      script: 'dist/cli/pumpswapMetaObserver.js',
      cwd: __dirname,
      stop_exit_codes: [0],
      out_file: 'logs/meta-observer.out.log',
      error_file: 'logs/meta-observer.error.log',
      env: {
        DARWIN_MODE: 'paper',
        ...buildMetaObserverPaths(),
      },
    },
    {
      name: 'darwin-replay-gate-monitor',
      script: 'dist/cli/pumpswapReplayGateMonitor.js',
      cwd: __dirname,
      autostart: false,
      stop_exit_codes: [0],
      out_file: 'logs/replay-gate-monitor.out.log',
      error_file: 'logs/replay-gate-monitor.error.log',
      env: {
        DARWIN_MODE: 'paper',
        PUMPSWAP_META_OUTPUT_DIR: 'data/meta-observer',
        PUMPSWAP_REPLAY_GATE_MONITOR_INTERVAL_MS: process.env.PUMPSWAP_REPLAY_GATE_MONITOR_INTERVAL_MS || '600000',
        PUMPSWAP_REPLAY_GATE_MONITOR_MIN_EVENT_GROWTH_BYTES: process.env.PUMPSWAP_REPLAY_GATE_MONITOR_MIN_EVENT_GROWTH_BYTES || '25000000',
        PUMPSWAP_REPLAY_GATE_MONITOR_RUN_ON_START: process.env.PUMPSWAP_REPLAY_GATE_MONITOR_RUN_ON_START || 'false',
      },
    },
  ],
}
