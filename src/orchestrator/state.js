/**
 * Session state persistence for the ODD Orchestrator.
 *
 * Stores orchestrator state to ~/.oddkit/orchestrator-state.json
 * with session continuity and staleness detection.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createModeState } from "./mode.js";

const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get the oddkit state directory.
 * Respects ODDKIT_STATE_DIR env var for test isolation.
 */
function getStateDir() {
  if (process.env.ODDKIT_STATE_DIR) {
    return process.env.ODDKIT_STATE_DIR;
  }
  return join(homedir(), ".oddkit");
}

/**
 * Ensure the state directory exists.
 */
function ensureStateDir() {
  const stateDir = getStateDir();
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Get the path to orchestrator-state.json
 */
function getOrchestratorStatePath() {
  return join(getStateDir(), "orchestrator-state.json");
}

/**
 * Create a fresh orchestrator state.
 */
function createFreshState() {
  return {
    session_id: `session-${Date.now()}`,
    mode: createModeState("discovery"),
    pending_captures: [],
    last_action: null,
    last_updated: new Date().toISOString(),
  };
}

/**
 * Check if state is stale (older than SESSION_MAX_AGE_MS).
 */
function isStale(state) {
  if (!state.last_updated) return true;
  const age = Date.now() - new Date(state.last_updated).getTime();
  return age > SESSION_MAX_AGE_MS;
}

/**
 * Load orchestrator state or create fresh if none exists or stale.
 */
export function loadOrchestratorState() {
  const path = getOrchestratorStatePath();

  if (!existsSync(path)) {
    return createFreshState();
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const state = JSON.parse(raw);

    if (isStale(state)) {
      return createFreshState();
    }

    return state;
  } catch {
    return createFreshState();
  }
}

/**
 * Save orchestrator state.
 */
export function saveOrchestratorState(state) {
  ensureStateDir();
  const path = getOrchestratorStatePath();
  state.last_updated = new Date().toISOString();
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Reset orchestrator state to fresh.
 */
export function resetOrchestratorState() {
  const fresh = createFreshState();
  saveOrchestratorState(fresh);
  return fresh;
}

/**
 * Check if orchestrator state exists.
 */
export function hasOrchestratorState() {
  return existsSync(getOrchestratorStatePath());
}
