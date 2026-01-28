import { readFileSync, existsSync } from 'fs';
import { writeLast } from '../state/last.js';

// Completion claim patterns
const COMPLETION_PATTERNS = [
  /\b(?:done|finished|completed|shipped|implemented|ready|works|working)\b/i,
  /\b(?:i|we)\s+(?:did|have|finished|completed|shipped|implemented)\b/i,
  /\bpr\s*(?:is\s+)?(?:ready|merged|submitted)\b/i,
];

// Claim type detection
const CLAIM_PATTERNS = {
  ui: [
    /\b(?:ui|interface|visual|screen|page|component|button|form|modal)\b/i,
    /\b(?:css|style|layout|design)\b/i,
  ],
  test: [/\b(?:test|spec|passing|coverage|unit|integration|e2e)\b/i],
  build: [/\b(?:build|deploy|compile|bundle|release)\b/i],
  api: [/\b(?:api|endpoint|route|handler|request|response)\b/i],
  fix: [/\b(?:fix|bug|issue|error|crash|broken)\b/i],
};

// Evidence requirements by claim type
const EVIDENCE_REQUIREMENTS = {
  ui: ["screenshot", "recording", "visual artifact"],
  test: ["test output", "test logs", "coverage report"],
  build: ["build output", "deploy log", "command output"],
  api: ["request/response example", "curl output", "API test"],
  fix: ["reproduction steps", "before/after evidence", "test case"],
  general: ["artifact path", "commit/PR link", "command output"],
};

// Artifact patterns
const ARTIFACT_PATTERNS = [
  /(?:^|\s)([a-zA-Z0-9_\-./]+\.(?:png|jpg|gif|webp|mp4|webm|mov))\b/gi,
  /(?:^|\s)([a-zA-Z0-9_\-./]+\.(?:log|txt|json|md))\b/gi,
  /https?:\/\/[^\s]+/gi,
  /```[\s\S]*?```/g,
];

/**
 * Parse completion claims from message
 */
function parseClaims(message) {
  const claims = [];

  // Check for completion assertion
  const isCompletion = COMPLETION_PATTERNS.some((p) => p.test(message));
  if (!isCompletion) {
    return { isCompletion: false, claims: [], types: [] };
  }

  // Detect claim types
  const types = [];
  for (const [type, patterns] of Object.entries(CLAIM_PATTERNS)) {
    if (patterns.some((p) => p.test(message))) {
      types.push(type);
    }
  }

  // If no specific type detected, mark as general
  if (types.length === 0) {
    types.push("general");
  }

  // Extract the claim text (simplified)
  claims.push(message.trim());

  return { isCompletion: true, claims, types };
}

/**
 * Extract artifacts from message
 */
function extractArtifacts(message) {
  const artifacts = [];
  const seen = new Set();

  for (const pattern of ARTIFACT_PATTERNS) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(message)) !== null) {
      const artifact = match[1] || match[0];
      if (!seen.has(artifact)) {
        seen.add(artifact);
        artifacts.push(artifact);
      }
    }
  }

  return artifacts;
}

/**
 * Load artifacts from file if provided
 */
