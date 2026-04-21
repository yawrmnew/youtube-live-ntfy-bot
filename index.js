import fetch from "node-fetch";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG =================
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
    "com.google.android.youtube/19.09.37 (Linux; U; Android 11)",
  "Content-Type": "application/json",
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
// LIVE CHAT DETECTION
// ======================================================
async function getLiveChatId(videoId) {
  try {
    let continuation = null;

    // Layer 1: watch page
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

    // Layer 2: HTML fallback
    if (!continuation) {
      try {
        const html = await fetch(
          `https://www.youtube.com/watch?v=${videoId}`,
          { headers }
        ).then(r => r.text());

        const match = html.match(/"continuation":"(.*?)"/);

        if (match?.[1]) continuation = match[1];
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
// WAIT FOR CHAT
// ======================================================
async function waitForChat(videoId) {
  console.log(`⏳ Detecting live chat: ${videoId}`);

  while (!liveChats.has(videoId)) {
    const ok = await getLiveChatId(videoId);

    if (ok) {
      console.log(`✔ LIVE CHAT READY: ${videoId}`);
      return;
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
// POLLER (ANDROID FIX APPLIED)
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
                clientName: "ANDROID",
                clientVersion: "19.09.37",
                androidSdkVersion: 30
              }
            },
            continuation: token
          })
        }
      );

      const data = await res.json();

      const actions =
        data?.continuationContents?.liveChatContinuation?.actions || [];

      // 🔍 DEBUG
      console.log("ACTIONS LENGTH:", actions.length);

      for (const a of actions) {

        const item =
          a?.addChatItemAction?.item ||
          a?.replayChatItemAction?.actions?.[0]?.addChatItemAction?.item;

        const msg = item?.liveChatTextMessageRenderer;

        if (!msg) continue;

        const id = msg.id;
        if (seen.has(id)) continue;
        seen.add(id);

        const text =
          msg.message?.runs?.map(r => r.text).join("") || "";

        const user = msg.authorName?.simpleText || "unknown";
        const authorId = msg.authorExternalChannelId;

        // 🔍 DEBUG
        console.log("RAW:", user, authorId, text);

        // FILTER
        if (!CHANNEL_IDS.includes(authorId)) continue;

        // anti-spam
        const now = Date.now();
        if (cooldown.get(authorId) && now - cooldown.get(authorId) < 4000)
          continue;

        cooldown.set(authorId, now);

        console.log(`🎯 MATCH: ${user}: ${text}`);
        await notify(user, text, videoId);
      }

      token =
        data?.continuationContents?.liveChatContinuation
          ?.continuations?.[0]?.timedContinuationData?.continuation;

      await sleep(POLL_INTERVAL);

    } catch (err) {
      console.log("poll error:", err.message);
      await sleep(5000);
    }
  }
}

// ======================================================
// START SYSTEM
// ======================================================
async function start() {
  console.log("🚀 SYSTEM STARTED");

  VIDEO_IDS.forEach(id => waitForChat(id));

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
// HEALTH
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
