/**
 * GitHub API helper for oddkit_write
 *
 * Provides GitHub REST API interactions for writing files to repos.
 * Three tiers:
 *   Tier 1: Contents API (single file)
 *   Tier 2: Git Data API (multi-file atomic commits)
 *   Tier 3: Branches and PRs (layers on top of Tier 1/2)
 *
 * Uses Node.js native fetch (available in Node 18+).
 */

const GITHUB_API_BASE = "https://api.github.com";

/**
 * Get GitHub token from environment
 */
function getGitHubToken() {
  const token = process.env.ODDKIT_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GitHub token not configured. Set ODDKIT_GITHUB_TOKEN environment variable.");
  }
  return token;
}

/**
 * Parse baseline_url to extract owner and repo
 * e.g., https://raw.githubusercontent.com/klappy/klappy.dev/main -> { owner: "klappy", repo: "klappy.dev" }
 */
export function parseBaselineUrl(baselineUrl) {
  let match;

  // Try raw.githubusercontent.com format
  match = baselineUrl.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }

  // Try github.com format
  match = baselineUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }

  throw new Error(`Could not parse owner/repo from baseline_url: ${baselineUrl}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Core request with retry
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Check if an error is a network error (not an HTTP status error).
 * Network errors warrant retry; HTTP 4xx/5xx do not.
 */
function isNetworkError(err) {
  if (err && err.type === "system") return true;
  const msg = err?.message || "";
  return (
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("network") ||
    msg.includes("socket hang up")
  );
}

/**
 * Make authenticated GitHub API request with one retry on network errors.
 *
 * - Retries once on network failures (not on 4xx/5xx).
 * - On 409 Conflict, throws a ConflictError with response details.
 * - On auth/permission errors, throws descriptive messages.
 */
async function githubRequest(endpoint, options = {}) {
  const token = getGitHubToken();
  const url = `${GITHUB_API_BASE}${endpoint}`;

  const fetchOptions = {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  };

  async function attempt() {
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));

      if (response.status === 401) {
        throw new Error("GitHub token is invalid or expired. Check ODDKIT_GITHUB_TOKEN.");
      }
      if (response.status === 403) {
        throw new Error(`Token doesn't have write access. The token needs \`repo\` scope. GitHub says: ${errorBody.message || ""}`);
      }
      if (response.status === 409) {
        const err = new Error(`Conflict: ${errorBody.message || "resource was modified"}`);
        err.status = 409;
        err.body = errorBody;
        throw err;
      }

      throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorBody.message || ""}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  // First attempt
  try {
    return await attempt();
  } catch (err) {
    // Only retry on network errors, not HTTP status errors
    if (isNetworkError(err)) {
      try {
        return await attempt();
      } catch (retryErr) {
        // Final failure — attach the file contents context for callers
        retryErr.retryFailed = true;
        throw retryErr;
      }
    }
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tier 1: Contents API (single file)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Get current file SHA (required for updates via Contents API).
 * Returns null if the file doesn't exist.
 */
export async function getFileSha(owner, repo, path, branch = null) {
  const endpoint = `/repos/${owner}/${repo}/contents/${path}${branch ? `?ref=${branch}` : ""}`;
  try {
    const data = await githubRequest(endpoint);
    return data.sha;
  } catch (err) {
    if (err.message.includes("404")) return null;
    throw err;
  }
}

/**
 * Get current file content and SHA (for conflict resolution).
 * Returns { sha, content } or null if file doesn't exist.
 */
export async function getFileContent(owner, repo, path, branch = null) {
  const endpoint = `/repos/${owner}/${repo}/contents/${path}${branch ? `?ref=${branch}` : ""}`;
  try {
    const data = await githubRequest(endpoint);
    return {
      sha: data.sha,
      content: Buffer.from(data.content, "base64").toString("utf-8"),
    };
  } catch (err) {
    if (err.message.includes("404")) return null;
    throw err;
  }
}

/**
 * Write a single file via Contents API (Tier 1).
 * Supports optional author override.
 */
export async function writeFile(owner, repo, path, content, message, branch = null, sha = null, author = null) {
  const encodedContent = Buffer.from(content, "utf-8").toString("base64");

  const body = { message, content: encodedContent };
  if (sha) body.sha = sha;
  if (branch) body.branch = branch;
  if (author) {
    body.committer = { name: author.name, email: author.email };
    body.author = { name: author.name, email: author.email };
  }

  const endpoint = `/repos/${owner}/${repo}/contents/${path}`;

  try {
    const data = await githubRequest(endpoint, {
      method: "PUT",
      body: JSON.stringify(body),
    });

    return {
      commit_sha: data.commit.sha,
      commit_url: data.commit.html_url,
      file_path: data.content.path,
      sha: data.content.sha,
    };
  } catch (err) {
    // Handle 409 Conflict — file was modified since last read
    if (err.status === 409) {
      const current = await getFileContent(owner, repo, path, branch);
      const conflictErr = new Error("Merge conflict: the file was modified since you last read it.");
      conflictErr.status = 409;
      conflictErr.conflictData = {
        path,
        current_sha: current?.sha || null,
        current_content: current?.content || null,
        your_content: content,
        guidance: "The file was modified since you last read it. Here's the current version — want to merge your changes?",
      };
      throw conflictErr;
    }
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tier 2: Git Data API (multi-file atomic commits)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Get a git ref (branch HEAD SHA).
 * Returns { sha, url } for the ref object.
 */
export async function getRef(owner, repo, branch) {
  const data = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  return {
    sha: data.object.sha,
    url: data.object.url,
  };
}

/**
 * Get a commit's tree SHA.
 */
export async function getCommitTree(owner, repo, commitSha) {
  const data = await githubRequest(`/repos/${owner}/${repo}/git/commits/${commitSha}`);
  return data.tree.sha;
}

/**
 * Create a blob for a file.
 */
export async function createBlob(owner, repo, content, encoding = "utf-8") {
  const data = await githubRequest(`/repos/${owner}/${repo}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content, encoding }),
  });
  return data.sha;
}

/**
 * Create a tree with multiple file entries.
 * @param {string} baseTreeSha - The base tree to build on
 * @param {Array<{path: string, blobSha: string}>} entries - File entries
 */
export async function createTree(owner, repo, baseTreeSha, entries) {
  const tree = entries.map((e) => ({
    path: e.path,
    mode: "100644", // regular file
    type: "blob",
    sha: e.blobSha,
  }));

  const data = await githubRequest(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  return data.sha;
}

/**
 * Create a commit.
 * @param {Object} opts
 * @param {string} opts.treeSha - Tree SHA to commit
 * @param {string[]} opts.parentShas - Parent commit SHAs
 * @param {string} opts.message - Commit message
 * @param {Object} [opts.author] - Optional author { name, email }
 */
export async function createCommit(owner, repo, { treeSha, parentShas, message, author }) {
  const body = {
    message,
    tree: treeSha,
    parents: parentShas,
  };
  if (author) {
    body.author = { name: author.name, email: author.email };
    body.committer = { name: author.name, email: author.email };
  }

  const data = await githubRequest(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    sha: data.sha,
    url: data.html_url,
  };
}

/**
 * Update a branch ref to point to a new commit.
 * Handles 409 conflict (branch was updated concurrently).
 */
export async function updateRef(owner, repo, branch, commitSha) {
  try {
    await githubRequest(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commitSha, force: false }),
    });
  } catch (err) {
    if (err.status === 409) {
      const conflictErr = new Error("Merge conflict: the branch was updated since the commit was created.");
      conflictErr.status = 409;
      conflictErr.conflictData = {
        branch,
        attempted_sha: commitSha,
        guidance: "The branch was updated concurrently. Fetch the latest and retry.",
      };
      throw conflictErr;
    }
    throw err;
  }
}

/**
 * Perform an atomic multi-file commit via the Git Data API.
 *
 * Flow:
 *   1. GET ref → commit SHA → tree SHA
 *   2. Create blobs for each file
 *   3. Create new tree with all blobs
 *   4. Create commit pointing to new tree
 *   5. Update branch ref
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {Array<{path: string, content: string}>} files
 * @param {string} message - Commit message
 * @param {Object} [author] - Optional { name, email }
 * @returns {{ commit_sha, commit_url }}
 */
export async function atomicMultiFileCommit(owner, repo, branch, files, message, author = null) {
  // 1. Get current branch ref and tree
  const ref = await getRef(owner, repo, branch);
  const treeSha = await getCommitTree(owner, repo, ref.sha);

  // 2. Create blobs for all files
  const entries = [];
  for (const file of files) {
    const blobSha = await createBlob(owner, repo, file.content);
    entries.push({ path: file.path, blobSha });
  }

  // 3. Create new tree
  const newTreeSha = await createTree(owner, repo, treeSha, entries);

  // 4. Create commit
  const commit = await createCommit(owner, repo, {
    treeSha: newTreeSha,
    parentShas: [ref.sha],
    message,
    author,
  });

  // 5. Update ref
  await updateRef(owner, repo, branch, commit.sha);

  return {
    commit_sha: commit.sha,
    commit_url: commit.url,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tier 3: Branches and PRs
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Get the default branch name for a repo.
 */
export async function getDefaultBranch(owner, repo) {
  const data = await githubRequest(`/repos/${owner}/${repo}`);
  return data.default_branch;
}

/**
 * Check if a branch exists.
 */
export async function branchExists(owner, repo, branch) {
  try {
    await githubRequest(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    return true;
  } catch (err) {
    if (err.message.includes("404")) return false;
    throw err;
  }
}

/**
 * Get the HEAD commit SHA for a branch.
 */
export async function getBranchSha(owner, repo, branch) {
  const data = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  return data.object.sha;
}

/**
 * Create a new branch from a ref.
 */
export async function createBranch(owner, repo, branchName, sourceSha) {
  await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: sourceSha,
    }),
  });
}

/**
 * Open a pull request.
 */
export async function createPR(owner, repo, title, body, head, base = "main", draft = false) {
  const data = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, body, head, base, draft }),
  });

  return {
    pr_url: data.html_url,
    pr_number: data.number,
  };
}
