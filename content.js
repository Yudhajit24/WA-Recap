// scroll-to-load: repeatedly scrolls chat container upward
// WA Recap content script
// Injected into WhatsApp Web. Scrapes messages from the open group chat and
// exposes helpers on `window` for the popup to call via executeScript.
//
// SELECTOR NOTES (verified live against WhatsApp Web on 2026-06-18):
//   The old `data-id="true_<jid>@g.us_<msgid>"` anchor described in many
//   guides NO LONGER EXISTS on message rows. The `[data-id]` elements present
//   today are hashed asset IDs (emoji/UI), useless for messages. The reliable
//   anchors are:
//     - #main                                   -> the open conversation panel
//     - #main header span[dir="auto"]:not([title]) -> chat name
//     - #main [data-tab="8"]                     -> message scroll pane
//     - #main [role="row"]                       -> message rows
//     - [data-pre-plain-text] = "[HH:MM, D/M/YYYY] Sender: " -> sender + time
//     - span.selectable-text                     -> message body text
//   There is no per-message id anymore, so we dedup by (preText + body).

(function () {
  "use strict";

  if (window.__WA_RECAP_INJECTED__) return;
  window.__WA_RECAP_INJECTED__ = true;

  const SCROLL_DELAY_MS = 300;
  const MAX_SCROLL_ATTEMPTS = 150;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Anchors -----------------------------------------------------------

  function getMainPanel() {
    return document.querySelector("#main");
  }

  // The conversation's scrollable message pane.
  function findScrollContainer() {
    const main = getMainPanel();
    if (!main) return null;

    const pane = main.querySelector('[data-tab="8"]');
    if (pane) {
      let el = pane;
      for (let i = 0; i < 6 && el; i++) {
        const style = window.getComputedStyle(el);
        if (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight
        ) {
          return el;
        }
        el = el.parentElement;
      }
      if (pane.scrollHeight > pane.clientHeight) return pane;
    }

    // Fallback: tallest scrollable div in #main that holds message rows.
    const candidates = Array.from(main.querySelectorAll("div")).filter((el) => {
      if (el.scrollHeight <= el.clientHeight) return false;
      const style = window.getComputedStyle(el);
      if (style.overflowY !== "auto" && style.overflowY !== "scroll")
        return false;
      return el.querySelector('[role="row"]') !== null;
    });
    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    return candidates[0] || null;
  }

  // Current chat name from the conversation header.
  function getCurrentChatName() {
    const main = getMainPanel();
    if (!main) return null;
    const header = main.querySelector("header");
    if (!header) return null;

    // The name is the first dir="auto" span WITHOUT a title attribute (the
    // member-list span carries the title; the name span does not).
    const nameEl = header.querySelector('span[dir="auto"]:not([title])');
    if (nameEl && nameEl.textContent.trim()) return nameEl.textContent.trim();

    // Fallback: any non-empty dir="auto" span in the header.
    const any = header.querySelector('span[dir="auto"]');
    return any && any.textContent.trim() ? any.textContent.trim() : null;
  }

  // --- Parsing -----------------------------------------------------------

  // Parse "[HH:MM, D/M/YYYY] Sender: " (day-first dates) into { sender, ts }.
  // Returns null if the shape doesn't match.
  function parsePrePlainText(str) {
    if (!str) return null;
    const m = str.match(
      /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP]M))?,\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]\s*(.*?):\s*$/i
    );
    if (!m) return null;
    let [, hh, mm, ss, ampm, d, mo, y] = m;
    let hour = parseInt(hh, 10);
    if (ampm) {
      const up = ampm.toUpperCase();
      if (up === "PM" && hour < 12) hour += 12;
      if (up === "AM" && hour === 12) hour = 0;
    }
    let year = parseInt(y, 10);
    if (year < 100) year += 2000;
    const sender = (m[8] || "").trim();
    const ts = new Date(
      year,
      parseInt(mo, 10) - 1,
      parseInt(d, 10),
      hour,
      parseInt(mm, 10),
      ss ? parseInt(ss, 10) : 0
    ).getTime();
    return { sender, ts: isNaN(ts) ? null : ts };
  }

  // Text content, converting emoji <img alt="😀"> into their alt text.
  function textWithEmoji(el) {
    let out = "";
    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName.toLowerCase() === "img" && node.alt) {
          out += node.alt;
        } else {
          out += textWithEmoji(node);
        }
      }
    });
    return out;
  }

  // Extract message body text from a row.
  function extractText(row) {
    // The body lives in span.selectable-text. There can be more than one
    // (e.g. quoted reply + body); prefer the one inside the copyable-text
    // wrapper (the actual message), else concatenate.
    const copyable = row.querySelector(".copyable-text span.selectable-text");
    if (copyable) {
      const t = textWithEmoji(copyable).trim();
      if (t) return t;
    }
    const spans = row.querySelectorAll("span.selectable-text");
    if (spans.length) {
      // Use the last selectable-text (body usually comes after a quote).
      const t = textWithEmoji(spans[spans.length - 1]).trim();
      if (t) return t;
    }
    return "";
  }

  // Read all currently-rendered message rows into structured objects.
  function readRenderedMessages() {
    const main = getMainPanel();
    if (!main) return [];

    const rows = Array.from(main.querySelectorAll('[role="row"]'));
    const messages = [];

    for (const row of rows) {
      const text = extractText(row);
      if (!text) continue; // skip media-only / system rows

      const pre = row.querySelector("[data-pre-plain-text]");
      const preStr = pre ? pre.getAttribute("data-pre-plain-text") : null;
      const parsed = preStr ? parsePrePlainText(preStr) : null;

      // Detect outgoing messages: pre-plain-text sender is "You", or the row
      // is right-aligned. We mainly rely on the parsed sender.
      const sender = parsed && parsed.sender ? parsed.sender : "Unknown";
      const timestamp = parsed ? parsed.ts : null;

      // No stable message id exists; synthesize a dedup key.
      const id = `${preStr || ""}␟${text}`;

      messages.push({ id, sender, text, timestamp });
    }
    return messages;
  }

  function mergeMessages(accMap, newMessages) {
    for (const m of newMessages) {
      if (!accMap.has(m.id)) accMap.set(m.id, m);
    }
  }

  // Try to pull more history from the phone if WhatsApp offers it.
  function clickGetOlderMessages() {
    const main = getMainPanel();
    if (!main) return false;
    const btn = Array.from(main.querySelectorAll('div[role="button"],button'))
      .find((b) => /older messages from your phone/i.test(b.textContent || ""));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  // --- Public API --------------------------------------------------------

  async function scrape(sinceTimestamp) {
    const container = findScrollContainer();
    const accMap = new Map();

    function setProgress(count, scrolls, done) {
      window.__WA_RECAP_PROGRESS = { count, scrolls, done: !!done };
    }

    mergeMessages(accMap, readRenderedMessages());
    setProgress(accMap.size, 0, false);

    if (!container) {
      setProgress(accMap.size, 0, true);
      return finalize(accMap, sinceTimestamp);
    }

    let attempts = 0;
    let lastScrollHeight = -1;
    let stagnantRounds = 0;

    while (attempts < MAX_SCROLL_ATTEMPTS) {
      const oldest = oldestTimestamp(accMap);
      if (sinceTimestamp && oldest != null && oldest <= sinceTimestamp) break;

      container.scrollTop = 0;
      attempts++;
      await sleep(SCROLL_DELAY_MS);

      mergeMessages(accMap, readRenderedMessages());
      setProgress(accMap.size, attempts, false);

      const h = container.scrollHeight;
      if (h === lastScrollHeight) {
        stagnantRounds++;
        // Before giving up, see if WhatsApp can fetch older messages from the
        // phone (multi-device keeps limited history in the browser).
        if (stagnantRounds === 2 && clickGetOlderMessages()) {
          await sleep(SCROLL_DELAY_MS * 3);
          stagnantRounds = 0;
        } else if (stagnantRounds >= 3) {
          break; // reached the top of available history
        }
      } else {
        stagnantRounds = 0;
      }
      lastScrollHeight = h;
    }

    setProgress(accMap.size, attempts, true);
    return finalize(accMap, sinceTimestamp);
  }

  function oldestTimestamp(accMap) {
    let oldest = null;
    for (const m of accMap.values()) {
      if (m.timestamp == null) continue;
      if (oldest == null || m.timestamp < oldest) oldest = m.timestamp;
    }
    return oldest;
  }

  function finalize(accMap, sinceTimestamp) {
    let list = Array.from(accMap.values());

    if (sinceTimestamp) {
      list = list.filter(
        (m) => m.timestamp == null || m.timestamp >= sinceTimestamp
      );
    }

    list.sort((a, b) => {
      if (a.timestamp == null && b.timestamp == null) return 0;
      if (a.timestamp == null) return 1;
      if (b.timestamp == null) return -1;
      return a.timestamp - b.timestamp;
    });

    return list;
  }

  window.WA_RECAP_scrape = scrape;
  window.WA_RECAP_getCurrentChat = getCurrentChatName;
})();
