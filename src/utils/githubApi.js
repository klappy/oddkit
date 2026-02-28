/**
 * GitHub API helper for oddkit_write
 *
 * Provides GitHub REST API interactions for writing files to repos.
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
  // Handle various URL formats
  // https://raw.githubusercontent.com/owner/repo/ref
  // https://github.com/owner/repo
  // https://github.com/owner/repo.git
  
  let match;
  
  // Try raw.githubusercontent.com format
  match = baselineUrl.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  
  // Try github.com format
  match = baselineUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  
  throw new Error(`Could not parse owner/repo from baseline_url: ${baselineUrl}`);
}

/**
 * Make authenticated GitHub API request
 */
async function githubRequest(endpoint, options = {}) {
  const token = getGitHubToken();
  const url = `${GITHUB_API_BASE}${endpoint}`;
  
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${error.message || ""}`);
  }
  
  // Handle 204 No Content
  if (response.status === 204) {
    return null;
  }
  
  return response.json();
}

/**
 * Get current file SHA (required for updates via Contents API)
 */
export async function getFileSha(owner, repo, path, branch = null) {
  const endpoint = `/repos/${owner}/${repo}/contents/${path}${branch ? `?ref=${branch}` : ""}`;
  
  try {
    const data = await githubRequest(endpoint);
    return data.sha;
  } catch (err) {
    if (err.message.includes("404")) {
      return null; // File doesn't exist
    }
    throw err;
  }
}

/**
 * Write a single file to the repo using Contents API
 * Tier 1: Single file to default branch
 */
export async function writeFile(owner, repo, path, content, message, branch = null, sha = null) {
  const encodedContent = Buffer.from(content, "utf-8").toString("base64");
  
  const body = {
    message,
    content: encodedContent,
  };
  
  if (sha) {
    body.sha = sha;
  }
  
  if (branch) {
    body.branch = branch;
  }
  
  const endpoint = `/repos/${owner}/${repo}/contents/${path}`;
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
}

/**
 * Get the default branch name for a repo
 */
export async function getDefaultBranch(owner, repo) {
  const data = await githubRequest(`/repos/${owner}/${repo}`);
  return data.default_branch;
}

/**
 * Check if a branch exists
 */
export async function branchExists(owner, repo, branch) {
  try {
    await githubRequest(`/repos/${owner}/${repo}/branches/${branch}`);
    return true;
  } catch (err) {
    if (err.message.includes("404")) {
      return false;
    }
    throw err;
  }
}

/**
 * Create a new branch from a ref
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
 * Open a pull request
 */
export async function createPR(owner, repo, title, body, head, base = "main") {
  const data = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title,
      body,
      head,
      base,
    }),
  });
  
  return {
    pr_url: data.html_url,
    pr_number: data.number,
  };
}
