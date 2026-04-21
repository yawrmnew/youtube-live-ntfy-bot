import fetch from "node-fetch";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG =================
const TARGET_VIDEO_IDS = process.env.TARGET_VIDEO_IDS?.split(",") || [];
const TARGET_CHANNEL_IDS = process.env.TARGET_CHANNEL_IDS?.split(",") || [];
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const POLL_INTERVAL = 3000;

// ================= STATE =================
const liveChatMap = new Map();
const startedPollers = new Set();
const seenMessages = new Set();
const cooldown = new Map();

// ================= HEADERS =================
const headers = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Origin": "https://www.youtube.com",
  "Referer": "https://www.youtube.com/"
};

// ================= UTIL =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanCache() {
  if (seenMessages.size > 10000) {
    const keep = Array.from(seenMessages).slice(-5000);
    seenMessages.clear();
    keep.forEach((m) => seenMessages.add(m));
  }
}

// ================= SAFE LIVE CHAT FETCH =================
async function getLiveChatId(videoId) {
  try {
    const res = await fetch(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
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
          videoId
        })
      }
    );

    const data = await res.json();

    // ===== TRY MULTIPLE PATHS (YouTube changes often) =====
    let chatId =
      data?.liveStreamingDetails?.activeLiveChatId ||
      data?.engagementPanels?.find(p =>
        p.engagementPanelSectionListRenderer
      )?.engagementPanelSectionListRenderer?.content
        ?.liveChatRenderer?.continuations?.[0]
        ?.timedContinuationData?.continuation;

    if (!chatId) {
      console.log(`⏳ No live chat yet for ${videoId}`);
      return;
    }

    liveChatMap.set(videoId, chatId);

    console.log(`✔ LiveChat READY for ${videoId}`);

  } catch (err) {
    console.error("getLiveChatId error:", err.message);
  }
}

// ================= NOTIFY =================
async function notify(user, msg, videoId) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      body: `📺 ${videoId}\n👤 ${user}\n💬 ${msg}`
    });
  } catch (err) {
    console.error("ntfy error:", err.message);
  }
}

// ================= POLL CHAT =================
async function pollChat(videoId, chatId) {
  let continuation = chatId;

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
            continuation
          })
        }
      );

      const data = await res.json();

      const actions =
        data?.continuationContents?.liveChatContinuation?.actions || [];

      for (const action of actions) {
        const msg =
          action?.replayChatItemAction?.actions?.[0]
            ?.addChatItemAction?.item?.liveChatTextMessageRenderer;

        if (!msg) continue;

        const id = msg.id;
        const text =
          msg.message?.runs?.map(r => r.text).join("") || "";
        const user = msg.authorName?.simpleText || "unknown";
        const authorId = msg.authorExternalChannelId;

        if (seenMessages.has(id)) continue;
        seenMessages.add(id);

        if (!TARGET_CHANNEL_IDS.includes(authorId)) continue;

        const now = Date.now();
        const last = cooldown.get(authorId) || 0;
        if (now - last < 5000) continue;
        cooldown.set(authorId, now);

        console.log(`🎯 ${user}: ${text}`);

        await notify(user, text, videoId);
      }

      continuation =
        data?.continuationContents?.liveChatContinuation
          ?.continuations?.[0]?.timedContinuationData?.continuation;

      cleanCache();

      await sleep(POLL_INTERVAL);

    } catch (err) {
      console.error(`poll error (${videoId}):`, err.message);
      await sleep(5000);
    }
  }
}

// ================= START SYSTEM =================
async function start() {
  console.log("🚀 NO-KEY system starting...");

  // Step 1: resolve all live chats
  for (const id of TARGET_VIDEO_IDS) {
    await getLiveChatId(id);
  }

  // Step 2: retry until live chat becomes available
  setInterval(async () => {
    for (const id of TARGET_VIDEO_IDS) {
      if (!liveChatMap.has(id)) {
        await getLiveChatId(id);
      }
    }
  }, 15000);

  // Step 3: start pollers safely (FIXED)
  setInterval(() => {
    for (const [videoId, chatId] of liveChatMap.entries()) {
      if (!startedPollers.has(videoId)) {
        startedPollers.add(videoId);
        console.log(`▶ Starting poller for ${videoId}`);
        pollChat(videoId, chatId);
      }
    }
  }, 2000);
}

// ================= HEALTH =================
app.get("/status", (req, res) => {
  res.json({
    status: "running",
    streams: liveChatMap.size,
    messagesSeen: seenMessages.size
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Running on ${PORT}`);
  start();
});
