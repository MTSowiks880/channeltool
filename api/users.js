const { handle, getUser, isAdmin } = require("../lib/util");

module.exports = handle(async (req, res, redis) => {
  const me = await getUser(redis, req);
  if (!isAdmin(me)) return res.status(403).json({ error: "Admins only." });

  if (req.method === "GET") {
    const all = await redis.hgetall("users");
    const users = Object.values(all).map((r) => JSON.parse(r));
    users.forEach((u) => { if (u.id === process.env.OWNER_ID) u.role = "owner"; });
    return res.status(200).json({ users });
  }
  if (req.method === "POST") {
    const { id, action } = req.body || {};
    const raw = await redis.hget("users", String(id));
    if (!raw) return res.status(404).json({ error: "User not found." });
    const t = JSON.parse(raw);
    if (t.id === process.env.OWNER_ID) return res.status(403).json({ error: "The owner cannot be changed." });
    const ownerOnly = action === "promote" || action === "demote";
    if (ownerOnly && me.role !== "owner") return res.status(403).json({ error: "Only the owner can change admins." });
    if (t.role === "admin" && me.role !== "owner") return res.status(403).json({ error: "Only the owner can act on admins." });
    const roles = { approve: "mod", kick: "banned", promote: "admin", demote: "mod" };
    if (!roles[action]) return res.status(400).json({ error: "Unknown action." });
    t.role = roles[action];
    await redis.hset("users", t.id, JSON.stringify(t));
    return res.status(200).json({ ok: true });
  }
  res.status(405).json({ error: "Method not allowed." });
});
