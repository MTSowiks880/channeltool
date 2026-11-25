const { clip, handle, getUser, isAdmin, canPost } = require("../lib/util");

module.exports = handle(async (req, res, redis) => {
  const u = await getUser(redis, req);
  if (!u) return res.status(401).json({ error: "Not signed in." });
  if (!canPost(u)) return res.status(403).json({ error: "Your account is not approved yet." });

  if (req.method === "GET") {
    if ((req.query || {}).stats === "1") {
      const [rawLogs, rawTickets] = await Promise.all([
        redis.lrange("logs", 0, -1),
        redis.hgetall("tickets"),
      ]);
      const parse = (rows) => rows.map((r) => {
        try { return typeof r === "string" ? JSON.parse(r) : r; } catch (_) { return null; }
      }).filter(Boolean);
      return res.status(200).json({ logs: parse(rawLogs || []), tickets: parse(Object.values(rawTickets || {})) });
    }
    const raw = await redis.lrange("logs", 0, 199);
    return res.status(200).json(raw.map((r) => JSON.parse(r)));
  }
  if (req.method === "POST") {
    const b = req.body || {};
    const target = clip(b.target, 80);
    if (!target) return res.status(400).json({ error: "Target is required." });
    const images = (Array.isArray(b.images) ? b.images : [])
      .filter((i) => typeof i === "string" && i.startsWith("data:image/") && i.length < 600000)
      .slice(0, 4);
    const log = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      uid: u.id, mod: u.name, avatar: u.avatar, target,
      action: clip(b.action, 40) || "Other",
      note: clip(b.note, 2000),
      images,
      at: new Date().toISOString(),
    };
    await redis.lpush("logs", JSON.stringify(log));
    return res.status(201).json(log);
  }
  if (req.method === "DELETE") {
    const id = String((req.query || {}).id || "");
    const raw = await redis.lrange("logs", 0, -1);
    const hit = raw.find((r) => JSON.parse(r).id === id);
    if (!hit) return res.status(404).json({ error: "Log not found." });
    if (!isAdmin(u) && JSON.parse(hit).uid !== u.id) return res.status(403).json({ error: "You can only delete your own logs." });
    await redis.lrem("logs", 1, hit);
    return res.status(200).json({ ok: true });
  }
  res.status(405).json({ error: "Method not allowed." });
});
