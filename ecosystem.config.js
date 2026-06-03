// PM2 process definition. Runs the compiled worker (dist/index.js).
// Build first with `npm run build`, then `pm2 start ecosystem.config.js`.
module.exports = {
  apps: [
    {
      name: 'twitter-follow-tracker',
      script: 'dist/index.js',
      // The worker loops internally on POLL_INTERVAL_MINUTES, so a single
      // long-lived instance is correct. Restart on crash, not on exit-0.
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
