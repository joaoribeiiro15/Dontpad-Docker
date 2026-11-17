// Leitura e validação das variáveis de ambiente (secção 10.3 da especificação).

function int(env, name, fallback, min) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} tem de ser um inteiro, recebido "${raw}"`);
  const value = Number(raw.trim());
  if (value < min) throw new Error(`${name} tem de ser >= ${min}, recebido ${value}`);
  return value;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} tem de ser true ou false, recebido "${raw}"`);
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    port: int(env, 'PORT', 3000, 0),
    host: env.HOST || '0.0.0.0',
    appName: (env.APP_NAME || 'openpad').trim() || 'openpad',
    dbPath: env.DB_PATH || './data/openpad.db',
    syncIntervalMs: int(env, 'SYNC_INTERVAL_MS', 5000, 100),
    requestTimeoutMs: int(env, 'REQUEST_TIMEOUT_MS', 10000, 100),
    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 1048576, 1),
    maxDepth: int(env, 'MAX_DEPTH', 10, 1),
    rateLimitPerMin: int(env, 'RATE_LIMIT_PER_MIN', 120, 1),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    logLevel: env.LOG_LEVEL || 'info',
  });
}
