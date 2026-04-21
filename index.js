import fetch from "node-fetch";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const VIDEO_IDS = process.env.TARGET_VIDEO_IDS?.split(",") || [];
const CHANNEL_IDS = process.env.TARGET_CHANNEL_IDS?.split(",") || [];
const NTFY_TOPIC = process.env.NTFY_TOPIC;

const POLL_INTERVAL = 4000;

// ================= STATE =================
const liveChats = new Map();
const started = new Set();
const seen = new Set();
const cooldown = new Map();

// ================= HEADERS =================
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept": "*/*",
  "Origin": "https://www.youtube.com",
  "Referer": "https://www.youtube.com/"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ======================================================
// SAFE JSON PARSER
// ======================================================
async function safeJson(res) {
  const text = await res.text();
  return JSON.parse(text.replace(/^\)\]\}'\s*\n?/, ""));
}

// ======================================================
// LAYER 1 + 2 + 3 LIVE CHAT DETECTION
// ======================================================
async function getLiveChatId(videoId) {
  try {
    let continuation = null;

    // ---------------- LAYER 1 ----------------
    try {
      const res = await fetch(
        `https://www.youtube.com/watch?v=${videoId}&pbj=1`,
        { headers }
      );

      const data = await safeJson(res);
      const blocks = Array.isArray(data) ? data : [data];

      for (const d of blocks) {
        continuation =
          d?.response?.contents?.twoColumnWatchNextResults
            ?.conversationBar?.liveChatRenderer?.continuations?.[0]
            ?.reloadContinuationData?.continuation;

        if (continuation) break;
      }
    } catch {}

    // ---------------- LAYER 2 ----------------
    if (!continuation) {
      try {
        const res = await fetch(
          "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              context: {
                client: {
                  clientName: "WEB",
                  clientVersion: "2.2024"
                }
              },
              continuation: ""
            })
          }
        );

        const data = await res.json();

        continuation =
          data?.continuationContents?.liveChatContinuation
            ?.continuations?.[0]?.timedContinuationData?.continuation;
      } catch {}
    }

    // ---------------- LAYER 3 (HTML fallback) ----------------
    if (!continuation) {
      try {
        const html = await fetch(
          `https://www.youtube.com/watch?v=${videoId}`,
          { headers }
        ).then(r => r.text());

        const match = html.match(/"continuation":"(.*?)"/);

        if (match?.[1]) {
          continuation = match[1];
        }
      } catch {}
    }

    if (!continuation) return false;

    liveChats.set(videoId, continuation);
    return true;

  } catch {
    return false;
  }
}

// ======================================================
// WAIT LOOP (SMART + NON-SPAM)
// ======================================================
async function waitForChat(videoId) {
  let attempts = 0;

  console.log(`⏳ Detecting live chat: ${videoId}`);

  while (!liveChats.has(videoId)) {
    const ok = await getLiveChatId(videoId);
    attempts++;

    if (ok) {
      console.log(`✔ LIVE CHAT READY: ${videoId}`);
      return;
    }

    if (attempts % 6 === 0) {
      console.log(`⏳ still detecting... (${attempts * 10}s)`);
    }

    await sleep(10000);
  }
}

// ======================================================
// NOTIFY
// ======================================================
async function notify(user, msg, videoId) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      body: `📺 ${videoId}\n👤 ${user}\n💬 ${msg}`
    });
  } catch {}
}

// ======================================================
// POLLER (RESILIENT)
// ======================================================
async function poll(videoId, continuation) {
  let token = continuation;

  while (true) {
    try {
      const res = await fetch(
        "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            context: {
              client: {
                clientName: "WEB",
                clientVersion: "2.2024"
              }
            },
            continuation: token
          })
        }
      );

      const data = await res.json();

      const actions =
        data?.continuationContents?.liveChatContinuation?.actions || [];

      for (const a of actions) {
        const msg =
          a?.replayChatItemAction?.actions?.[0]
            ?.addChatItemAction?.item?.liveChatTextMessageRenderer;

        if (!msg) continue;

        const id = msg.id;
        if (seen.has(id)) continue;
        seen.add(id);

        const text = msg.message?.runs?.map(r => r.text).join("") || "";
        const user = msg.authorName?.simpleText || "unknown";
        const authorId = msg.authorExternalChannelId;

        if (!CHANNEL_IDS.includes(authorId)) continue;

        const now = Date.now();
        if (cooldown.get(authorId) && now - cooldown.get(authorId) < 4000)
          continue;

        cooldown.set(authorId, now);

        console.log(`🎯 ${user}: ${text}`);
        await notify(user, text, videoId);
      }

      token =
        data?.continuationContents?.liveChatContinuation
          ?.continuations?.[0]?.timedContinuationData?.continuation;

      await sleep(POLL_INTERVAL);

    } catch {
      await sleep(5000);
    }
  }
}

// ======================================================
// START SYSTEM
// ======================================================
async function start() {
  console.log("🚀 BULLETPROOF SYSTEM STARTED");

  // parallel detection (faster startup)
  VIDEO_IDS.forEach(id => waitForChat(id));

  // start pollers
  setInterval(() => {
    for (const [videoId, cont] of liveChats.entries()) {
      if (!started.has(videoId)) {
        started.add(videoId);
        console.log(`▶ STARTING: ${videoId}`);
        poll(videoId, cont);
      }
    }
  }, 2000);
}

// ======================================================
// HEALTH CHECK
// ======================================================
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    activeStreams: liveChats.size,
    seenMessages: seen.size
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Running on ${PORT}`);
  start();
});
