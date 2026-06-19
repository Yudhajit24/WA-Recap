// WA Recap popup logic.

const els = {
  rangeSelect: document.getElementById("rangeSelect"),
  customRange: document.getElementById("customRange"),
  fromInput: document.getElementById("fromInput"),
  toInput: document.getElementById("toInput"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  apiKeyHint: document.getElementById("apiKeyHint"),
  generateBtn: document.getElementById("generateBtn"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  chatNameLabel: document.getElementById("chatNameLabel"),
  copyBtn: document.getElementById("copyBtn"),
  topicsList: document.getElementById("topicsList"),
  opinionsList: document.getElementById("opinionsList"),
  actionsList: document.getElementById("actionsList"),
  mentionsList: document.getElementById("mentionsList"),
  rawBlock: document.getElementById("rawBlock"),
  rawOutput: document.getElementById("rawOutput"),
  topicsBlock: document.getElementById("topicsBlock"),
  opinionsBlock: document.getElementById("opinionsBlock"),
  actionsBlock: document.getElementById("actionsBlock"),
  mentionsBlock: document.getElementById("mentionsBlock"),
};

// Holds the latest summary for the Copy button.
let lastSummary = null;
let lastChatName = "";

// --- API key persistence -------------------------------------------------

function loadApiKey() {
  chrome.storage.local.get(["groqApiKey"], (result) => {
    if (result.groqApiKey) {
      els.apiKeyInput.value = result.groqApiKey;
      els.apiKeyHint.textContent = "Saved ✓";
    } else {
      els.apiKeyHint.textContent = "Get a free key at console.groq.com";
    }
  });
}

function saveApiKey() {
  const key = els.apiKeyInput.value.trim();
  chrome.storage.local.set({ groqApiKey: key }, () => {
    els.apiKeyHint.textContent = key ? "Saved ✓" : "No key set";
  });
}

els.apiKeyInput.addEventListener("blur", saveApiKey);

// --- Range selector ------------------------------------------------------

els.rangeSelect.addEventListener("change", () => {
  if (els.rangeSelect.value === "custom") {
    els.customRange.classList.remove("hidden");
  } else {
    els.customRange.classList.add("hidden");
  }
});

// Compute the "since" timestamp (epoch ms) based on the selected range.
// Returns { since, until } where until may be null (meaning "now").
function computeRange() {
  const val = els.rangeSelect.value;
  if (val === "custom") {
    const from = els.fromInput.value
      ? new Date(els.fromInput.value).getTime()
      : null;
    const to = els.toInput.value
      ? new Date(els.toInput.value).getTime()
      : null;
    return { since: from, until: to };
  }
  const hours = parseInt(val, 10);
  return { since: Date.now() - hours * 60 * 60 * 1000, until: null };
}

// --- Status helpers ------------------------------------------------------

function showStatus(text, { spinner = false, error = false } = {}) {
  els.status.classList.remove("hidden");
  els.status.classList.toggle("error", error);
  els.status.innerHTML = "";
  if (spinner) {
    const s = document.createElement("span");
    s.className = "spinner";
    els.status.appendChild(s);
  }
  const span = document.createElement("span");
  span.textContent = text;
  els.status.appendChild(span);
}

function hideStatus() {
  els.status.classList.add("hidden");
}

function setBusy(busy) {
  els.generateBtn.disabled = busy;
  els.generateBtn.textContent = busy ? "Working…" : "Generate Recap";
}

// --- Tab / scripting helpers ---------------------------------------------

async function getActiveWhatsAppTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { tab: null, error: "No active tab." };
  if (!tab.url || !tab.url.startsWith("https://web.whatsapp.com/")) {
    return {
      tab: null,
      error: "Open WhatsApp Web (web.whatsapp.com) first.",
    };
  }
  return { tab, error: null };
}

// Run a function inside the page context and return its result.
// NOTE: we run in the default ISOLATED world (not MAIN). content.js — whether
// loaded via the manifest content_script or our defensive files injection —
// runs in the extension's isolated world and stores WA_RECAP_* on that world's
// `window`. executeScript without a `world` shares that same isolated world, so
// these globals are visible. Using world:"MAIN" would NOT see them.
async function execInPage(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result?.result;
}

// Functions below are stringified and injected, so they must be self-contained
// and reference only window globals exposed by content.js.

function pageGetChatName() {
  if (typeof window.WA_RECAP_getCurrentChat !== "function") return null;
  return window.WA_RECAP_getCurrentChat();
}

function pageStartScrape(since) {
  if (typeof window.WA_RECAP_scrape !== "function") {
    return { started: false, reason: "not-injected" };
  }
  // Kick off async scrape; store the promise result on window for polling.
  window.__WA_RECAP_RESULT = undefined;
  window.__WA_RECAP_ERROR = undefined;
  window.__WA_RECAP_PROGRESS = { count: 0, scrolls: 0, done: false };
  window
    .WA_RECAP_scrape(since)
    .then((msgs) => {
      window.__WA_RECAP_RESULT = msgs;
    })
    .catch((err) => {
      window.__WA_RECAP_ERROR = err && err.message ? err.message : String(err);
    });
  return { started: true };
}

function pagePollScrape() {
  return {
    progress: window.__WA_RECAP_PROGRESS || null,
    result: window.__WA_RECAP_RESULT || null,
    error: window.__WA_RECAP_ERROR || null,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main flow -----------------------------------------------------------

els.generateBtn.addEventListener("click", async () => {
  hideResults();
  setBusy(true);

  // Validate API key presence early.
  const key = els.apiKeyInput.value.trim();
  if (!key) {
    showStatus("Enter your Groq API key first.", { error: true });
    setBusy(false);
    return;
  }
  saveApiKey();

  // Validate tab.
  const { tab, error } = await getActiveWhatsAppTab();
  if (error) {
    showStatus(error, { error: true });
    setBusy(false);
    return;
  }

  // Ensure content script is present (inject defensively).
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (e) {
    // Non-fatal; the declared content script may already be active.
  }

  // Confirm a chat is open.
  let chatName;
  try {
    chatName = await execInPage(tab.id, pageGetChatName);
  } catch (e) {
    showStatus(
      "Could not access the page. Reload WhatsApp Web and try again.",
      { error: true }
    );
    setBusy(false);
    return;
  }

  if (!chatName) {
    showStatus("Please open a group chat first.", { error: true });
    setBusy(false);
    return;
  }
  lastChatName = chatName;

  // Compute range.
  const { since } = computeRange();

  // Start scraping.
  showStatus("Scrolling through messages…", { spinner: true });
  let start;
  try {
    start = await execInPage(tab.id, pageStartScrape, [since]);
  } catch (e) {
    showStatus("Failed to start scraping. Reload the page.", { error: true });
    setBusy(false);
    return;
  }
  if (!start || !start.started) {
    showStatus(
      "Scraper not ready. Reload WhatsApp Web and try again.",
      { error: true }
    );
    setBusy(false);
    return;
  }

  // Poll for progress / completion (cap ~90s).
  let messages = null;
  const maxPolls = 300; // 300 * 300ms = 90s
  for (let i = 0; i < maxPolls; i++) {
    await sleep(300);
    let poll;
    try {
      poll = await execInPage(tab.id, pagePollScrape);
    } catch (e) {
      continue;
    }
    if (!poll) continue;

    if (poll.error) {
      showStatus("Scrape error: " + poll.error, { error: true });
      setBusy(false);
      return;
    }
    if (poll.progress && !poll.result) {
      showStatus(
        `Scrolling through messages… (${poll.progress.count} loaded, ${poll.progress.scrolls} scrolls)`,
        { spinner: true }
      );
    }
    if (poll.result) {
      messages = poll.result;
      break;
    }
  }

  if (!messages) {
    showStatus("Timed out while loading messages. Try a smaller range.", {
      error: true,
    });
    setBusy(false);
    return;
  }

  if (messages.length === 0) {
    showStatus("No messages found in that range.", { error: true });
    setBusy(false);
    return;
  }

  // Summarize via background.
  showStatus(`Summarizing ${messages.length} messages…`, { spinner: true });

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: "SUMMARIZE",
      messages,
      chatName,
    });
  } catch (e) {
    showStatus("Failed to reach the summarizer: " + e.message, {
      error: true,
    });
    setBusy(false);
    return;
  }

  if (!resp || !resp.ok) {
    showStatus(resp?.error || "Summarization failed.", { error: true });
    setBusy(false);
    return;
  }

  hideStatus();
  setBusy(false);
  renderResults(resp, chatName);
});

