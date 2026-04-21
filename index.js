import fetch from "node-fetch";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG =================
const VIDEO_IDS = process.env.TARGET_VIDEO_IDS?.split(",") || [];
const CHANNEL_IDS = process.env.TARGET_CHANNEL_IDS?.split(",") || [];
const NTFY_TOPIC = process.env.NTFY_TOPIC;

const POLL_INTERVAL = 4000;
const RECONNECT_INTERVAL = 15000;
const MAX_RETRY_BACKOFF = 60000;

// ================= STATE =================
const state = {
  chats: new Map(),
  started: new Set(),
  seen: new Set(),
  retryCount: new Map(),
  queue: []
};

// ================= UTIL =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const log = (type, data) => {
  console.log(`[${new Date().toISOString()}] [${type}]`, data);
};

// ================= SAFE JSON =================
async function safeJson(res) {
  const text = await res.text();
  return JSON.parse(text.replace(/^\)\]\}'\s*\n?/, ""));
}

// ================= CHAT DISCOVERY =================
async function getLiveChatId(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&pbj=1`
    );

    const data = await safeJson(res);
    const blocks = Array.isArray(data) ? data : [data];

    let continuation = null;

    for (const d of blocks) {
      continuation =
        d?.response?.contents?.twoColumnWatchNextResults
          ?.conversationBar?.liveChatRenderer?.continuations?.[0]
          ?.reloadContinuationData?.continuation;

      if (continuation) break;
    }

    if (!continuation) throw new Error("NO_CHAT_FOUND");

    state.chats.set(videoId, continuation);
    state.retryCount.set(videoId, 0);

    log("CHAT_READY", videoId);
    return true;

  } catch (err) {
    const count = (state.retryCount.get(videoId) || 0) + 1;
    state.retryCount.set(videoId, count);

    const backoff = Math.min(5000 * count, MAX_RETRY_BACKOFF);

    log("CHAT_FAIL", {
      videoId,
      retry: count,
      backoff
    });

    await sleep(backoff);
    return false;
  }
}

// ================= SELF-HEALING WATCHDOG =================
async function watchdog(videoId) {
  while (true) {
    if (!state.chats.has(videoId)) {
      await getLiveChatId(videoId);
    }

    await sleep(RECONNECT_INTERVAL);
  }
}

// ================= NTFY QUEUE =================
async function processQueue() {
  while (true) {
    if (state.queue.length > 0) {
      const msg = state.queue.shift();

      try {
        await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
          method: "POST",
          body: msg
        });

        log("NTFY_OK", msg);

      } catch (err) {
        log("NTFY_FAIL", err.message);
        state.queue.push(msg); // retry
      }
    }

    await sleep(1000);
  }
}

// ================= NOTIFY =================
function notify(user, text, videoId) {
  state.queue.push(`📺 ${videoId}\n👤 ${user}\n💬 ${text}`);
}

// ================= POLLER =================
async function poll(videoId) {
  while (true) {
    const continuation = state.chats.get(videoId);

    if (!continuation) {
      log("RECONNECT", videoId);
      await sleep(5000);
      continue;
    }

    try {
      const res = await fetch(
        "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
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

      for (const a of actions) {
        const msg =
          a?.replayChatItemAction?.actions?.[0]
            ?.addChatItemAction?.item?.liveChatTextMessageRenderer;

        if (!msg) continue;

        const id = msg.id;
        if (state.seen.has(id)) continue;
        state.seen.add(id);

        const text = msg.message?.runs?.map(r => r.text).join("") || "";
        const user = msg.authorName?.simpleText || "unknown";
        const authorId = msg.authorExternalChannelId;

        if (CHANNEL_IDS.length && authorId && !CHANNEL_IDS.includes(authorId)) {
          continue;
        }

        log("MSG", { user, text });

        notify(user, text, videoId);
      }

      const newToken =
        data?.continuationContents?.liveChatContinuation
          ?.continuations?.[0]?.timedContinuationData?.continuation;

      if (newToken) {
        state.chats.set(videoId, newToken);
      }

      await sleep(POLL_INTERVAL);

    } catch (err) {
      log("POLL_ERROR", err.message);

      // 🔥 SELF HEAL: reset chat state
      state.chats.delete(videoId);

      await sleep(5000);
    }
  }
}

// ================= BOOTSTRAP =================
async function start() {
  log("SYSTEM", "SELF-HEALING ENGINE STARTED");

  // start queue processor
  processQueue();

  // start watchdog + pollers
  for (const id of VIDEO_IDS) {
    watchdog(id);
    poll(id);
  }
}

// ================= HEALTH =================
app.get("/status", (req, res) => {
  res.json({
    chats: state.chats.size,
    queue: state.queue.length,
    seen: state.seen.size
  });
});

app.listen(PORT, () => {
  log("SERVER", `Running on ${PORT}`);
  start();
});
