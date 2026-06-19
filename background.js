// WA Recap background service worker (Manifest V3)
// Handles SUMMARIZE messages from the popup, calls the Groq API, and returns
// the parsed structured summary.

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are a group chat summarizer. Given a list of WhatsApp messages, produce a structured summary.
Format your response as JSON with this exact structure:
{
  "topics": [
    {
      "title": "short topic name",
      "summary": "2-3 sentence summary of what was discussed",
      "participants": ["name1", "name2"],
      "outcome": "decision made / still open / no conclusion"
    }
  ],
  "opinions": [
    {
      "person": "name",
      "stance": "one line summary of their position or key contribution"
    }
  ],
  "action_items": ["item1", "item2"],
  "mentions": ["any @mentions found in messages"]
}
Group related messages into topics by semantic similarity, not just chronology. A single conversation often has 3-4 parallel threads — identify them separately. Identify parallel threads separately.`;

// Format a single message as "Sender (HH:MM): text".
function formatMessage(m) {
  let timeStr = "";
  if (m.timestamp) {
    const d = new Date(m.timestamp);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    timeStr = `${hh}:${mm}`;
  } else {
    timeStr = "--:--";
  }
  const sender = m.sender || "Unknown";
  const text = (m.text || "").replace(/\s+/g, " ").trim();
  return `${sender} (${timeStr}): ${text}`;
}

function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["groqApiKey"], (result) => {
      resolve(result.groqApiKey || "");
    });
  });
}

// Extract a JSON object from a model response that may be wrapped in prose or
// ```json fences.
function extractJson(content) {
  if (!content) return null;

  // Try direct parse first.
  try {
    return JSON.parse(content);
  } catch (_) {
    /* fall through */
  }

  // Strip markdown code fences.
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {
      /* fall through */
    }
  }

  // Grab the first balanced-looking {...} block.
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = content.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {
      /* fall through */
    }
  }

  return null;
}

async function summarize(messages, chatName) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: "No Groq API key set. Add one in the extension popup.",
    };
  }

  if (!messages || messages.length === 0) {
    return { ok: false, error: "No messages to summarize." };
  }

  // Cap at 500 most recent messages to stay within token limits.
  let trimmed = messages;
  if (messages.length > 500) {
    trimmed = messages.slice(-500);
  }

  const formatted = trimmed.map(formatMessage).join("\n");
  const userMessage = `Chat name: ${chatName || "Unknown"}\n\nMessages:\n${formatted}`;

  let response;
  try {
    response = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });
  } catch (err) {
    return { ok: false, error: `Network error calling Groq: ${err.message}` };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json();
      detail = errBody.error?.message || JSON.stringify(errBody);
    } catch (_) {
      detail = await response.text().catch(() => "");
    }
    return {
      ok: false,
      error: `Groq API error ${response.status}: ${detail}`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { ok: false, error: "Could not parse Groq response." };
  }

  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = extractJson(content);

  if (!parsed) {
    // Hand back raw text so the popup can show something useful.
    return {
      ok: true,
      parsed: null,
      raw: content,
      messageCount: trimmed.length,
    };
  }

  return {
    ok: true,
    parsed,
    raw: content,
    messageCount: trimmed.length,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "SUMMARIZE") {
    summarize(message.messages, message.chatName)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, error: err.message || String(err) })
      );
    // Return true to keep the message channel open for the async response.
    return true;
  }
});