// --- Rendering -----------------------------------------------------------

function hideResults() {
  els.results.classList.add("hidden");
  els.rawBlock.classList.add("hidden");
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function outcomeBadgeClass(outcome) {
  const o = (outcome || "").toLowerCase();
  if (o.includes("decid") || o.includes("agreed") || o.includes("done")) {
    return "decided";
  }
  if (o.includes("open") || o.includes("pending") || o.includes("unresolved")) {
    return "open";
  }
  return "none";
}

function renderResults(resp, chatName) {
  els.results.classList.remove("hidden");
  els.chatNameLabel.textContent = chatName;

  const data = resp.parsed;

  // If parsing failed, show raw output and bail.
  if (!data) {
    els.topicsBlock.classList.add("hidden");
    els.opinionsBlock.classList.add("hidden");
    els.actionsBlock.classList.add("hidden");
    els.mentionsBlock.classList.add("hidden");
    els.rawBlock.classList.remove("hidden");
    els.rawOutput.textContent =
      resp.raw || "The model returned an unparseable response.";
    lastSummary = null;
    return;
  }

  // Reset visibility.
  els.topicsBlock.classList.remove("hidden");
  els.opinionsBlock.classList.remove("hidden");
  els.actionsBlock.classList.remove("hidden");
  els.mentionsBlock.classList.remove("hidden");
  els.rawBlock.classList.add("hidden");

  lastSummary = data;

  // Topics
  els.topicsList.innerHTML = "";
  const topics = Array.isArray(data.topics) ? data.topics : [];
  if (topics.length === 0) {
    els.topicsList.appendChild(el("div", "empty", "No topics identified."));
  }
  for (const t of topics) {
    const card = el("div", "topic-card");
    const head = el("div", "topic-card-head");
    head.appendChild(el("span", "topic-title", t.title || "Untitled"));
    if (t.outcome) {
      head.appendChild(
        el("span", "badge " + outcomeBadgeClass(t.outcome), t.outcome)
      );
    }
    card.appendChild(head);
    if (t.summary) card.appendChild(el("div", "topic-summary", t.summary));
    const parts = Array.isArray(t.participants) ? t.participants : [];
    if (parts.length) {
      card.appendChild(
        el("div", "topic-participants", "👥 " + parts.join(", "))
      );
    }
    els.topicsList.appendChild(card);
  }

  // Opinions
  els.opinionsList.innerHTML = "";
  const opinions = Array.isArray(data.opinions) ? data.opinions : [];
  if (opinions.length === 0) {
    els.opinionsList.appendChild(el("div", "empty", "Nothing notable."));
  }
  for (const o of opinions) {
    const row = el("div", "opinion-row");
    row.appendChild(el("span", "opinion-person", o.person || "?"));
    row.appendChild(el("span", "opinion-stance", o.stance || ""));
    els.opinionsList.appendChild(row);
  }

  // Action items
  els.actionsList.innerHTML = "";
  const actions = Array.isArray(data.action_items) ? data.action_items : [];
  if (actions.length === 0) {
    els.actionsList.appendChild(el("li", "empty", "No action items."));
  }
  for (const a of actions) {
    els.actionsList.appendChild(el("li", null, a));
  }

  // Mentions
  els.mentionsList.innerHTML = "";
  const mentions = Array.isArray(data.mentions) ? data.mentions : [];
  if (mentions.length === 0) {
    els.mentionsList.appendChild(el("span", "empty", "No mentions."));
  }
  for (const m of mentions) {
    els.mentionsList.appendChild(el("span", "mention-chip", m));
  }
}

// --- Copy summary --------------------------------------------------------

function buildPlainText() {
  if (!lastSummary) return "";
  const d = lastSummary;
  const lines = [];
  lines.push(`WA Recap — ${lastChatName}`);
  lines.push("=".repeat(40));
  lines.push("");

  if (Array.isArray(d.topics) && d.topics.length) {
    lines.push("TOPICS");
    d.topics.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.title || "Untitled"}`);
      if (t.summary) lines.push(`   ${t.summary}`);
      if (Array.isArray(t.participants) && t.participants.length)
        lines.push(`   Participants: ${t.participants.join(", ")}`);
      if (t.outcome) lines.push(`   Outcome: ${t.outcome}`);
      lines.push("");
    });
  }

  if (Array.isArray(d.opinions) && d.opinions.length) {
    lines.push("WHO SAID WHAT");
    d.opinions.forEach((o) => {
      lines.push(`- ${o.person || "?"}: ${o.stance || ""}`);
    });
    lines.push("");
  }

  if (Array.isArray(d.action_items) && d.action_items.length) {
    lines.push("ACTION ITEMS");
    d.action_items.forEach((a) => lines.push(`- ${a}`));
    lines.push("");
  }

  if (Array.isArray(d.mentions) && d.mentions.length) {
    lines.push("MENTIONS");
    lines.push(d.mentions.join(", "));
    lines.push("");
  }

  return lines.join("\n").trim();
}

// copy plain text summary to clipboard
els.copyBtn.addEventListener("click", async () => {
  const text = buildPlainText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const orig = els.copyBtn.textContent;
    els.copyBtn.textContent = "Copied ✓";
    setTimeout(() => (els.copyBtn.textContent = orig), 1500);
  } catch (e) {
    els.copyBtn.textContent = "Copy failed";
  }
});

// --- Init ----------------------------------------------------------------

loadApiKey();
