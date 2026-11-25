const { clip, handle, getUser, isAdmin, canPost } = require("../lib/util");

const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const cleanImages = (items) =>
  (Array.isArray(items) ? items : [])
    .filter((src) =>
      typeof src === "string" &&
      /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(src) &&
      src.length <= 600000
    )
    .slice(0, 4);

const parseRows = (rows) => {
  const result = [];
  for (const row of rows) {
    try { result.push(JSON.parse(row)); } catch (_) {}
  }
  return result;
};

module.exports = handle(async (req, res, redis) => {
  const user = await getUser(redis, req);
  if (!user || ["pending", "banned"].includes(user.role)) {
    return res.status(401).json({ error: "Not signed in or account not approved." });
  }

  const query = req.query || {};
  const body = req.body || {};

  // Announcements
  if (query.__route === "announcements") {
    const key = "announcements";

    if (req.method === "GET") {
      const rows = await redis.lrange(key, 0, 99);
      return res.status(200).json({ announcements: parseRows(rows) });
    }

    if (req.method === "POST") {
      if (!isAdmin(user)) {
        return res.status(403).json({ error: "Only admins can publish announcements." });
      }
      const text = clip(body.text, 4000);
      const images = cleanImages(body.images);
      if (!text && !images.length) {
        return res.status(400).json({ error: "Write an announcement or attach an image." });
      }

      const item = {
        id: makeId(),
        uid: user.id,
        author: user.name,
        avatar: user.avatar || "",
        role: user.role,
        text,
        images,
        at: new Date().toISOString()
      };
      await redis.lpush(key, JSON.stringify(item));
      await redis.ltrim(key, 0, 99);
      return res.status(201).json(item);
    }

    if (req.method === "DELETE") {
      if (!isAdmin(user)) {
        return res.status(403).json({ error: "Only admins can delete announcements." });
      }
      const id = clip(query.id, 48);
      if (!id) return res.status(400).json({ error: "Announcement id is required." });

      const rows = await redis.lrange(key, 0, -1);
      const hit = rows.find((row) => {
        try { return JSON.parse(row).id === id; } catch (_) { return false; }
      });
      if (!hit) return res.status(404).json({ error: "Announcement not found." });
      await redis.lrem(key, 1, hit);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed." });
  }

  // Forum channels
  if (req.method === "GET" && !query.channelId) {
    const rows = await redis.lrange("forum:channels", 0, 99);
    const channels = parseRows(rows);
    for (const channel of channels) {
      channel.messageCount = await redis.llen("forum:channel:" + channel.id + ":messages");
    }
    return res.status(200).json({ channels });
  }

  if (req.method === "GET" && query.channelId) {
    const channelId = clip(query.channelId, 48);
    const channel = parseRows(await redis.lrange("forum:channels", 0, 99))
      .find((item) => item.id === channelId);
    if (!channel) return res.status(404).json({ error: "Channel not found." });
    const rows = await redis.lrange("forum:channel:" + channelId + ":messages", 0, 499);
    return res.status(200).json({ messages: parseRows(rows) });
  }

  if (req.method === "POST") {
    if (body.action === "create-channel") {
      if (!canPost(user)) {
        return res.status(403).json({ error: "Only moderators and admins can create channels." });
      }
      const name = clip(body.name, 40);
      const description = clip(body.description, 180);
      if (!name) return res.status(400).json({ error: "Channel name is required." });

      const channel = {
        id: makeId(),
        name,
        description,
        createdBy: user.id,
        createdByName: user.name,
        at: new Date().toISOString()
      };
      await redis.lpush("forum:channels", JSON.stringify(channel));
      await redis.ltrim("forum:channels", 0, 99);
      return res.status(201).json(channel);
    }

    if (body.action === "send-message") {
      const channelId = clip(body.channelId, 48);
      if (!channelId) return res.status(400).json({ error: "Channel id is required." });

      const channels = parseRows(await redis.lrange("forum:channels", 0, 99));
      if (!channels.some((item) => item.id === channelId)) {
        return res.status(404).json({ error: "Channel not found." });
      }

      const text = clip(body.text, 3000);
      const images = cleanImages(body.images);
      if (!text && !images.length) {
        return res.status(400).json({ error: "Write a message or attach an image." });
      }

      const message = {
        id: makeId(),
        uid: user.id,
        author: user.name,
        avatar: user.avatar || "",
        text,
        images,
        at: new Date().toISOString()
      };
      const key = "forum:channel:" + channelId + ":messages";
      await redis.lpush(key, JSON.stringify(message));
      await redis.ltrim(key, 0, 499);
      return res.status(201).json(message);
    }

    return res.status(400).json({ error: "Unknown forum action." });
  }

  if (req.method === "DELETE") {
    if (query.id) {
      const id = clip(query.id, 48);
      const rows = await redis.lrange("forum:channels", 0, 99);
      const hit = rows.find((row) => {
        try { return JSON.parse(row).id === id; } catch (_) { return false; }
      });
      if (!hit) return res.status(404).json({ error: "Channel not found." });

      const channel = JSON.parse(hit);
      if (!isAdmin(user) && channel.createdBy !== user.id) {
        return res.status(403).json({ error: "You cannot delete this channel." });
      }
      await redis.lrem("forum:channels", 1, hit);
      await redis.del("forum:channel:" + id + ":messages");
      return res.status(200).json({ ok: true });
    }

    const channelId = clip(query.channelId, 48);
    const messageId = clip(query.messageId, 48);
    if (!channelId || !messageId) {
      return res.status(400).json({ error: "Channel id and message id are required." });
    }

    const key = "forum:channel:" + channelId + ":messages";
    const rows = await redis.lrange(key, 0, 499);
    const hit = rows.find((row) => {
      try { return JSON.parse(row).id === messageId; } catch (_) { return false; }
    });
    if (!hit) return res.status(404).json({ error: "Message not found." });

    const message = JSON.parse(hit);
    if (!isAdmin(user) && message.uid !== user.id) {
      return res.status(403).json({ error: "You can only delete your own messages." });
    }
    await redis.lrem(key, 1, hit);
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed." });
});
