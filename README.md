# ⚡ WA Recap

> Summarise any WhatsApp group chat in seconds. Pick a time range, get back topics, opinions, action items, and mentions — powered by Groq's Llama 3.3 70B.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat&logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-00a884?style=flat)
![Powered by Groq](https://img.shields.io/badge/Powered%20by-Groq-F55036?style=flat)
![License](https://img.shields.io/badge/License-MIT-wagray?style=flat)

---

## The problem

Group chats move fast. You step away for a few hours and there are 500 unread messages. Reading them all is not happening. Asking "what did I miss" puts the burden on someone else and you still get a half-answer.

I built WA Recap after waking up to 2,500 messages during the 2026 World Cup. It reads what's already on your screen, clusters the conversation by topic, and gives you a structured breakdown in under 30 seconds.

---

## What it does

- **Topic clustering** — groups messages by theme, not chronology. Three parallel conversations become three separate cards.
- **Opinion attribution** — for each topic, shows who said what and what their stance was.
- **Action items** — extracts any tasks, plans, or follow-ups from the conversation.
- **Mention detection** — flags any `@mentions` so you can see if someone was trying to reach you.

---

## Demo

![WA Recap Demo](assets/demo.png)

---

## Tech stack

| Layer | Technology |
|---|---|
| Extension | Chrome Manifest V3, Vanilla JS |
| Scraping | DOM-based, `data-id` attribute anchoring |
| Scroll logic | Programmatic scroll-to-load for virtualised chat |
| LLM | Groq API — `llama-3.3-70b-versatile` |
| Storage | `chrome.storage.local` for API key |
| UI | HTML/CSS side panel, no frameworks |

No backend. No database. No WhatsApp API. Reads what is already decrypted on your screen.

---

## Installation

WA Recap is not on the Chrome Web Store yet. Install it as an unpacked extension:

**1. Clone the repo**
```bash
git clone https://github.com/yourusername/wa-recap.git
```

**2. Get a Groq API key**

Go to [console.groq.com](https://console.groq.com), create a free account, and generate an API key. The free tier is more than enough for personal use.

**3. Load the extension in Chrome**
- Open Chrome and go to `chrome://extensions`
- Toggle **Developer mode** on (top right)
- Click **Load unpacked**
- Select the `wa-recap` folder you cloned

**4. Pin it**

Click the puzzle piece icon in Chrome's toolbar and pin WA Recap for easy access.

---

## Usage

1. Open [web.whatsapp.com](https://web.whatsapp.com) and log in
2. Open any group chat
3. Click the ⚡ WA Recap icon in your toolbar
4. Paste your Groq API key (first time only — saved automatically)
5. Select a time range: Last 1hr / 3hr / 6hr / 24hr / Custom
6. Click **Generate Recap**

The extension will scroll back through the chat to load messages, extract them, and return a structured summary in the side panel.

---

## How it works

```
WhatsApp Web DOM
      │
      ▼
content.js — scrolls chat, reads data-id elements,
             extracts sender + text + timestamp
      │
      ▼
background.js — receives message array,
                calls Groq API with structured prompt
      │
      ▼
popup.js — renders topics, opinions,
           action items, mentions
```

The scraper uses `[data-id]` attributes as the primary anchor for message detection — these are more stable than WhatsApp's hashed class names which change with updates.

---

## Limitations

- Works on **WhatsApp Web in Chrome only**
- Capped at **500 messages** per recap (API token limit)
- **Media messages** (images, voice notes, stickers) are excluded
- WhatsApp DOM updates may occasionally break the message selectors
- Works best in **English** — multilingual summaries depend on Groq's capability

---

## Privacy

- Your messages are sent to Groq's API for summarisation. Groq's [privacy policy](https://groq.com/privacy-policy/) applies.
- Your API key is stored in `chrome.storage.local` — never leaves your device except in API calls.
- WA Recap does not store, log, or transmit your messages to any server other than Groq.
- No analytics, no tracking.

---

## File structure

```
wa-recap/
├── manifest.json       # Extension config, Manifest V3
├── content.js          # DOM scraper + scroll-to-load logic
├── background.js       # Service worker, Groq API integration
├── popup.html          # Extension UI
├── popup.js            # Popup logic, time range handling
├── styles.css          # Dark theme styles
└── assets/
    └── demo.png        # Screenshot for README
```

---

## Built by

**Yudhajit Mondal** — CS (AI/ML) student at Manipal University Jaipur, building at the intersection of product and engineering.

- LinkedIn: [linkedin.com/in/yudhajitmondal](https://linkedin.com/in/yudhajitmondal)
- Other projects: [WTFInsights](https://wtfinsights.vercel.app) · Swept · CropSense

---

## License

MIT — do whatever you want, just don't sell it as your own product.
