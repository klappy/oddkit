/**
 * Luxury Chat UI
 *
 * A designer-grade, label-free chat interface.
 * Deep charcoal + warm ivory + champagne gold palette.
 * Serif headings, clean sans-serif body, generous whitespace.
 *
 * Markdown rendering via marked + DOMPurify from CDN.
 */

export function renderChatPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>oddkit</title>
<style>
  /* ── Reset ─────────────────────────────────────── */
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

  /* ── Palette ───────────────────────────────────── */
  :root{
    --bg:       #111110;
    --surface:  #1a1917;
    --elevated: #242320;
    --border:   #2e2d2a;
    --muted:    #6b6860;
    --text:     #e8e4dc;
    --text-dim: #a09a8e;
    --accent:   #c9a96e;
    --accent-lo:rgba(201,169,110,.08);
    --user-bg:  #1f1e1b;
    --asst-bg:  transparent;
    --radius:   2px;
    --font:     "Helvetica Neue",Helvetica,Arial,sans-serif;
    --serif:    Georgia,"Times New Roman",Times,serif;
    --mono:     "SF Mono",Monaco,Menlo,Consolas,monospace;
    --ease:     cubic-bezier(.25,.46,.45,.94);
  }

  /* ── Page ──────────────────────────────────────── */
  html{
    height:100%;
    background:var(--bg);
    color:var(--text);
    font-family:var(--font);
    font-size:15px;
    line-height:1.65;
    -webkit-font-smoothing:antialiased;
    -moz-osx-font-smoothing:grayscale;
  }
  body{
    height:100%;
    display:flex;
    flex-direction:column;
    overflow:hidden;
  }

  /* ── Header ────────────────────────────────────── */
  header{
    flex-shrink:0;
    padding:28px 32px 20px;
    text-align:center;
    border-bottom:1px solid var(--border);
    background:var(--bg);
    position:relative;
  }
  header::after{
    content:"";
    position:absolute;
    bottom:-1px;left:50%;
    transform:translateX(-50%);
    width:40px;height:1px;
    background:var(--accent);
  }
  header h1{
    font-family:var(--serif);
    font-size:13px;
    font-weight:400;
    letter-spacing:.35em;
    text-transform:uppercase;
    color:var(--accent);
  }

  /* ── Messages area ─────────────────────────────── */
  #messages{
    flex:1;
    overflow-y:auto;
    overflow-x:hidden;
    padding:40px 0 24px;
    scroll-behavior:smooth;
  }
  #messages::-webkit-scrollbar{width:4px}
  #messages::-webkit-scrollbar-track{background:transparent}
  #messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}

  .msg{
    max-width:680px;
    margin:0 auto;
    padding:0 32px;
    opacity:0;
    transform:translateY(8px);
    animation:fadeUp .4s var(--ease) forwards;
  }
  .msg+.msg{margin-top:32px}

  @keyframes fadeUp{
    to{opacity:1;transform:translateY(0)}
  }

  /* ── User message ──────────────────────────────── */
  .msg.user .bubble{
    background:var(--user-bg);
    border:1px solid var(--border);
    border-radius:var(--radius);
    padding:16px 20px;
    color:var(--text);
    font-size:15px;
    line-height:1.65;
  }

  /* ── Assistant message ─────────────────────────── */
  .msg.assistant .bubble{
    padding:4px 0;
    color:var(--text-dim);
    font-size:15px;
    line-height:1.75;
  }
  .msg.assistant .bubble strong{color:var(--text)}
  .msg.assistant .bubble em{
    color:var(--accent);
    font-style:normal;
  }
  .msg.assistant .bubble code{
    font-family:var(--mono);
    font-size:13px;
    background:var(--elevated);
    padding:2px 6px;
    border-radius:var(--radius);
    color:var(--text);
  }
  .msg.assistant .bubble pre{
    background:var(--elevated);
    border:1px solid var(--border);
    border-radius:var(--radius);
    padding:16px;
    overflow-x:auto;
    margin:12px 0;
    font-size:13px;
    line-height:1.6;
  }
  .msg.assistant .bubble pre code{
    background:none;
    padding:0;
    font-size:inherit;
  }
  .msg.assistant .bubble p+p{margin-top:12px}
  .msg.assistant .bubble h1,
  .msg.assistant .bubble h2,
  .msg.assistant .bubble h3{
    font-family:var(--serif);
    font-weight:400;
    color:var(--text);
    margin:20px 0 8px;
    letter-spacing:.02em;
  }
  .msg.assistant .bubble h1{font-size:18px}
  .msg.assistant .bubble h2{font-size:16px}
  .msg.assistant .bubble h3{font-size:15px;color:var(--accent)}
  .msg.assistant .bubble ul,
  .msg.assistant .bubble ol{
    padding-left:20px;
    margin:8px 0;
  }
  .msg.assistant .bubble li{margin:4px 0}
  .msg.assistant .bubble a{
    color:var(--accent);
    text-decoration:none;
    border-bottom:1px solid var(--accent-lo);
    transition:border-color .2s;
  }
  .msg.assistant .bubble a:hover{border-bottom-color:var(--accent)}
  .msg.assistant .bubble blockquote{
    border-left:2px solid var(--accent);
    padding-left:16px;
    margin:12px 0;
    color:var(--muted);
    font-style:italic;
  }
  .msg.assistant .bubble hr{
    border:none;
    border-top:1px solid var(--border);
    margin:20px 0;
  }

  /* ── Typing indicator ──────────────────────────── */
  .typing{display:flex;align-items:center;gap:4px;padding:8px 0}
  .typing span{
    width:4px;height:4px;
    border-radius:50%;
    background:var(--muted);
    animation:blink 1.2s infinite both;
  }
  .typing span:nth-child(2){animation-delay:.15s}
  .typing span:nth-child(3){animation-delay:.3s}
  @keyframes blink{
    0%,80%,100%{opacity:.25}
    40%{opacity:1}
  }

  /* ── Empty state ───────────────────────────────── */
  #empty{
    position:absolute;
    top:50%;left:50%;
    transform:translate(-50%,-50%);
    text-align:center;
    pointer-events:none;
    transition:opacity .4s var(--ease);
  }
  #empty p{
    font-family:var(--serif);
    font-size:14px;
    color:var(--muted);
    letter-spacing:.08em;
  }

  /* ── Input area ────────────────────────────────── */
  #input-area{
    flex-shrink:0;
    border-top:1px solid var(--border);
    background:var(--bg);
    position:relative;
  }
  #input-area::before{
    content:"";
    position:absolute;
    top:-1px;left:50%;
    transform:translateX(-50%);
    width:40px;height:1px;
    background:var(--accent);
  }
  #input-wrap{
    max-width:680px;
    margin:0 auto;
    padding:20px 32px 28px;
    display:flex;
    align-items:flex-end;
    gap:16px;
  }
  #input{
    flex:1;
    background:transparent;
    border:none;
    border-bottom:1px solid var(--border);
    outline:none;
    color:var(--text);
    font-family:var(--font);
    font-size:15px;
    line-height:1.65;
    padding:8px 0;
    resize:none;
    min-height:24px;
    max-height:160px;
    transition:border-color .3s var(--ease);
  }
  #input::placeholder{color:var(--muted);opacity:1}
  #input:focus{border-bottom-color:var(--accent)}

  #send{
    flex-shrink:0;
    background:transparent;
    border:1px solid var(--border);
    color:var(--muted);
    width:36px;height:36px;
    border-radius:50%;
    cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    transition:all .3s var(--ease);
  }
  #send:hover{
    border-color:var(--accent);
    color:var(--accent);
  }
  #send:disabled{
    opacity:.3;
    cursor:not-allowed;
  }
  #send svg{
    width:14px;height:14px;
    fill:none;stroke:currentColor;
    stroke-width:2;stroke-linecap:round;stroke-linejoin:round;
  }

  /* ── Responsive ────────────────────────────────── */
  @media(max-width:600px){
    header{padding:20px 20px 16px}
    #input-wrap{padding:16px 20px 22px}
    .msg{padding:0 20px}
  }
