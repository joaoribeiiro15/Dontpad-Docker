// Reads and validates the environment variables.

function int(env, name, fallback, min) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be an integer, got "${raw}"`);
  const value = Number(raw.trim());
  if (value < min) throw new Error(`${name} must be >= ${min}, got ${value}`);
  return value;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    port: int(env, 'PORT', 3000, 0),
    host: env.HOST || '0.0.0.0',
    appName: (env.APP_NAME || 'openpad').trim() || 'openpad',
    dbPath: env.DB_PATH || './data/openpad.db',
    /** Fallback polling interval, used only while the live connection is down. */
    syncIntervalMs: int(env, 'SYNC_INTERVAL_MS', 5000, 100),
    requestTimeoutMs: int(env, 'REQUEST_TIMEOUT_MS', 10000, 100),
    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 1048576, 1),
    maxDepth: int(env, 'MAX_DEPTH', 10, 1),
    rateLimitPerMin: int(env, 'RATE_LIMIT_PER_MIN', 600, 1),
    maxStreamsPerIp: int(env, 'MAX_STREAMS_PER_IP', 20, 1),
    /** Shared files live in memory only and expire after FILE_TTL_MS. */
    maxFileBytes: int(env, 'MAX_FILE_BYTES', 10 * 1024 * 1024, 1),
    maxFilesPerPage: int(env, 'MAX_FILES_PER_PAGE', 20, 1),
    maxFilesTotalBytes: int(env, 'MAX_FILES_TOTAL_BYTES', 256 * 1024 * 1024, 1),
    fileTtlMs: int(env, 'FILE_TTL_MS', 6 * 60 * 60 * 1000, 1000),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    logLevel: env.LOG_LEVEL || 'info',
  });
}
