const { handle, getUser, isAdmin, clip, notify } = require("../lib/util");

// owner > developer > admin > trainer > mod > (pending / banned)
const RANK = { banned: 0, pending: 0, mod: 1, trainer: 1.5, admin: 2, developer: 3, owner: 4 };
const rank = (r) => RANK[r] || 0;
const parse = (rows) => (rows || []).map((r) => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
const DAY = 864e5;

// Admin audit trail. `undo` (optional) lets an admin revert the action from the Admin section.
const audit = (redis, me, text, undo) =>
  (notify(`🛡️ **${me.name}**: ${text}`), redis.lpush("adminlog", JSON.stringify({ by: me.name, uid: me.id, text, at: new Date().toISOString(), ...(undo ? { undo } : {}) }))
    .then(() => redis.ltrim("adminlog", 0, 199)));

const readUsers = async (redis) => {
  const all = await redis.hgetall("users");
  const out = Object.values(all).map((r) => JSON.parse(r));
  out.forEach((u) => {
    if (u.id === process.env.OWNER_ID) u.role = "owner";
    else if (u.temp && Date.now() > u.temp.until) u.role = u.temp.back; // shown as ended; saved at next sign-in
  });
  return out;
};

module.exports = handle(async (req, res, redis) => {
  const me = await getUser(redis, req);
  if (!isAdmin(me)) return res.status(403).json({ error: "Admins only." });
  const mr = rank(me.role);
  const q = req.query || {};

  if (req.method === "GET") {
    if (q.overview === "1") {
      const [users, logs, tickets, quizzes, subs, chans, anns, adminlog, mt, pin] = await Promise.all([
        readUsers(redis), redis.llen("logs"), redis.hgetall("tickets"), redis.hlen("quizzes"),
        redis.hlen("subs"), redis.llen("forum:channels"), redis.llen("announcements"), redis.lrange("adminlog", 0, 49),
        redis.get("maint"), redis.get("pin"),
      ]);
      const roles = {};
      users.forEach((u) => { roles[u.role] = (roles[u.role] || 0) + 1; });
      const tk = Object.values(tickets || {}).map((r) => JSON.parse(r));
      let maint = { on: false, msg: "" }, pinned = null;
      const [lk, ro, qs] = await Promise.all([redis.get("lock"), redis.get("readonly"), redis.get("quest")]);
      let quest = null; try { quest = JSON.parse(qs || "null"); if (quest && quest.until < Date.now()) quest = null; } catch (_) {}
      try { if (mt) maint = JSON.parse(mt); } catch (_) {}
      try { if (pin) pinned = JSON.parse(pin); } catch (_) {}
      return res.status(200).json({
        roles, members: users.length, logs,
        tickets: tk.length, ticketsOpen: tk.filter((t) => t.status !== "closed").length,
        quizzes, submissions: subs, channels: chans, announcements: anns,
        adminlog: parse(adminlog), maint, pin: pinned, lock: !!lk, readonly: !!ro, quest,
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
    if (q.activity === "1") { // staff ranking, inactive staff, logs per day
      const days = [7, 30, 90].includes(+q.days) ? +q.days : 7;
      const [users, rows] = await Promise.all([readUsers(redis), redis.lrange("logs", 0, -1)]);
      const logs = parse(rows), now = Date.now(), cut = now - days * DAY;
      const staff = users.filter((u) => ["mod", "trainer", "admin", "developer", "owner"].includes(u.role));
      const last = {}, count = {}, perDay = {};
      logs.forEach((l) => {
        const t = new Date(l.at).getTime(); if (!t) return;
        if (!last[l.uid] || t > last[l.uid]) last[l.uid] = t;
        if (t >= cut) count[l.uid] = (count[l.uid] || 0) + 1;
        if (t >= now - 30 * DAY) { const d = new Date(t).toISOString().slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; }
      });
      const series = [];
      for (let i = 29; i >= 0; i--) { const d = new Date(now - i * DAY).toISOString().slice(0, 10); series.push({ d, n: perDay[d] || 0 }); }
      return res.status(200).json({
        days,
        ranking: staff.map((u) => ({ id: u.id, name: u.name, role: u.role, count: count[u.id] || 0 })).sort((a, b) => b.count - a.count),
        inactive: staff.filter((u) => !u.leave).filter((u) => !last[u.id] || last[u.id] < cut)
          .map((u) => ({ id: u.id, name: u.name, role: u.role, last: last[u.id] ? new Date(last[u.id]).toISOString() : null })),
        series,
      });
    }
    if (q.csv === "1") {
      const rows = parse(await redis.lrange("logs", 0, -1)), esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
      return res.status(200).json({ csv: ["id,date,mod,target,action,note,xp_multiplier", ...rows.map((l) => [l.id, l.at, l.mod, l.target, l.action, l.note, l.xm || 1].map(esc).join(","))].join("\n") });
    }
    if (q.health === "1") {
      const t0 = Date.now(); await redis.ping(); const ping = Date.now() - t0;
      const [logs, users, keys] = await Promise.all([redis.llen("logs"), redis.hlen("users"), redis.dbsize()]);
      const env = (k) => !!process.env[k];
      return res.status(200).json({ ping, logs, users, keys, env: { REDIS_URL: env("REDIS_URL"), SESSION_SECRET: env("SESSION_SECRET"), OWNER_ID: env("OWNER_ID"), SITE_URL: env("SITE_URL") }, node: process.version, at: new Date().toISOString() });
    }
    if (q.report === "1") { // copy-paste weekly report
      const days = [7, 30].includes(+q.days) ? +q.days : 7, cut = Date.now() - days * DAY;
      const [users, rows] = await Promise.all([readUsers(redis), redis.lrange("logs", 0, -1)]);
      const logs = parse(rows).filter((l) => new Date(l.at).getTime() >= cut);
      const act = {}, by = {};
      logs.forEach((l) => { act[l.action] = (act[l.action] || 0) + 1; by[l.mod] = (by[l.mod] || 0) + 1; });
      const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const fresh = users.filter((u) => new Date(u.joined).getTime() >= cut).length;
      const text = [`📊 Mod report (last ${days} days)`, `• ${logs.length} logs, ${fresh} new members, ${users.filter((u) => u.role === "pending").length} pending`,
        "• " + (Object.entries(act).map(([k, v]) => `${k} ${v}`).join(" · ") || "no actions"),
        ...top.map(([n, c], i) => `${["🥇", "🥈", "🥉", "4.", "5."][i]} ${n} — ${c}`)].join("\n");
      return res.status(200).json({ text });
    }
    if (q.logins === "1") return res.status(200).json({ logins: parse(await redis.lrange("logins", 0, 49)) });
    if (q.bans === "1") {
      const b = await redis.hgetall("idbans");
      return res.status(200).json({ bans: Object.entries(b).map(([id, r]) => ({ id, ...(JSON.parse(r) || {}) })) });
    }
    if (q.notes) {
      const raw = await redis.hget("notes", String(q.notes));
      return res.status(200).json({ notes: raw ? JSON.parse(raw) : [] });
    }
    return res.status(200).json({ users: await readUsers(redis) });
  }

  if (req.method === "POST") {
    let b = req.body || {};
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (_) { b = {}; } }
    const id = b.id;
    const action = String(b.action || "").trim();

    // ---- maintenance tools: developer / owner only ----
    if (["purgeLogs", "deleteUserLogs", "clearClosedTickets", "maintenance", "purgeForumUser"].includes(action)) {
      if (mr < 3) return res.status(403).json({ error: "Only a developer or the owner can do this." });
      if (action === "maintenance") {
        const on = !!b.on, msg = clip(b.msg, 200);
        await redis.set("maint", JSON.stringify({ on, msg, by: me.name, at: new Date().toISOString() }));
        await audit(redis, me, on ? "Maintenance mode ON" : "Maintenance mode OFF");
        return res.status(200).json({ ok: true, on });
      }
      if (action === "purgeForumUser") {
        const uid = String(id || "");
        if (!uid) return res.status(400).json({ error: "Pick a member." });
        const chans = parse(await redis.lrange("forum:channels", 0, 99));
        let removed = 0;
        for (const c of chans) {
          const key = "forum:channel:" + c.id + ":messages";
          const rows = await redis.lrange(key, 0, -1);
          const keep = rows.filter((r) => { try { return JSON.parse(r).uid !== uid; } catch (_) { return true; } });
          if (keep.length === rows.length) continue;
          removed += rows.length - keep.length;
          const m = redis.multi().del(key);
          if (keep.length) m.rpush(key, ...keep);
          await m.exec();
        }
        await audit(redis, me, `Deleted all forum messages by ${uid} (${removed} removed)`);
        return res.status(200).json({ ok: true, removed });
      }
      if (action === "purgeLogs") {
        const n = parseInt(b.days, 10);
        if (!n) return res.status(400).json({ error: "Give a number of days." });
        const days = Math.max(1, Math.min(3650, n));
        const cut = Date.now() - days * DAY;
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

    // ---- bulk tools ----
    if (action === "approveAll") {
      const pend = (await readUsers(redis)).filter((u) => u.role === "pending");
      for (const u of pend) { u.role = "mod"; await redis.hset("users", u.id, JSON.stringify(u)); }
      await audit(redis, me, `Approved all pending members (${pend.length})`);
      return res.status(200).json({ ok: true, count: pend.length });
    }
    if (action === "forceLogoutAll" || action === "purgePending") {
      if (mr < 3) return res.status(403).json({ error: "Only a developer or the owner can do this." });
      if (action === "forceLogoutAll") {
        const list = (await readUsers(redis)).filter((u) => u.id !== me.id && u.id !== process.env.OWNER_ID && rank(u.role) < mr);
        for (const u of list) await redis.hset("kicked", u.id, Date.now());
        await audit(redis, me, `Forced sign-out of everyone below ${me.role} (${list.length})`);
        return res.status(200).json({ ok: true, count: list.length });
      }
      const n = Math.max(1, Math.min(365, parseInt(b.days, 10) || 0));
      if (!parseInt(b.days, 10)) return res.status(400).json({ error: "Give a number of days." });
      const old = (await readUsers(redis)).filter((u) => u.role === "pending" && u.joined && Date.now() - new Date(u.joined).getTime() > n * DAY);
      for (const u of old) await redis.hdel("users", u.id);
      await audit(redis, me, `Removed ${old.length} pending accounts older than ${n} days`);
      return res.status(200).json({ ok: true, count: old.length });
    }

    // ---- switches, quests ----
    if (action === "lockSignups" || action === "readOnly") {
      const key = action === "lockSignups" ? "lock" : "readonly", on = !!b.on;
      if (on) await redis.set(key, "1"); else await redis.del(key);
      await audit(redis, me, `${action === "lockSignups" ? "Sign-ups" : "Read-only mode"} ${on ? (action === "lockSignups" ? "CLOSED" : "ON") : (action === "lockSignups" ? "open" : "off")}`);
      return res.status(200).json({ ok: true, on });
    }
    if (action === "quest") {
      const goal = parseInt(b.goal, 10), bonus = parseInt(b.bonus, 10), days = Math.max(1, Math.min(60, parseInt(b.days, 10) || 7));
      if (!goal || goal < 1) { await redis.del("quest"); await audit(redis, me, "Quest stopped"); return res.status(200).json({ ok: true, off: true }); }
      const q = { goal, bonus: Math.max(1, Math.min(5000, bonus || 100)), from: Date.now(), until: Date.now() + days * DAY, by: me.name };
      await redis.set("quest", JSON.stringify(q), "EX", days * 86400 + 86400);
      await redis.set("flash", JSON.stringify({ id: Date.now().toString(36), text: `🎯 QUEST: write ${goal} logs in ${days} days for +${q.bonus} XP!`, secs: 8, style: "info", by: me.name, at: Date.now() }), "EX", 120);
      await audit(redis, me, `Quest: ${goal} logs in ${days}d for +${q.bonus} XP`);
      return res.status(200).json({ ok: true });
    }

    // ---- XP events: x2 / x3 / x4 for every log written while active ----
    if (action === "xpEvent") {
      const mult = parseInt(b.mult, 10), mins = Math.max(1, Math.min(1440, parseInt(b.mins, 10) || 60));
      if (!mult || mult <= 1) {
        await redis.del("xpevent");
        await audit(redis, me, "XP event stopped");
        return res.status(200).json({ ok: true, off: true });
      }
      if (![2, 3, 4].includes(mult)) return res.status(400).json({ error: "Multiplier must be 2, 3 or 4." });
      const until = Date.now() + mins * 60000;
      await redis.set("xpevent", JSON.stringify({ mult, until, by: me.name }), "EX", mins * 60);
      await redis.set("flash", JSON.stringify({ id: Date.now().toString(36), text: `⚡ x${mult} XP EVENT for ${mins} min. Every log counts!`, secs: 8, style: "warn", by: me.name, at: Date.now() }), "EX", 120);
      await audit(redis, me, `XP event x${mult} for ${mins} min`);
      return res.status(200).json({ ok: true, until });
    }

    // ---- flash announcement: shown for a few seconds on everyone's screen ----
    if (action === "flash") {
      const text = clip(b.text, 160);
      if (!text) return res.status(400).json({ error: "Write the message." });
      const secs = Math.max(3, Math.min(20, parseInt(b.secs, 10) || 6));
      const style = ["info", "warn", "urgent"].includes(b.style) ? b.style : "info";
      await redis.set("flash", JSON.stringify({ id: Date.now().toString(36), text, secs, style, by: me.name, at: Date.now() }), "EX", 120);
      await audit(redis, me, `Flash message (${secs}s): ${text.slice(0, 60)}`);
      return res.status(200).json({ ok: true });
    }

    // ---- pinned announcement (any admin) ----
    if (action === "pin") {
      const text = clip(b.text, 400);
      if (!text) return res.status(400).json({ error: "Write the pinned message." });
      const level = ["info", "warn", "urgent"].includes(b.level) ? b.level : "info";
      await redis.set("pin", JSON.stringify({ text, level, by: me.name, at: new Date().toISOString() }));
      await audit(redis, me, `Pinned a ${level} message`);
      return res.status(200).json({ ok: true });
    }
    if (action === "unpin") {
      await redis.del("pin");
      await audit(redis, me, "Removed the pinned message");
      return res.status(200).json({ ok: true });
    }

    // ---- ban / unban by Discord ID (works before the person ever signs in) ----
    if (action === "banId" || action === "unbanId") {
      const uid = String(id || "").trim();
      if (!/^\d{5,25}$/.test(uid)) return res.status(400).json({ error: "Enter a valid Discord ID (numbers only)." });
      if (uid === process.env.OWNER_ID) return res.status(403).json({ error: "The owner cannot be banned." });
      const raw0 = await redis.hget("users", uid);
      const t0 = raw0 ? JSON.parse(raw0) : null;
      if (t0 && rank(t0.role) >= mr) return res.status(403).json({ error: "You can only act on members ranked below you." });
      if (action === "banId") {
        await redis.hset("idbans", uid, JSON.stringify({ by: me.name, at: new Date().toISOString(), note: clip(b.text, 120), ...(parseInt(b.days, 10) > 0 ? { until: Date.now() + Math.min(parseInt(b.days, 10), 365) * DAY } : {}) }));
        if (t0) { t0.role = "banned"; await redis.hset("users", uid, JSON.stringify(t0)); }
        await audit(redis, me, `Banned ID ${uid}`);
      } else {
        await redis.hdel("idbans", uid);
        await audit(redis, me, `Unbanned ID ${uid}`);
      }
      return res.status(200).json({ ok: true });
    }

    // ---- undo a previous admin action ----
    if (action === "undo") {
      const i = parseInt(b.index, 10);
      const rows = await redis.lrange("adminlog", 0, 199);
      const e = rows[i] && JSON.parse(rows[i]);
      if (!e || !e.undo) return res.status(400).json({ error: "This action cannot be undone." });
      const u = e.undo;
      if (u.type === "role") {
        const raw = await redis.hget("users", u.id);
        if (!raw) return res.status(404).json({ error: "User not found." });
        const t = JSON.parse(raw);
        if (t.id === process.env.OWNER_ID || rank(t.role) >= mr || rank(u.role) >= mr) return res.status(403).json({ error: "You can only act on members ranked below you." });
        if (t.role !== u.now) return res.status(400).json({ error: "This member's role has changed since. Nothing to undo." });
        t.role = u.role; delete t.temp;
        await redis.hset("users", t.id, JSON.stringify(t));
        await audit(redis, me, `Undo: ${t.name} ${u.now} → ${u.role}`);
      } else if (u.type === "deleteUser") {
        if (await redis.hget("users", u.user.id)) return res.status(400).json({ error: "This member already exists again." });
        if (rank(u.user.role) >= mr) return res.status(403).json({ error: "You can only act on members ranked below you." });
        await redis.hset("users", u.user.id, JSON.stringify(u.user));
        await audit(redis, me, `Undo: restored member ${u.user.name}`);
      } else return res.status(400).json({ error: "This action cannot be undone." });
      delete e.undo; e.text += " (undone)";
      await redis.lset("adminlog", i + 1, JSON.stringify(e)).catch(() => {});
      return res.status(200).json({ ok: true });
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
      await audit(redis, me, `Deleted member ${t.name} (${t.id})`, { type: "deleteUser", user: t });
      return res.status(200).json({ ok: true });
    }
    if (action === "forceLogout") {
      await redis.hset("kicked", t.id, Date.now());
      await audit(redis, me, `Forced sign-out of ${t.name}`);
      return res.status(200).json({ ok: true });
    }
    if (action === "addNote") {
      const text = clip(b.text, 300);
      if (!text) return res.status(400).json({ error: "Write a note." });
      const cur = JSON.parse((await redis.hget("notes", t.id)) || "[]");
      cur.unshift({ by: me.name, text, at: new Date().toISOString() });
      await redis.hset("notes", t.id, JSON.stringify(cur.slice(0, 30)));
      return res.status(200).json({ ok: true, notes: cur.slice(0, 30) });
    }
    if (action === "delNote") {
      const cur = JSON.parse((await redis.hget("notes", t.id)) || "[]");
      cur.splice(parseInt(b.index, 10), 1);
      await redis.hset("notes", t.id, JSON.stringify(cur));
      return res.status(200).json({ ok: true, notes: cur });
    }

    if (action === "giveXp") {
      const n = Math.max(-5000, Math.min(5000, parseInt(b.amount, 10) || 0)); if (!n) return res.status(400).json({ error: "Give a number (e.g. 50 or -50)." });
      const tot = await redis.hincrby("xpadj", t.id, n);
      await audit(redis, me, `${n > 0 ? "+" : ""}${n} XP for ${t.name} (adjustment total ${tot})`);
      global.__xpc = null;
      return res.status(200).json({ ok: true, total: tot });
    }
    if (action === "resetXp") {
      await redis.hdel("xpadj", t.id); global.__xpc = null;
      await audit(redis, me, `XP adjustments reset for ${t.name}`);
      return res.status(200).json({ ok: true });
    }
    if (action === "setLeave") {
      if (b.on) t.leave = true; else delete t.leave;
      await redis.hset("users", t.id, JSON.stringify(t));
      await audit(redis, me, `${t.name} is ${b.on ? "on leave" : "back from leave"}`);
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
    if (action === "timeout") { next = "banned"; if (!(parseInt(b.tempDays, 10) > 0)) return res.status(400).json({ error: "Give a number of days." }); }
    if (action === "setRole") {
      next = clip(b.role, 20).toLowerCase();
      if (!(next in RANK) || next === "owner") return res.status(400).json({ error: "Unknown role." });
    }
    if (!next) return res.status(400).json({ error: `Unknown action "${action}". Redeploy the latest api/users.js.` });
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
    delete t.temp;
    // Temporary role: after `tempDays` days the member goes back to the role they had (or mod).
    const td = parseInt(b.tempDays, 10);
    let tempTxt = "";
    if ((action === "setRole" || action === "timeout") && td > 0) {
      t.temp = { until: Date.now() + Math.min(td, 365) * DAY, back: ["pending", "banned"].includes(prev) ? "mod" : prev };
      tempTxt = ` for ${Math.min(td, 365)} days (then ${t.temp.back})`;
    }
    await redis.hset("users", t.id, JSON.stringify(t));
    await audit(redis, me, `${t.name}: ${prev} → ${next}${tempTxt}`, { type: "role", id: t.id, role: prev, now: next });
    return res.status(200).json({ ok: true });
  }
  res.status(405).json({ error: "Method not allowed." });
});
