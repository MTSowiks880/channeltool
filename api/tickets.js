const { clip, handle, getUser, isAdmin, canPost } = require("../lib/util");
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

module.exports = handle(async (req, res, redis) => {
  const u = await getUser(redis, req);
  if (!u) return res.status(401).json({ error: "Not signed in." });
  if (!canPost(u)) return res.status(403).json({ error: "Your account is not approved yet." });
  const admin = isAdmin(u);
  const get = async (id) => { const r = await redis.hget("tickets", String(id || "")); return r ? JSON.parse(r) : null; };
  const save = (t) => redis.hset("tickets", t.id, JSON.stringify(t));
  const msg = (text) => ({ uid: u.id, name: u.name, avatar: u.avatar, staff: admin, text, at: new Date().toISOString() });

  if (req.method === "GET") {
    let all = Object.values(await redis.hgetall("tickets")).map((r) => JSON.parse(r));
    if (!admin) all = all.filter((t) => t.uid === u.id);
    all.sort((a, b) => b.updated.localeCompare(a.updated));
    return res.status(200).json(all.slice(0, 200));
  }

  if (req.method === "POST") {
    const b = req.body || {};
    const text = clip(b.text, 2000);
    if (!text) return res.status(400).json({ error: "Message is required." });
    if (b.id) {
      const t = await get(b.id);
      if (!t) return res.status(404).json({ error: "Ticket not found." });
      if (!admin && t.uid !== u.id) return res.status(403).json({ error: "Not your ticket." });
      if (t.status === "closed") return res.status(409).json({ error: "This ticket is closed." });
      t.messages.push(msg(text)); t.updated = new Date().toISOString();
      await save(t);
      return res.status(200).json(t);
    }
    const subject = clip(b.subject, 100);
    if (!subject) return res.status(400).json({ error: "Subject is required." });
    const now = new Date().toISOString();
    const t = { id: newId(), uid: u.id, name: u.name, avatar: u.avatar, subject, status: "open", at: now, updated: now, messages: [msg(text)] };
    await save(t);
    return res.status(201).json(t);
  }

  if (req.method === "PUT") {
    const b = req.body || {};
    const t = await get(b.id);
    if (!t) return res.status(404).json({ error: "Ticket not found." });
    if (!admin && t.uid !== u.id) return res.status(403).json({ error: "Not your ticket." });
    if (!["open", "closed"].includes(b.status)) return res.status(400).json({ error: "Unknown status." });
    t.status = b.status; t.updated = new Date().toISOString();
    await save(t);
    return res.status(200).json(t);
  }

  if (req.method === "DELETE") {
    if (!admin) return res.status(403).json({ error: "Admins only." });
    const n = await redis.hdel("tickets", String((req.query || {}).id || ""));
    return n ? res.status(200).json({ ok: true }) : res.status(404).json({ error: "Ticket not found." });
  }
  res.status(405).json({ error: "Method not allowed." });
});
