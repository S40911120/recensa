'use strict';
// Structured logger for container stdout/stderr — readable, greppable `docker logs`.
// Line format:  2026-07-12T09:15:00.123Z  INFO  [scope] message
// Level via LOG_LEVEL env (debug|info|warn|error; default info). warn/error → stderr.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, name, msg) {
  if (LEVELS[level] < THRESHOLD) return;
  const line = `${new Date().toISOString()}  ${level.toUpperCase().padEnd(5)} [${name}] ${msg}\n`;
  if (level === 'warn' || level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

/** Scoped logger: const log = require('../log').scope('index'); log.info('sync done'). */
function scope(name) {
  return {
    debug: (m) => emit('debug', name, m),
    info: (m) => emit('info', name, m),
    warn: (m) => emit('warn', name, m),
    error: (m) => emit('error', name, m),
  };
}

module.exports = { scope };
