const { handle, getUser, isAdmin, clip } = require("../lib/util");

// owner > developer > admin > trainer > mod > (pending / banned)
const RANK = { banned: 0, pending: 0, mod: 1, trainer: 1.5, admin: 2, developer: 3, owner: 4 };
const rank = (r) => RANK[r] || 0;
const parse = (rows) => (rows || []).map((r) => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);

// Admin audit trail (shown in the Admin section).
const audit = (redis, me, text) =>
  redis.lpush("adminlog", JSON.stringify({ by: me.name, uid: me.id, text, at: new Date().toISOString() }))
    .then(() => redis.ltrim("adminlog", 0, 199));

module.exports = handle(async (req, res, redis) => {
  const me = await getUser(redis, req);
  if (!isAdmin(me)) return res.status(403).json({ error: "Admins only." });
  const mr = rank(me.role);
  const q = req.query || {};

  if (req.method === "GET") {
    if (q.overview === "1") {
      const [all, logs, tickets, quizzes, subs, chans, anns, adminlog] = await Promise.all([
        redis.hgetall("users"), redis.llen("logs"), redis.hgetall("tickets"), redis.hlen("quizzes"),
        redis.hlen("subs"), redis.llen("forum:channels"), redis.llen("announcements"), redis.lrange("adminlog", 0, 49),
      ]);
      const roles = {};
      Object.values(all).forEach((r) => {
        const u = JSON.parse(r);
        const role = u.id === process.env.OWNER_ID ? "owner" : u.role;
        roles[role] = (roles[role] || 0) + 1;
      });
      const tk = Object.values(tickets || {}).map((r) => JSON.parse(r));
      return res.status(200).json({
        roles, members: Object.keys(all).length, logs,
        tickets: tk.length, ticketsOpen: tk.filter((t) => t.status !== "closed").length,
        quizzes, submissions: subs, channels: chans, announcements: anns,
        adminlog: parse(adminlog),
      });
    }
    if (q.export === "1") {
      if (mr < 3) return res.status(403).json({ error: "Only a developer or the owner can export data." });
      const [users, logs, tickets, quizzes] = await Promise.all([
        redis.hgetall("users"), redis.lrange("logs", 0, -1), redis.hgetall("tickets"), redis.hgetall("quizzes"),
      ]);
      return res.status(200).json({
        exportedAt: new Date().toISOString(),
        users: Object.values(users).map((r) => JSON.parse(r)),
        logs: parse(logs), tickets: Object.values(tickets).map((r) => JSON.parse(r)),
        quizzes: Object.values(quizzes).map((r) => JSON.parse(r)),
      });
    }
    const all = await redis.hgetall("users");
    const users = Object.values(all).map((r) => JSON.parse(r));
    users.forEach((u) => { if (u.id === process.env.OWNER_ID) u.role = "owner"; });
    return res.status(200).json({ users });
  }

  if (req.method === "POST") {
    const b = req.body || {};
    const { id, action } = b;

    // ---- maintenance tools: developer / owner only ----
    if (["purgeLogs", "deleteUserLogs", "clearClosedTickets"].includes(action)) {
      if (mr < 3) return res.status(403).json({ error: "Only a developer or the owner can do this." });
      if (action === "purgeLogs") {
        const days = Math.max(1, Math.min(3650, parseInt(b.days, 10) || 0));
        if (!parseInt(b.days, 10)) return res.status(400).json({ error: "Give a number of days." });
        const cut = Date.now() - days * 864e5;
        const rows = await redis.lrange("logs", 0, -1);
        const keep = rows.filter((r) => { try { return new Date(JSON.parse(r).at).getTime() >= cut; } catch (_) { return true; } });
        const m = redis.multi().del("logs");
        if (keep.length) m.rpush("logs", ...keep);
        await m.exec();
        await audit(redis, me, `Purged logs older than ${days} days (${rows.length - keep.length} removed)`);
        return res.status(200).json({ ok: true, removed: rows.length - keep.length });
      }
      if (action === "deleteUserLogs") {
        const uid = String(id || "");
        if (!uid) return res.status(400).json({ error: "Pick a member." });
        const rows = await redis.lrange("logs", 0, -1);
        const keep = rows.filter((r) => { try { return JSON.parse(r).uid !== uid; } catch (_) { return true; } });
        const m = redis.multi().del("logs");
        if (keep.length) m.rpush("logs", ...keep);
        await m.exec();
        await audit(redis, me, `Deleted all logs by ${uid} (${rows.length - keep.length} removed)`);
        return res.status(200).json({ ok: true, removed: rows.length - keep.length });
      }
      const tk = await redis.hgetall("tickets");
      const dead = Object.entries(tk).filter(([, r]) => { try { return JSON.parse(r).status === "closed"; } catch (_) { return false; } }).map(([k]) => k);
      if (dead.length) await redis.hdel("tickets", ...dead);
      await audit(redis, me, `Cleared ${dead.length} closed tickets`);
      return res.status(200).json({ ok: true, removed: dead.length });
    }

    // ---- member tools ----
    const raw = await redis.hget("users", String(id));
    if (!raw) return res.status(404).json({ error: "User not found." });
    const t = JSON.parse(raw);
    if (t.id === process.env.OWNER_ID) return res.status(403).json({ error: "The owner cannot be changed." });

    // You can only act on someone ranked below you, and only grant a rank below yours.
    if (rank(t.role) >= mr) return res.status(403).json({ error: "You can only act on members ranked below you." });

    if (action === "deleteUser") {
      await redis.hdel("users", t.id);
      await audit(redis, me, `Deleted member ${t.name} (${t.id})`);
      return res.status(200).json({ ok: true });
    }

    const roles = {
      approve: "mod",
      kick: "banned",
      promote: "admin",
      demote: "mod",
      makeDeveloper: "developer",
      removeDeveloper: "admin",
      makeTrainer: "trainer",
      removeTrainer: "mod"
    };
    let next = roles[action];
    if (action === "setRole") {
      next = clip(b.role, 20);
      if (!(next in RANK) || next === "owner") return res.status(400).json({ error: "Unknown role." });
    }
    if (!next) return res.status(400).json({ error: "Unknown action." });
    if (rank(next) >= mr) {
      return res.status(403).json({
        error: next === "developer" ? "Only the owner can make developers." : "Only a developer or the owner can make admins."
      });
    }
    // Keep each action consistent with the current role.
    if (action === "approve" && !["pending", "banned"].includes(t.role)) return res.status(400).json({ error: "Already approved." });
    if (action === "promote" && rank(t.role) >= rank("admin")) return res.status(400).json({ error: "Already admin or higher." });
    if (action === "demote" && t.role !== "admin") return res.status(400).json({ error: "Not an admin." });
    if (action === "makeDeveloper" && rank(t.role) >= rank("developer")) return res.status(400).json({ error: "Already developer." });
    if (action === "makeTrainer" && rank(t.role) >= rank("trainer")) return res.status(400).json({ error: "Already trainer or higher." });
    if (action === "removeTrainer" && t.role !== "trainer") return res.status(400).json({ error: "Not a trainer." });
    if (action === "removeDeveloper" && t.role !== "developer") return res.status(400).json({ error: "Not a developer." });

    const prev = t.role;
    t.role = next;
    await redis.hset("users", t.id, JSON.stringify(t));
    await audit(redis, me, `${t.name}: ${prev} → ${next}`);
    return res.status(200).json({ ok: true });
  }
  res.status(405).json({ error: "Method not allowed." });
});
