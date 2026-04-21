import fetch from "node-fetch";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const TARGET_VIDEO_IDS = process.env.TARGET_VIDEO_IDS?.split(",") || [];
const TARGET_CHANNEL_IDS = process.env.TARGET_CHANNEL_IDS?.split(",") || [];
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const POLL_INTERVAL = 3000;

// ===== STATE =====
const liveChatMap = new Map();
const seen = new Set();
const started = new Set();
const cooldown = new Map();

// ===== HEADERS (IMPORTANT FOR INNERTUBE) =====
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept": "*/*",
  "Content-Type": "application/json",
  "Origin": "https://www.youtube.com",
  "Referer": "https://www.youtube.com/"
};

// ===== GET LIVE CHAT ID (NO API KEY) =====
async function getLiveChatId(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    const res = await fetch(url, { headers });
    const html = await res.text();

    const match = html.match(/"liveChatRenderer":\{"continuations":\[\{"liveChatContinuation":\{"continuation":"(.*?)"/);

    if (!match) {
      console.log(`⏳ No live chat yet for ${videoId}`);
      return;
    }

    const chatId = match[1];

    liveChatMap.set(videoId, chatId);
    console.log(`✔ LiveChat found (NO KEY) for ${videoId}`);

  } catch (err) {
    console.error("chatId error:", err.message);
  }
}

// ===== SEND NTFY =====
async function notify(user, msg, videoId) {
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    body: `📺 ${videoId}\n👤 ${user}\n💬 ${msg}`
  });
}

// ===== POLL CHAT (INNERTUBE) =====
async function poll(videoId, chatId) {
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
        data.continuationContents?.liveChatContinuation?.actions || [];

      for (const action of actions) {
        const msg =
          action?.replayChatItemAction?.actions?.[0]
            ?.addChatItemAction?.item?.liveChatTextMessageRenderer;

        if (!msg) continue;

        const id = msg.id;
        const text = msg.message?.runs?.map(r => r.text).join("") || "";
        const user = msg.authorName?.simpleText || "unknown";
        const authorId = msg.authorExternalChannelId;

        if (seen.has(id)) continue;
        seen.add(id);

        if (!TARGET_CHANNEL_IDS.includes(authorId)) continue;

        const now = Date.now();
        if (cooldown.get(authorId) && now - cooldown.get(authorId) < 5000)
          continue;

        cooldown.set(authorId, now);

        console.log(`🎯 ${user}: ${text}`);

        await notify(user, text, videoId);
      }

      continuation =
        data.continuationContents?.liveChatContinuation?.continuations?.[0]
          ?.timedContinuationData?.continuation;

      await new Promise(r => setTimeout(r, POLL_INTERVAL));

    } catch (err) {
      console.error("poll error:", err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ===== START SYSTEM =====
async function start() {
  console.log("🚀 NO-KEY system starting...");

  for (const id of TARGET_VIDEO_IDS) {
    await getLiveChatId(id);
  }

  setInterval(async () => {
    for (const id of TARGET_VIDEO_IDS) {
      if (!liveChatMap.has(id)) {
        await getLiveChatId(id);
      }
    }
  }, 15000);

  setInterval(() => {
    for (const [videoId, chatId] of liveChatMap.entries()) {
      if (!started.has(videoId)) {
        started.add(videoId);
        console.log(`▶ Starting chat: ${videoId}`);
        poll(videoId, chatId);
      }
    }
  }, 2000);
}

// ===== HEALTH =====
app.get("/status", (req, res) => {
  res.json({
    status: "running",
    streams: liveChatMap.size,
    seen: seen.size
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Running on ${PORT}`);
  start();
});
