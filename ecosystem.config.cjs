module.exports = {
  apps: [
    {
      name: 'darwin-paper',
      script: 'dist/index.js',
      cwd: __dirname,
      env: {
        DARWIN_MODE: 'paper',
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
        AUTORESEARCH_TARGET_APP: 'darwin-paper',
      },
    },
  ],
}
