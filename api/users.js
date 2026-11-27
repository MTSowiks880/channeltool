const { handle, getUser, isAdmin } = require("../lib/util");

// owner > developer > admin > mod > (pending / banned)
const RANK = { banned: 0, pending: 0, mod: 1, admin: 2, developer: 3, owner: 4 };
const rank = (r) => RANK[r] || 0;

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

    const roles = {
      approve: "mod",
      kick: "banned",
      promote: "admin",
      demote: "mod",
      makeDeveloper: "developer",
      removeDeveloper: "admin"
    };
    if (!roles[action]) return res.status(400).json({ error: "Unknown action." });
    const next = roles[action];

    // You can only act on someone ranked below you, and only grant a rank below yours.
    if (rank(t.role) >= rank(me.role)) {
      return res.status(403).json({ error: "You can only act on members ranked below you." });
    }
    if (rank(next) >= rank(me.role)) {
      return res.status(403).json({
        error: next === "developer" ? "Only the owner can make developers." : "Only a developer or the owner can make admins."
      });
    }
    // Keep each action consistent with the current role.
    if (action === "approve" && !["pending", "banned"].includes(t.role)) return res.status(400).json({ error: "Already approved." });
    if (action === "promote" && rank(t.role) >= rank("admin")) return res.status(400).json({ error: "Already admin or higher." });
    if (action === "demote" && t.role !== "admin") return res.status(400).json({ error: "Not an admin." });
    if (action === "makeDeveloper" && rank(t.role) >= rank("developer")) return res.status(400).json({ error: "Already developer." });
    if (action === "removeDeveloper" && t.role !== "developer") return res.status(400).json({ error: "Not a developer." });

    t.role = next;
    await redis.hset("users", t.id, JSON.stringify(t));
    return res.status(200).json({ ok: true });
  }
  res.status(405).json({ error: "Method not allowed." });
});
