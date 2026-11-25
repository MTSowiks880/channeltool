const { clip, handle, getUser, isAdmin, canPost } = require("../lib/util");

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const cleanImages = (items) => (Array.isArray(items) ? items : [])
  .filter((src) => typeof src === "string" && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(src) && src.length <= 600000)
  .slice(0, 4);

module.exports = handle(async (req, res, redis) => {
  const user = await getUser(redis, req);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  if (!canPost(user)) return res.status(403).json({ error: "Your account is not approved yet." });

  if (req.method === "GET") {
    const channelId = clip((req.query || {}).channelId, 48);
    if (channelId) {
      const rawChannel = await redis.hget("forum_channels", channelId);
      if (!rawChannel) return res.status(404).json({ error: "Channel not found." });
      const rawMessages = await redis.lrange("forum_messages:" + channelId, 0, 499);
      return res.status(200).json({ messages: rawMessages.map((r) => JSON.parse(r)) });
    }
    const all = Object.values(await redis.hgetall("forum_channels")).map((r) => JSON.parse(r));
    const channels = await Promise.all(all.map(async (c) => ({
      ...c,
      messageCount: await redis.llen("forum_messages:" + c.id)
    })));
    channels.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.status(200).json({ channels });
  }

  if (req.method === "POST") {
    const body = req.body || {};

    if (body.action === "create-channel") {
      const name = clip(body.name, 40).toLowerCase().replace(/[^a-z0-9-_ ]/g, "").trim().replace(/\s+/g, "-");
      if (!name) return res.status(400).json({ error: "A valid channel name is required." });
      const all = Object.values(await redis.hgetall("forum_channels")).map((r) => JSON.parse(r));
      if (all.length >= 50) return res.status(409).json({ error: "The forum has reached its 50-channel limit." });
      if (all.some((c) => c.name.toLowerCase() === name)) return res.status(409).json({ error: "A channel with this name already exists." });
      const channel = {
        id: newId(),
        name,
        description: clip(body.description, 120),
        createdBy: user.id,
        createdByName: user.name,
        createdAt: new Date().toISOString()
      };
      await redis.hset("forum_channels", channel.id, JSON.stringify(channel));
      return res.status(201).json(channel);
    }

    if (body.action === "send-message") {
      const channelId = clip(body.channelId, 48);
      const rawChannel = await redis.hget("forum_channels", channelId);
      if (!rawChannel) return res.status(404).json({ error: "Channel not found." });
      const text = clip(body.text, 3000);
      const images = cleanImages(body.images);
      if (!text && !images.length) return res.status(400).json({ error: "Write a message or attach an image." });
      const message = {
        id: newId(),
        uid: user.id,
        author: user.name,
        avatar: user.avatar || "",
        text,
        images,
        at: new Date().toISOString()
      };
      const key = "forum_messages:" + channelId;
      await redis.lpush(key, JSON.stringify(message));
      await redis.ltrim(key, 0, 499);
      return res.status(201).json(message);
    }
    return res.status(400).json({ error: "Unknown forum action." });
  }

  if (req.method === "DELETE") {
    const channelId = clip((req.query || {}).channelId, 48);
    const messageId = clip((req.query || {}).messageId, 48);
    const channelIdForDelete = channelId || clip((req.query || {}).id, 48);
    if (!channelIdForDelete) return res.status(400).json({ error: "Channel id is required." });
    const rawChannel = await redis.hget("forum_channels", channelIdForDelete);
    if (!rawChannel) return res.status(404).json({ error: "Channel not found." });

    if (messageId) {
      const key = "forum_messages:" + channelIdForDelete;
      const rows = await redis.lrange(key, 0, -1);
      const hit = rows.find((row) => {
        try { return JSON.parse(row).id === messageId; } catch (_) { return false; }
      });
      if (!hit) return res.status(404).json({ error: "Message not found." });
      const message = JSON.parse(hit);
      if (!isAdmin(user) && message.uid !== user.id) return res.status(403).json({ error: "You can only delete your own messages." });
      await redis.lrem(key, 1, hit);
      return res.status(200).json({ ok: true });
    }

    const channel = JSON.parse(rawChannel);
    if (!isAdmin(user) && channel.createdBy !== user.id) return res.status(403).json({ error: "Only the channel creator or an admin can delete this channel." });
    await redis.hdel("forum_channels", channelIdForDelete);
    await redis.del("forum_messages:" + channelIdForDelete);
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed." });
});
