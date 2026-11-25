const { clip, handle, getUser, isAdmin } = require("../lib/util");
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const cleanImages = (items) => (Array.isArray(items) ? items : []).filter((src) => typeof src === "string" && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(src) && src.length <= 600000).slice(0, 4);
module.exports = handle(async (req, res, redis) => {
  const user = await getUser(redis, req);
  if (!user || ["pending", "banned"].includes(user.role)) return res.status(401).json({ error: "Not signed in or account not approved." });
  const key = "announcements";
  if (req.method === "GET") { const rows = await redis.lrange(key, 0, 99); return res.status(200).json({ announcements: rows.map(r => JSON.parse(r)) }); }
  if (req.method === "POST") {
    if (!isAdmin(user)) return res.status(403).json({ error: "Only admins can publish announcements." });
    const body = req.body || {}; const text = clip(body.text, 4000); const images = cleanImages(body.images);
    if (!text && !images.length) return res.status(400).json({ error: "Write an announcement or attach an image." });
    const item = { id: newId(), uid: user.id, author: user.name, avatar: user.avatar || "", role: user.role, text, images, at: new Date().toISOString() };
    await redis.lpush(key, JSON.stringify(item)); await redis.ltrim(key, 0, 99); return res.status(201).json(item);
  }
  if (req.method === "DELETE") {
    if (!isAdmin(user)) return res.status(403).json({ error: "Only admins can delete announcements." });
    const id = clip((req.query || {}).id, 48); if (!id) return res.status(400).json({ error: "Announcement id is required." });
    const rows = await redis.lrange(key, 0, -1); const hit = rows.find(row => { try { return JSON.parse(row).id === id; } catch (_) { return false; } });
    if (!hit) return res.status(404).json({ error: "Announcement not found." }); await redis.lrem(key, 1, hit); return res.status(200).json({ ok: true });
  }
  res.setHeader("Allow", "GET, POST, DELETE"); return res.status(405).json({ error: "Method not allowed." });
});