</style>
</head>
<body>
  <header>
    <h1>oddkit</h1>
  </header>

  <div id="messages" style="position:relative">
    <div id="empty"><p>What can I help you with?</p></div>
  </div>

  <div id="input-area">
    <div id="input-wrap">
      <textarea id="input" rows="1" placeholder="Ask anything..." autofocus></textarea>
      <button id="send" aria-label="Send" disabled>
        <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </button>
    </div>
  </div>

<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"><\/script>
<script>
(function(){
  var renderer = new marked.Renderer();
  renderer.link = function(token) {
    var href = (token && token.href) || "";
    var text = (token && token.text) || href;
    if (!/^https?:\\/\\//i.test(href)) return text;
    return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
  };
  marked.setOptions({ renderer: renderer, breaks: true, gfm: true });

  function md(text) {
    var raw = marked.parse(text || "");
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
  }

  var msgs  = document.getElementById("messages");
  var empty = document.getElementById("empty");
  var input = document.getElementById("input");
  var send  = document.getElementById("send");
  var busy  = false;

  input.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 160) + "px";
    send.disabled = !this.value.trim() || busy;
  });

  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!send.disabled) doSubmit();
    }
  });

  send.addEventListener("click", doSubmit);

  function scrollBottom() {
    msgs.scrollTo({ top: msgs.scrollHeight, behavior: "smooth" });
  }

  function hideEmpty() {
    if (empty) empty.style.opacity = "0";
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  function addMsg(role, html) {
    hideEmpty();
    var el = document.createElement("div");
    el.className = "msg " + role;
    el.innerHTML = '<div class="bubble">' + html + '</div>';
    msgs.appendChild(el);
    scrollBottom();
    return el;
  }

  function addTyping() {
    hideEmpty();
    var el = document.createElement("div");
    el.className = "msg assistant";
    el.id = "typing-msg";
    el.innerHTML = '<div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>';
    msgs.appendChild(el);
    scrollBottom();
    return el;
  }

  async function doSubmit() {
    var text = input.value.trim();
    if (!text || busy) return;

    busy = true;
    send.disabled = true;
    var rawText = text;
    input.value = "";
    input.style.height = "auto";

    addMsg("user", escapeHtml(rawText).replace(/\\n/g, "<br>"));
    var typingEl = addTyping();

    try {
      var res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: collectHistory() })
      });

      if (!res.ok) {
        typingEl.querySelector(".bubble").innerHTML =
          '<p style="color:#a05050">Unable to respond. ' +
          (res.status === 401 ? "API key not configured." : "Please try again.") + '</p>';
        busy = false;
        send.disabled = false;
        return;
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var full = "";
      var buffer = "";
      typingEl.querySelector(".bubble").innerHTML = "";

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        var lines = buffer.split("\\n");
        buffer = lines.pop() || "";

        for (var i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("data: ")) {
            var data = lines[i].slice(6);
            if (data === "[DONE]") break;
            try {
              var j = JSON.parse(data);
              var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (delta) {
                full += delta;
                typingEl.querySelector(".bubble").innerHTML = md(full);
                scrollBottom();
              }
            } catch(e) {}
          }
        }
      }

      if (full) {
        typingEl.querySelector(".bubble").innerHTML = md(full);
      } else {
        typingEl.querySelector(".bubble").innerHTML = '<p style="color:var(--muted)">No response received.</p>';
      }

    } catch(e) {
      typingEl.querySelector(".bubble").innerHTML = '<p style="color:#a05050">Connection error. Please try again.</p>';
    }

    busy = false;
    send.disabled = !input.value.trim();
    scrollBottom();
  }

  function collectHistory() {
    var history = [];
    msgs.querySelectorAll(".msg").forEach(function(el) {
      if (el.id === "typing-msg") return;
      var role = el.classList.contains("user") ? "user" : "assistant";
      var bubble = el.querySelector(".bubble");
      var clone = bubble.cloneNode(true);
      clone.querySelectorAll("br").forEach(function(br) { br.replaceWith("\\n"); });
      var text = clone.textContent || "";
      if (text.trim()) history.push({ role: role, content: text.trim() });
    });
    return history;
  }
})();
<\/script>
</body>
</html>`;
}
