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
    "com.google.android.youtube/19.09.37 (Linux; Android 11)",
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ======================================================
// 🔥 FINAL DETECTION (IFRAME METHOD - STABLE)
// ======================================================
async function getLiveChatId(videoId) {
  try {
    const html = await fetch(
      `https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`,
      { headers }
    ).then(r => r.text());

    const match = html.match(/"continuation":"(.*?)"/);

    if (!match?.[1]) return false;

    const continuation = match[1];

    liveChats.set(videoId, continuation);

    return true;

  } catch (err) {
    console.log("detect error:", err.message);
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

    await sleep(5000);
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
// POLLER (ANDROID CLIENT)
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

      const chat = data?.continuationContents?.liveChatContinuation;

      if (!chat) {
        console.log("⚠️ chat missing, retry...");
        await sleep(3000);
        continue;
      }

      const actions = chat.actions || [];

      console.log("ACTIONS:", actions.length);

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

        console.log("RAW:", user, authorId, text);

        // FILTER (optional — comment for testing)
        if (CHANNEL_IDS.length && !CHANNEL_IDS.includes(authorId)) continue;

        // anti-spam
        const now = Date.now();
        if (cooldown.get(authorId) && now - cooldown.get(authorId) < 3000)
          continue;

        cooldown.set(authorId, now);

        console.log(`🎯 MATCH: ${user}: ${text}`);

        await notify(user, text, videoId);
      }

      token =
        chat?.continuations?.[0]?.timedContinuationData?.continuation;

      if (!token) {
        console.log("⚠️ token lost, stopping poll");
        break;
      }

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
