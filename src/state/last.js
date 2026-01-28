import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Get the oddkit state directory
 */
function getStateDir() {
  return join(homedir(), '.oddkit');
}

/**
 * Get the path to last.json
 */
function getLastPath() {
  return join(getStateDir(), 'last.json');
}

/**
 * Ensure the state directory exists
 */
function ensureStateDir() {
  const stateDir = getStateDir();
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Write the last result to ~/.oddkit/last.json
 */
export function writeLast(result) {
  ensureStateDir();
  const lastPath = getLastPath();
  writeFileSync(lastPath, JSON.stringify(result, null, 2));
}

/**
 * Read the last result from ~/.oddkit/last.json
 * Throws a friendly error if not found
 */
export function readLast() {
  const lastPath = getLastPath();

  if (!existsSync(lastPath)) {
    throw new Error(
      'No last result found. Run `oddkit librarian` or `oddkit validate` first.'
    );
  }

  try {
    const raw = readFileSync(lastPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to read last result: ${err.message}`);
  }
}

/**
 * Check if a last result exists
 */
export function hasLast() {
  return existsSync(getLastPath());
}
