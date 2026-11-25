const { clip, handle, getUser, isAdmin, canPost } = require("../lib/util");

const CATEGORIES = ["Staff", "Moderation", "Server", "Errors", "System"];
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

module.exports = handle(async (req, res, redis) => {
  const user = await getUser(redis, req);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  if (!canPost(user)) return res.status(403).json({ error: "Your account is not approved yet." });

  if (req.method === "GET") {
    const rows = await redis.lrange("forum:threads", 0, 199);
    const threads = [];
    for (const row of rows) {
      try { threads.push(JSON.parse(row)); } catch (_) {}
    }
    return res.status(200).json(threads);
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const threadId = clip(body.id, 48);

    // Reply to an existing topic.
    if (threadId) {
      const rows = await redis.lrange("forum:threads", 0, 199);
      const index = rows.findIndex((row) => {
        try { return JSON.parse(row).id === threadId; } catch (_) { return false; }
      });
      if (index < 0) return res.status(404).json({ error: "Topic not found." });

      const thread = JSON.parse(rows[index]);
      const message = clip(body.body, 3000);
      if (!message) return res.status(400).json({ error: "Reply cannot be empty." });
      thread.replies = Array.isArray(thread.replies) ? thread.replies : [];
      if (thread.replies.length >= 500) {
        return res.status(409).json({ error: "This topic has reached its reply limit." });
      }

      const now = new Date().toISOString();
      thread.replies.push({
        id: makeId(),
        uid: user.id,
        author: user.name,
        avatar: user.avatar || "",
        body: message,
        at: now
      });
      thread.updatedAt = now;
      await redis.lset("forum:threads", index, JSON.stringify(thread));
      return res.status(201).json(thread);
    }

    // Create a topic.
    const title = clip(body.title, 120);
    const message = clip(body.body, 5000);
    const category = CATEGORIES.includes(body.category) ? body.category : "Staff";
    if (!title || !message) {
      return res.status(400).json({ error: "A title and message are required." });
    }

    const now = new Date().toISOString();
    const thread = {
      id: makeId(),
      uid: user.id,
      author: user.name,
      avatar: user.avatar || "",
      title,
      body: message,
      category,
      replies: [],
      at: now,
      updatedAt: now
    };
    await redis.lpush("forum:threads", JSON.stringify(thread));
    await redis.ltrim("forum:threads", 0, 199);
    return res.status(201).json(thread);
  }

  if (req.method === "DELETE") {
    const id = clip((req.query || {}).id, 48);
    if (!id) return res.status(400).json({ error: "Topic id is required." });

    const rows = await redis.lrange("forum:threads", 0, 199);
    const index = rows.findIndex((row) => {
      try { return JSON.parse(row).id === id; } catch (_) { return false; }
    });
    if (index < 0) return res.status(404).json({ error: "Topic not found." });

    const raw = rows[index];
    const thread = JSON.parse(raw);
    if (!isAdmin(user) && thread.uid !== user.id) {
      return res.status(403).json({ error: "You can only delete your own topics." });
    }
    await redis.lrem("forum:threads", 1, raw);
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed." });
});
