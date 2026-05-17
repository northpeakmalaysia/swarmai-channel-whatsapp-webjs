import {
  mkdirSync,
  existsSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { logger } from '@swarmai/shared';
import { resolveWorkspaceRoot } from '@swarmai/memory';

/**
 * Session-store helpers for the Web.js adapter.
 *
 * whatsapp-web.js' `LocalAuth` strategy persists the WhatsApp Web
 * session by giving puppeteer a writable Chromium user-data-dir.
 * Inside that dir, LocalAuth creates a `session-<clientId>/` subfolder
 * that holds the WA local-storage / IndexedDB content needed to skip
 * re-pairing across restarts.
 *
 * We own:
 *   1. The PARENT user-data-dir path (under `<workspaceRoot>/.swarmai/webjs/profile/`).
 *   2. A `.swarmai-lock` heartbeat that prevents two SwarmAI processes
 *      from sharing a Chromium profile (Chromium itself enforces a
 *      `SingletonLock` but our lock gives a clearer error message).
 *   3. The "is this slot paired?" probe — true when the LocalAuth
 *      session folder exists with at least one entry.
 */

export interface SessionStoreOptions {
  /** Override the base directory (default `<workspaceRoot>/.swarmai/webjs/profile/`). */
  baseDir?: string;
  /** Session identifier — used as the folder name. */
  sessionId: string;
}

export interface SessionStorePaths {
  /** The session directory (`<base>/<sessionId>`). */
  sessionDir: string;
  /** The base directory (`<base>`). */
  baseDir: string;
}

export function resolveSessionPaths(opts: SessionStoreOptions): SessionStorePaths {
  const baseDir =
    opts.baseDir ?? join(resolveWorkspaceRoot(), '.swarmai', 'webjs', 'profile');
  const sessionDir = join(baseDir, sanitiseSessionId(opts.sessionId));
  return { baseDir, sessionDir };
}

export function ensureSessionDir(opts: SessionStoreOptions): SessionStorePaths {
  const paths = resolveSessionPaths(opts);

  if (!existsSync(paths.baseDir)) {
    mkdirSync(paths.baseDir, { recursive: true });
    safeChmod(paths.baseDir, 0o700);
  }
  if (!existsSync(paths.sessionDir)) {
    mkdirSync(paths.sessionDir, { recursive: true });
    safeChmod(paths.sessionDir, 0o700);
  } else {
    safeChmod(paths.sessionDir, 0o700);
  }
  return paths;
}

/**
 * True iff the slot already has a paired WhatsApp Web session. The
 * LocalAuth strategy persists its state at `<sessionDir>/session-<clientId>/`.
 * Probe is best-effort and degrades to false on any FS error.
 */
export function isSessionPaired(sessionDir: string, clientId = 'default'): boolean {
  try {
    const candidate = join(sessionDir, `session-${clientId}`);
    if (!existsSync(candidate)) return false;
    // LocalAuth populates the folder once the QR scan completes. Any
    // entry inside counts as "paired".
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.readdirSync(candidate).length > 0;
  } catch {
    return false;
  }
}

export function sanitiseSessionId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'default';
  const cleaned = trimmed.replace(/[^A-Za-z0-9+._-]/g, '_');
  if (cleaned.includes('..')) return cleaned.replace(/\./g, '_');
  return cleaned || 'default';
}

function safeChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (err) {
    logger.debug(
      { path, err: err instanceof Error ? err.message : String(err) },
      'whatsapp-webjs: chmod skipped (filesystem unsupported)',
    );
  }
}

// ---- Single-instance lockfile ---------------------------------------------

export const LOCK_FILENAME = '.swarmai-lock';

export class SessionLockedError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holder: SessionLockInfo,
  ) {
    super(
      `whatsapp-webjs: session is locked by another process ` +
        `(pid=${holder.pid}, host=${holder.hostname}, ` +
        `last heartbeat ${new Date(holder.heartbeatAt).toISOString()}). ` +
        `If that process is gone, delete ${lockPath} or run \`swarmai whatsapp repair\`.`,
    );
    this.name = 'SessionLockedError';
  }
}

export interface SessionLockInfo {
  pid: number;
  hostname: string;
  startedAt: number;
  heartbeatAt: number;
}

export interface AcquireLockOptions {
  sessionDir: string;
  heartbeatMs?: number;
  staleMs?: number;
  pid?: number;
  hostname?: string;
  now?: () => number;
}

export interface SessionLockHandle {
  path: string;
  info: SessionLockInfo;
  release(): void;
}

export function acquireSessionLock(opts: AcquireLockOptions): SessionLockHandle {
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const staleMs = opts.staleMs ?? 90_000;
  const now = opts.now ?? (() => Date.now());
  const pid = opts.pid ?? process.pid;
  const hostname = opts.hostname ?? safeHostname();
  const lockPath = join(opts.sessionDir, LOCK_FILENAME);

  if (existsSync(lockPath)) {
    const existing = readLockSafely(lockPath);
    if (existing) {
      const age = now() - existing.heartbeatAt;
      const sameProcess = existing.pid === pid && existing.hostname === hostname;
      const sameHost = existing.hostname === hostname;
      const orphanedByDeadPid =
        sameHost && !sameProcess && !isPidAlive(existing.pid);
      if (sameProcess) {
        logger.debug({ lockPath, pid }, 'whatsapp-webjs: re-acquiring lock');
      } else if (orphanedByDeadPid) {
        logger.warn(
          { lockPath, previousPid: existing.pid },
          'whatsapp-webjs: taking over orphaned lock (previous PID dead)',
        );
      } else if (age <= staleMs) {
        throw new SessionLockedError(lockPath, existing);
      } else {
        logger.warn(
          { lockPath, staleAgeMs: age },
          'whatsapp-webjs: taking over stale lock',
        );
      }
    } else {
      logger.warn({ lockPath }, 'whatsapp-webjs: lockfile unreadable — overwriting');
    }
  }

  const info: SessionLockInfo = {
    pid,
    hostname,
    startedAt: now(),
    heartbeatAt: now(),
  };
  writeLock(lockPath, info);

  const timer = setInterval(() => {
    const updated: SessionLockInfo = { ...info, heartbeatAt: now() };
    try {
      writeLock(lockPath, updated);
      info.heartbeatAt = updated.heartbeatAt;
    } catch (err) {
      logger.debug(
        { lockPath, err: err instanceof Error ? err.message : String(err) },
        'whatsapp-webjs: heartbeat write failed (non-fatal)',
      );
    }
  }, heartbeatMs);
  if (typeof timer.unref === 'function') timer.unref();

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch (err) {
      logger.debug(
        { lockPath, err: err instanceof Error ? err.message : String(err) },
        'whatsapp-webjs: unlinkSync(lock) failed (non-fatal)',
      );
    }
  };

  return { path: lockPath, info, release };
}

export function readSessionLock(sessionDir: string): SessionLockInfo | null {
  return readLockSafely(join(sessionDir, LOCK_FILENAME));
}

function readLockSafely(lockPath: string): SessionLockInfo | null {
  try {
    if (!existsSync(lockPath)) return null;
    const raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionLockInfo>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.heartbeatAt !== 'number'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      hostname: parsed.hostname,
      startedAt: parsed.startedAt,
      heartbeatAt: parsed.heartbeatAt,
    };
  } catch {
    return null;
  }
}

function writeLock(lockPath: string, info: SessionLockInfo): void {
  writeFileSync(lockPath, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
}

function safeHostname(): string {
  try {
    return osHostname() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return true;
  }
}