function loadArtifactsFile(artifactsPath) {
  if (!artifactsPath || !existsSync(artifactsPath)) {
    return [];
  }

  try {
    const raw = readFileSync(artifactsPath, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : data.artifacts || [];
  } catch {
    return [];
  }
}

/**
 * Determine required evidence based on claim types
 */
function getRequiredEvidence(types) {
  const required = new Set();

  for (const type of types) {
    const reqs = EVIDENCE_REQUIREMENTS[type] || EVIDENCE_REQUIREMENTS.general;
    for (const req of reqs) {
      required.add(req);
    }
  }

  return Array.from(required);
}

/**
 * Match provided artifacts to requirements
 */
function matchEvidence(artifacts, required) {
  const matched = [];
  const gaps = [];

  for (const req of required) {
    // Simple matching: check if any artifact seems to fulfill requirement
    const hasMatch = artifacts.some((a) => {
      const lower = a.toLowerCase();
      if (req.includes("screenshot") || req.includes("visual")) {
        return /\.(png|jpg|gif|webp)$/i.test(a);
      }
      if (req.includes("recording") || req.includes("video")) {
        return /\.(mp4|webm|mov)$/i.test(a);
      }
      if (req.includes("log") || req.includes("output")) {
        return /\.(log|txt)$/i.test(a) || /```/.test(a);
      }
      if (req.includes("link") || req.includes("PR")) {
        return /^https?:\/\//.test(a);
      }
      return false;
    });

    if (hasMatch) {
      matched.push(req);
    } else {
      gaps.push(req);
    }
  }

  return { matched, gaps };
}

/**
 * Determine verdict
 */
function determineVerdict(claims, artifacts, matched, gaps) {
  if (claims.length === 0) {
    return "CLARIFY";
  }

  if (artifacts.length === 0) {
    return "NEEDS_ARTIFACTS";
  }

  if (gaps.length === 0) {
    return "PASS";
  }

  if (matched.length > 0) {
    return "NEEDS_ARTIFACTS";
  }

  return "NEEDS_ARTIFACTS";
}

/**
 * Run the validate command
 */
export async function runValidate(options) {
  const { message, artifacts: artifactsPath, repo: repoRoot = process.cwd() } = options;

  // Parse claims
  const { isCompletion, claims, types } = parseClaims(message);

  // Build rules fired
  const rulesFired = [];
  rulesFired.push('VALIDATION_CLAIMS_PARSED');

  if (!isCompletion) {
    rulesFired.push('VALIDATION_NO_COMPLETION_CLAIM');
    rulesFired.push('VALIDATION_CLARIFY');

    const result = {
      verdict: 'CLARIFY',
      claims: [],
      types: [],
      required_evidence: [],
      provided_artifacts: [],
      gaps: [],
      message: 'No completion claim detected in message.',
      debug: {
        tool: 'validate',
        timestamp: new Date().toISOString(),
        repo_root: repoRoot,
        claims_detected_count: 0,
        artifacts_detected_count: 0,
        rules_fired: rulesFired,
        notes: ['No completion keywords found in message'],
      },
    };

    writeLast(result);
    return result;
  }

  // Get required evidence
  const requiredEvidence = getRequiredEvidence(types);

  // Extract artifacts from message
  const messageArtifacts = extractArtifacts(message);

  // Load additional artifacts from file
  const fileArtifacts = loadArtifactsFile(artifactsPath);

  // Combine artifacts
  const allArtifacts = [...new Set([...messageArtifacts, ...fileArtifacts])];

  // Match evidence
  const { matched, gaps } = matchEvidence(allArtifacts, requiredEvidence);

  // Determine verdict
  const verdict = determineVerdict(claims, allArtifacts, matched, gaps);

  // Add verdict-specific rule
  if (verdict === 'PASS') {
    rulesFired.push('VALIDATION_PASS');
  } else if (verdict === 'NEEDS_ARTIFACTS') {
    rulesFired.push('VALIDATION_NEEDS_ARTIFACTS');
  } else if (verdict === 'FAIL') {
    rulesFired.push('VALIDATION_FAIL');
  } else if (verdict === 'CLARIFY') {
    rulesFired.push('VALIDATION_CLARIFY');
  }

  const result = {
    verdict,
    claims,
    types,
    required_evidence: requiredEvidence,
    provided_artifacts: allArtifacts,
    matched_evidence: matched,
    gaps,
    next_steps:
      gaps.length > 0 ? gaps.map((g) => `Provide: ${g}`) : ['All required evidence provided.'],
    debug: {
      tool: 'validate',
      timestamp: new Date().toISOString(),
      repo_root: repoRoot,
      claims_detected_count: claims.length,
      artifacts_detected_count: allArtifacts.length,
      rules_fired: rulesFired,
      notes: [],
    },
  };

  writeLast(result);
  return result;
}
