import fetch from "node-fetch";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG =================
const VIDEO_IDS = process.env.TARGET_VIDEO_IDS?.split(",") || [];
const CHANNEL_IDS = process.env.TARGET_CHANNEL_IDS?.split(",") || [];
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const POLL_INTERVAL = 5000;

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
  "Referer": "https://www.youtube.com/",
  "Accept-Language": "en-US,en;q=0.9"
};

// ================= UTIL =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ======================================================
// SAFE JSON PARSER (handles )]}' prefix)
// ======================================================
async function safeJson(res) {
  const text = await res.text();
  const cleaned = text.replace(/^\)\]\}'\s*\n?/, "");
  return JSON.parse(cleaned);
}

// ======================================================
// GET LIVE CHAT ID (ROBUST + SAFE)
// ======================================================
async function getLiveChatId(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&pbj=1`,
      { headers }
    );

    const data = await safeJson(res);

    // Normalize response (IMPORTANT FIX)
    const blocks = Array.isArray(data) ? data : [data];

    let continuation = null;

    for (const d of blocks) {
      const chat =
        d?.response?.contents?.twoColumnWatchNextResults
          ?.conversationBar?.liveChatRenderer?.continuations?.[0]
          ?.reloadContinuationData?.continuation ||
        d?.response?.continuationContents?.liveChatContinuation
          ?.continuations?.[0]?.timedContinuationData?.continuation;

      if (chat) {
        continuation = chat;
        break;
      }
    }

    if (!continuation) {
      console.log(`⏳ No live chat yet for ${videoId}`);
      return;
    }

    liveChats.set(videoId, continuation);
    console.log(`✔ LIVE CHAT READY for ${videoId}`);

  } catch (err) {
    console.log(`getLiveChatId error (${videoId}):`, err.message);
  }
}

// ======================================================
// NTFY NOTIFICATION
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
// POLL LIVE CHAT
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

        const text =
          msg.message?.runs?.map(r => r.text).join("") || "";

        const user = msg.authorName?.simpleText || "unknown";
        const authorId = msg.authorExternalChannelId;

        if (!CHANNEL_IDS.includes(authorId)) continue;

        const now = Date.now();
        if (cooldown.get(authorId) && now - cooldown.get(authorId) < 5000)
          continue;

        cooldown.set(authorId, now);

        console.log(`🎯 ${user}: ${text}`);
        await notify(user, text, videoId);
      }

      token =
        data?.continuationContents?.liveChatContinuation
          ?.continuations?.[0]?.timedContinuationData?.continuation;

      await sleep(POLL_INTERVAL);

    } catch (err) {
      console.log(`poll error (${videoId}):`, err.message);
      await sleep(5000);
    }
  }
}

// ======================================================
// START SYSTEM
// ======================================================
async function start() {
  console.log("🚀 NO-KEY SYSTEM STARTED");

  for (const id of VIDEO_IDS) {
    await getLiveChatId(id);
  }

  // retry until chat is ready
  setInterval(async () => {
    for (const id of VIDEO_IDS) {
      if (!liveChats.has(id)) {
        await getLiveChatId(id);
      }
    }
  }, 15000);

  // start pollers safely
  setInterval(() => {
    for (const [videoId, cont] of liveChats.entries()) {
      if (!started.has(videoId)) {
        started.add(videoId);
        console.log(`▶ STARTING ${videoId}`);
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
    streams: liveChats.size,
    seen: seen.size
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Running on ${PORT}`);
  start();
});
