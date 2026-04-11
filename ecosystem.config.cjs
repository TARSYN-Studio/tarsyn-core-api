module.exports = {
  apps: [{
    name:               'tarsyn-api',
    script:             'src/index.js',
    cwd:                '/var/www/tarsyn-core/api',
    instances:          1,
    exec_mode:          'fork',
    autorestart:        true,
    watch:              false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
    },
    error_file:  '/var/log/tarsyn-api/error.log',
    out_file:    '/var/log/tarsyn-api/out.log',
    merge_logs:  true,
    time:        true,
  }],
};
