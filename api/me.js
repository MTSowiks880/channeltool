const { handle, getUser, clip } = require("../lib/util");

const pub = (u) => ({
  id: u.id, name: u.name, username: u.username, avatar: u.avatar, banner: u.banner,
  color: u.color, accent: u.accent || "", role: u.id === process.env.OWNER_ID ? "owner" : u.role,
  bio: u.bio || "", status: u.status || "", joined: u.joined || null, seen: u.seen || null,
});

module.exports = handle(async (req, res, redis) => {
  const me = await getUser(redis, req, true);
  if (!me) return res.status(401).json({ error: "Not signed in." });

  const mt = await redis.get("maint");
  if (mt && !["owner", "developer"].includes(me.role)) {
    let m = {}; try { m = JSON.parse(mt); } catch (_) {}
    if (m.on) return res.status(503).json({ maintenance: true, error: m.msg || "Maintenance in progress. Come back soon." });
  }

  if (req.method === "GET") {
    const id = String((req.query || {}).id || "");
    if (!id) {
      let pin = null;
      if (!["pending", "banned"].includes(me.role)) { try { pin = JSON.parse((await redis.get("pin")) || "null"); } catch (_) {} }
      return res.status(200).json({ user: me, pin });
    }
    const raw = await redis.hget("users", id);
    if (!raw) return res.status(404).json({ error: "This member has no profile yet." });
    const logs = (await redis.lrange("logs", 0, -1)).map((r) => JSON.parse(r)).filter((l) => l.uid === id);
    return res.status(200).json({
      user: pub(JSON.parse(raw)),
      logs: logs.length,
      lastLog: logs[0] ? logs[0].at : null,
    });
  }

  if (req.method === "POST") {
    const b = req.body || {};
    const raw = await redis.hget("users", me.id);
    const u = JSON.parse(raw);
    u.bio = clip(b.bio, 200);
    u.status = clip(b.status, 60);
    u.accent = /^#[0-9a-f]{6}$/i.test(b.accent || "") ? b.accent : "";
    await redis.hset("users", u.id, JSON.stringify(u));
    if (u.id === process.env.OWNER_ID) u.role = "owner";
    return res.status(200).json({ user: u });
  }
  res.status(405).json({ error: "Method not allowed." });
});
