import fetch from "node-fetch";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ENV CONFIG =====
const API_KEY = process.env.YOUTUBE_API_KEY;
const TARGET_CHANNEL_IDS = process.env.TARGET_CHANNEL_IDS?.split(",") || [];
const TARGET_VIDEO_IDS = process.env.TARGET_VIDEO_IDS?.split(",") || [];
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5000");

// ===== STATE =====
const liveChatMap = new Map(); // videoId -> liveChatId
const seenMessages = new Set();
const userCooldown = new Map(); // anti-spam

// ===== UTIL =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanOldCache() {
  if (seenMessages.size > 10000) {
    const arr = Array.from(seenMessages).slice(-5000);
    seenMessages.clear();
    arr.forEach((id) => seenMessages.add(id));
  }
}

// ===== FETCH LIVE CHAT ID =====
async function getLiveChatId(videoId) {
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    const chatId = data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;

    if (chatId) {
      liveChatMap.set(videoId, chatId);
      console.log(`✔ LiveChat found for ${videoId}`);
    } else {
      console.log(`⏳ Waiting for live chat: ${videoId}`);
    }
  } catch (err) {
    console.error("Error fetching liveChatId:", err.message);
  }
}

// ===== SEND NOTIFICATION =====
async function sendNotification(username, message, videoId) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      body: `📺 ${videoId}\n👤 ${username}\n💬 ${message}`,
    });
  } catch (err) {
    console.error("ntfy error:", err.message);
  }
}

// ===== PROCESS MESSAGES =====
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

      for (const item of data.items) {
        const messageId = item.id;
        const authorId = item.authorDetails.channelId;

        if (seenMessages.has(messageId)) continue;
        seenMessages.add(messageId);

        if (!TARGET_CHANNEL_IDS.includes(authorId)) continue;

        const username = item.authorDetails.displayName;
        const message = item.snippet.displayMessage;

        // ===== Anti-spam cooldown =====
        const now = Date.now();
        const last = userCooldown.get(authorId) || 0;
        if (now - last < 5000) continue;
        userCooldown.set(authorId, now);

        console.log(`🎯 Match: ${username} in ${videoId}`);

        await sendNotification(username, message, videoId);
      }

      pageToken = data.nextPageToken;
      cleanOldCache();

      await sleep(POLL_INTERVAL);
    } catch (err) {
      console.error(`Polling error (${videoId}):`, err.message);
      await sleep(5000);
    }
  }
}

// ===== INIT SYSTEM =====
async function start() {
  console.log("🚀 Starting system...");

  for (const videoId of TARGET_VIDEO_IDS) {
    await getLiveChatId(videoId);
  }

  // Retry fetching chat IDs every 30s if missing
  setInterval(async () => {
    for (const videoId of TARGET_VIDEO_IDS) {
      if (!liveChatMap.has(videoId)) {
        await getLiveChatId(videoId);
      }
    }
  }, 30000);

  // Start polling each chat
  setInterval(() => {
    for (const [videoId, chatId] of liveChatMap.entries()) {
      if (!chatId._started) {
        chatId._started = true;
        pollChat(videoId, chatId);
      }
    }
  }, 2000);
}

// ===== HEALTH CHECK =====
app.get("/status", (req, res) => {
  res.json({
    status: "running",
    videos: TARGET_VIDEO_IDS.length,
    users: TARGET_CHANNEL_IDS.length,
    activeChats: liveChatMap.size,
    cacheSize: seenMessages.size,
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  start();
});
