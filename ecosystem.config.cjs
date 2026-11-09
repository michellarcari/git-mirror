module.exports = {
  apps: [
    {
      name: 'git-mirror-gateway',
      script: 'src/gateway.js',
      cwd: __dirname,
      autorestart: true,
      watch: false,
      exp_backoff_restart_delay: 1000,
      env: { CONFIG_PATH: './config/gateway.json', MIRROR_NODE_ID: 'gateway' }
    },
    {
      name: 'git-mirror-client',
      script: 'src/client.js',
      cwd: __dirname,
      autorestart: true,
      watch: false,
      exp_backoff_restart_delay: 1000,
      env: { CONFIG_PATH: './config/client.json', MIRROR_NODE_ID: 'client' }
    }
  ]
};
