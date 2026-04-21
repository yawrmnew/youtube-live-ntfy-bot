import fetch from "node-fetch";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ENV =====
const API_KEY = process.env.YOUTUBE_API_KEY;
const TARGET_CHANNEL_IDS = process.env.TARGET_CHANNEL_IDS?.split(",") || [];
const TARGET_VIDEO_IDS = process.env.TARGET_VIDEO_IDS?.split(",") || [];
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5000");

// ===== STATE =====
const liveChatMap = new Map();      // videoId -> liveChatId
const seenMessages = new Set();     // dedup
const startedPollers = new Set();   // FIX: prevents crash + duplicates
const userCooldown = new Map();

// ===== UTIL =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanCache() {
  if (seenMessages.size > 10000) {
    const keep = Array.from(seenMessages).slice(-5000);
    seenMessages.clear();
    keep.forEach((m) => seenMessages.add(m));
  }
}

// ===== GET LIVE CHAT ID =====
async function getLiveChatId(videoId) {
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    const item = data.items?.[0];
    const chatId = item?.liveStreamingDetails?.activeLiveChatId;

    if (chatId) {
      liveChatMap.set(videoId, chatId);
      console.log(`✔ LiveChat found for ${videoId}`);
    } else {
      console.log(`⏳ Waiting for live chat: ${videoId}`);
    }
  } catch (err) {
    console.error("getLiveChatId error:", err.message);
  }
}

// ===== NOTIFY =====
async function notify(username, message, videoId) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      body: `📺 ${videoId}\n👤 ${username}\n💬 ${message}`,
    });
  } catch (err) {
    console.error("ntfy error:", err.message);
  }
}

// ===== POLL CHAT =====
async function pollChat(videoId, liveChatId) {
  let pageToken = "";

  while (true) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&pageToken=${pageToken}&key=${API_KEY}`;

      const res = await fetch(url);
      const data = await res.json();

      if (!data.items) {
        await sleep(3000);
        continue;
      }

      for (const msg of data.items) {
        const msgId = msg.id;
        const authorId = msg.authorDetails.channelId;

        if (seenMessages.has(msgId)) continue;
        seenMessages.add(msgId);

        if (!TARGET_CHANNEL_IDS.includes(authorId)) continue;

        const username = msg.authorDetails.displayName;
        const text = msg.snippet.displayMessage;

        // anti-spam cooldown
        const now = Date.now();
        const last = userCooldown.get(authorId) || 0;
        if (now - last < 5000) continue;
        userCooldown.set(authorId, now);

        console.log(`🎯 Match: ${username} in ${videoId}`);

        await notify(username, text, videoId);
      }

      pageToken = data.nextPageToken;
      cleanCache();

      await sleep(POLL_INTERVAL);
    } catch (err) {
      console.error(`poll error (${videoId}):`, err.message);
      await sleep(5000);
    }
  }
}

// ===== START SYSTEM =====
async function start() {
  console.log("🚀 Starting system...");

  // initial fetch
  for (const videoId of TARGET_VIDEO_IDS) {
    await getLiveChatId(videoId);
  }

  // retry missing chat IDs
  setInterval(async () => {
    for (const videoId of TARGET_VIDEO_IDS) {
      if (!liveChatMap.has(videoId)) {
        await getLiveChatId(videoId);
      }
    }
  }, 30000);

  // START POLLERS (FIXED)
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

// ===== STATUS ENDPOINT =====
app.get("/status", (req, res) => {
  res.json({
    status: "running",
    videos: TARGET_VIDEO_IDS.length,
    activeChats: liveChatMap.size,
    seenMessages: seenMessages.size,
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  start();
});
