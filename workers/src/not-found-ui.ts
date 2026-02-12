/**
 * NotFoundPage — Epistemic Drift 404
 *
 * For oddkit.klappy.dev (Cloudflare Workers).
 * Follows the Remarkable paper-first metaphor:
 *   - Fixed 680px page width, typeset feel
 *   - AI annotation zone at bottom (same surface, different ink)
 *   - No chrome, no UI widgets — just paper
 *
 * Searches the oddkit MCP endpoint for what the user might have been looking for.
 */

export function renderNotFoundPage(pathname: string, mcpOrigin: string): string {
  // Escape the pathname for safe embedding in HTML
  const escapedPathname = pathname
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>404 · Epistemic Drift — oddkit</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

  :root{
    --text:       #1a1a1a;
    --text-dim:   #555;
    --text-muted: #888;
    --text-faint: #999;
    --accent:     #2a5a8a;
    --border:     #ddd;
    --border-lt:  #eee;
    --code-bg:    #f5f3ef;
    --serif:      "Source Serif 4",Georgia,"Times New Roman",serif;
    --mono:       "SF Mono","Fira Code",Consolas,monospace;
  }

  html{
    height:100%;
    background:#fff;
    color:var(--text);
    font-family:var(--serif);
    font-size:18px;
    line-height:1.7;
    -webkit-font-smoothing:antialiased;
  }
  body{
    max-width:680px;
    margin:0 auto;
    padding:80px 24px 120px;
  }

  /* ── 404 badge ─────────────────────────────── */
  .drift-badge{
    font-size:13px;
    font-family:var(--mono);
    color:var(--text-muted);
    letter-spacing:.05em;
    text-transform:uppercase;
    margin-bottom:32px;
  }

  /* ── Title ─────────────────────────────────── */
  h1{
    font-size:32px;
    font-weight:400;
    letter-spacing:-.01em;
    margin-bottom:24px;
    line-height:1.3;
  }

  /* ── Body text ─────────────────────────────── */
  .body-text{
    font-size:18px;
    margin-bottom:16px;
  }
  .body-text:last-of-type{
    margin-bottom:40px;
  }
  .body-text code{
    font-family:var(--mono);
    font-size:15px;
    background:var(--code-bg);
    padding:2px 6px;
    border-radius:3px;
  }

  /* ── Hairline rule ─────────────────────────── */
  hr{
    border:none;
    border-top:1px solid var(--border);
    margin:40px 0 32px;
  }

  /* ── Search form ───────────────────────────── */
  .search-label{
    display:block;
    font-size:13px;
    font-family:var(--mono);
    color:var(--text-muted);
    letter-spacing:.03em;
    margin-bottom:12px;
  }
  .search-row{
    display:flex;
    gap:12px;
    align-items:center;
  }
  .search-input{
    flex:1;
    font-size:17px;
    font-family:var(--serif);
    padding:10px 0;
    border:none;
    border-bottom:1px solid #ccc;
    outline:none;
    background:transparent;
    color:var(--accent);
  }
  .search-input::placeholder{
    color:#aaa;
    opacity:1;
  }
  .search-input:focus{
    border-bottom-color:var(--accent);
  }
  .search-btn{
    font-size:14px;
    font-family:var(--mono);
    padding:8px 16px;
    border:1px solid #ccc;
    border-radius:4px;
    background:#fff;
    color:var(--text-dim);
    cursor:pointer;
    transition:border-color .2s, background .2s;
  }
  .search-btn:hover{
    border-color:#999;
  }
  .search-btn:disabled{
    background:var(--code-bg);
    cursor:wait;
  }

  /* ── Suggestion link ───────────────────────── */
  .suggestion{
    margin-top:16px;
    font-size:15px;
    color:#666;
  }
  .suggestion-link{
    background:none;
    border:none;
    color:var(--accent);
    cursor:pointer;
    font-size:15px;
    font-family:var(--serif);
    text-decoration:underline;
    text-decoration-color:#bbb;
    text-underline-offset:3px;
    padding:0;
  }
  .suggestion-link:hover{
    text-decoration-color:var(--accent);
  }

  /* ── Results ───────────────────────────────── */
  .results{margin-top:32px}
  .no-results{
    font-size:16px;
    color:var(--text-muted);
    font-style:italic;
  }
  .result-item{
    margin-bottom:24px;
    padding-bottom:24px;
    border-bottom:1px solid var(--border-lt);
  }
  .result-item:last-child{
    border-bottom:none;
  }
  .result-title{
    font-size:17px;
    color:var(--accent);
    text-decoration:none;
    font-weight:500;
  }
  .result-title:hover{
    text-decoration:underline;
    text-underline-offset:3px;
  }
  .result-path{
    font-size:14px;
    font-family:var(--mono);
    color:var(--text-faint);
    margin:4px 0 8px;
  }
  .result-snippet{
    font-size:15px;
    color:var(--text-dim);
    margin:0;
    line-height:1.6;
  }

  /* ── Responsive ────────────────────────────── */
  @media(max-width:600px){
    body{padding:48px 20px 80px}
    h1{font-size:26px}
    .body-text{font-size:16px}
  }
</style>
</head>
<body>

  <p class="drift-badge">404 &middot; Document not found</p>

  <h1>Epistemic Drift</h1>

  <p class="body-text">
    The page you followed pointed somewhere that no longer exists &mdash; or never
    did. In ODD, this is called <em>epistemic drift</em>: when a reference encodes
    a truth that has since moved.
  </p>

  <p class="body-text">
    Drift happens when documentation, tooling, or links encode assumptions
    about where things live. The canon evolves. Paths change. What was once
    at <code>${escapedPathname}</code> may have moved, been renamed, or been
    absorbed into another document.
  </p>

  <p class="body-text">
    The content still exists in the canon. You just need to find it.
  </p>

  <hr/>

  <form id="search-form">
    <label for="search-input" class="search-label">Search the canon</label>
    <div class="search-row">
      <input
        id="search-input"
        type="text"
        class="search-input"
        placeholder="What are you looking for?"
        autocomplete="off"
      />
      <button type="submit" id="search-btn" class="search-btn">Search</button>
    </div>
  </form>

  <div id="suggestion"></div>
  <div id="results"></div>

<script>
(function(){
  var MCP_URL = ${JSON.stringify(mcpOrigin + "/mcp")};
  var pathname = ${JSON.stringify(pathname)};

  // Extract a search hint from the broken URL path
  function extractHint(p) {
    try { p = decodeURIComponent(p); } catch(e) {}
    return p
      .replace(/^\\/page\\//, "")
      .replace(/\\.md$/, "")
      .replace(/\\//g, " ")
      .replace(/[-_]/g, " ")
      .replace(/\\b(odd|canon|docs|getting|started)\\b/gi, "")
      .replace(/\\s+/g, " ")
      .trim();
  }

  var hint = extractHint(pathname);
  var input = document.getElementById("search-input");
  var btn = document.getElementById("search-btn");
  var form = document.getElementById("search-form");
  var suggestionEl = document.getElementById("suggestion");
  var resultsEl = document.getElementById("results");
  var hasSearched = false;

  if (hint) {
    input.placeholder = hint;
  }

  // Show the suggestion link if we have a hint
  function renderSuggestion() {
    if (!hint || hasSearched) {
      suggestionEl.innerHTML = "";
      return;
    }
    suggestionEl.innerHTML =
      '<p class="suggestion">Looking for ' +
      '<button type="button" class="suggestion-link" id="suggestion-btn">' +
      escapeHtml(hint) + '</button>?</p>';
    document.getElementById("suggestion-btn").addEventListener("click", function() {
      input.value = hint;
      doSearch(hint);
    });
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  async function searchOddkit(query) {
    try {
      var res = await fetch(MCP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "oddkit_search",
            arguments: { input: query }
          }
        })
      });
      var data = await res.json();
      var text = data.result && data.result.content && data.result.content[0] && data.result.content[0].text;
      var envelope = JSON.parse(text || "{}");
      var hits = (envelope.result && envelope.result.hits) || [];
      return hits.slice(0, 5).map(function(hit) {
        return { path: hit.path, title: hit.title, snippet: hit.snippet, score: hit.score };
      });
    } catch(e) {
      return [];
    }
  }

  function renderResults(hits) {
    if (hits.length === 0) {
      resultsEl.innerHTML = '<div class="results"><p class="no-results">No documents matched. Try different terms.</p></div>';
      return;
    }
    var html = '<div class="results">';
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      html += '<div class="result-item">';
      html += '<a href="/page/' + encodeURIComponent(h.path) + '" class="result-title">' + escapeHtml(h.title) + '</a>';
      html += '<p class="result-path">' + escapeHtml(h.path) + '</p>';
      html += '<p class="result-snippet">' + escapeHtml(h.snippet) + '</p>';
      html += '</div>';
    }
    html += '</div>';
    resultsEl.innerHTML = html;
  }

  async function doSearch(query) {
    if (!query.trim()) return;
    hasSearched = true;
    suggestionEl.innerHTML = "";
    btn.disabled = true;
    btn.textContent = "...";

    var hits = await searchOddkit(query.trim());
    renderResults(hits);

    btn.disabled = false;
    btn.textContent = "Search";
  }

  form.addEventListener("submit", function(e) {
    e.preventDefault();
    doSearch(input.value || hint);
  });

  renderSuggestion();
})();
<\\/script>
</body>
</html>`;
}
