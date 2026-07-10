// pm2 process config — 24/7 with auto-restart + reboot persistence.
//   pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [{
    name: 'robinarb',
    script: 'arb.js',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 100,
    restart_delay: 5000,
    max_memory_restart: '600M',
    out_file: './logs/out.log',
    error_file: './logs/err.log',
    merge_logs: true,
    time: true,
  }],
}
