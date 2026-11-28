const { handle, getUser, clip } = require("../lib/util");

const pub = (u) => ({
  id: u.id, name: u.name, username: u.username, avatar: u.avatar, banner: u.banner,
  color: u.color, accent: u.accent || "", role: u.id === process.env.OWNER_ID ? "owner" : u.role,
  bio: u.bio || "", status: u.status || "", joined: u.joined || null, seen: u.seen || null,
});


// ---- XP / levels / badges (computed from the logs, nothing stored) ----
const W = { Warn: 10, Mute: 15, Kick: 20, Ban: 30, Unban: 10, Other: 5 };
const TITLES = [[20, "Legend"], [15, "Warden"], [10, "Enforcer"], [7, "Sentinel"], [4, "Guardian"], [2, "Watcher"], [1, "Rookie"]];
const need = (L) => 50 * L * (L - 1);
const dayOf = (t) => Math.floor(t / 864e5);
function calc(list, joined, adj, quest) {
  let xp = 0, ev = 0, det = 0, week = 0, boosted = 0; const act = {}, days = new Set(), spark = [0, 0, 0, 0, 0, 0, 0], today = dayOf(Date.now());
  list.forEach((l) => {
    const a = W[l.action] ? l.action : "Other"; act[a] = (act[a] || 0) + 1; let g = W[a];
    if (l.images && l.images.length) { g += 5; ev++; }
    if ((l.note || "").length >= 40) { g += 5; det++; }
    xp += g * (l.xm || 1); // x2 / x3 / x4 XP events
    if (l.xm > 1) boosted++;
    const t = new Date(l.at).getTime(); if (!t) return;
    days.add(dayOf(t));
    const ago = today - dayOf(t); if (ago >= 0 && ago < 7) { spark[6 - ago]++; week++; }
  });
  xp += days.size * 5 + (adj || 0);
  let qn = 0, qd = null;
  if (quest) { qn = list.filter((l) => { const t = new Date(l.at).getTime(); return t >= quest.from && t <= quest.until; }).length; if (qn >= quest.goal) xp += quest.bonus; qd = { goal: quest.goal, bonus: quest.bonus, until: quest.until, done: qn }; }
  xp = Math.max(0, xp);
  let best = 0, run = 0, prev = null;
  [...days].sort((a, b) => a - b).forEach((d) => { run = prev !== null && d === prev + 1 ? run + 1 : 1; best = Math.max(best, run); prev = d; });
  let cur = 0; for (let d = days.has(today) ? today : today - 1; days.has(d); d--) cur++;
  const level = Math.floor((1 + Math.sqrt(1 + xp / 12.5)) / 2);
  const total = list.length, old = joined && Date.now() - new Date(joined).getTime() > 90 * 864e5;
  const badges = [
    ["first", "🎯", "First log", "Wrote a first log", total >= 1], ["ten", "📝", "Getting started", "10 logs", total >= 10],
    ["hundred", "💯", "Centurion", "100 logs", total >= 100], ["ban", "🔨", "Banhammer", "25 bans logged", (act.Ban || 0) >= 25],
    ["evidence", "📸", "Evidence pro", "25 logs with screenshots", ev >= 25], ["detail", "🧾", "Thorough", "25 logs with a detailed note", det >= 25],
    ["all", "🧰", "All-rounder", "Used 5 different actions", Object.keys(act).length >= 5], ["s7", "🔥", "On fire", "7-day streak", best >= 7],
    ["s30", "🌋", "Unstoppable", "30-day streak", best >= 30], ["vet", "🛡️", "Veteran", "Member for 90+ days", !!old],
    ["boost", "⚡", "Event grinder", "10 logs during XP events", boosted >= 10],
  ].map(([id, icon, name, desc, on]) => ({ id, icon, name, desc, on }));
  return { quest: qd, xp, level, title: (TITLES.find((t) => level >= t[0]) || TITLES[6])[1], from: need(level), to: need(level + 1), streak: cur, best, week, spark, actions: act, badges };
}
async function ranking(redis) {
  const c = global.__xpc; if (c && Date.now() - c.t < 20000) return c.v;
  const by = {};
  (await redis.lrange("logs", 0, -1)).forEach((r) => { try { const l = JSON.parse(r); (by[l.uid] = by[l.uid] || []).push(l); } catch (_) {} });
  let quest = null; try { quest = JSON.parse((await redis.get("quest")) || "null"); if (quest && quest.until < Date.now()) quest = null; } catch (_) {}
  const adj = await redis.hgetall("xpadj");
  const joined = {}; Object.entries(await redis.hgetall("users")).forEach(([k, r]) => { try { joined[k] = JSON.parse(r).joined; } catch (_) {} });
  const rows = Object.keys(by).map((id) => ({ id, name: by[id][0].mod, avatar: by[id][0].avatar, logs: by[id].length, ...calc(by[id], joined[id], +adj[id] || 0, quest) })).sort((a, b) => b.xp - a.xp);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const wk = rows.filter((r) => r.week).sort((a, b) => b.week - a.week)[0];
  if (wk) wk.badges.push({ id: "week", icon: "👑", name: "Mod of the week", desc: "Most logs in the last 7 days", on: true });
  const v = { rows, joined, adj, quest }; global.__xpc = { t: Date.now(), v }; return v;
}

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
      let flash = null;
      if (!["pending", "banned"].includes(me.role)) { try { flash = JSON.parse((await redis.get("flash")) || "null"); } catch (_) {} }
      if (flash && Date.now() - flash.at > (flash.secs + 20) * 1000) flash = null;
      let xpEvent = null;
      try { xpEvent = JSON.parse((await redis.get("xpevent")) || "null"); if (xpEvent && xpEvent.until < Date.now()) xpEvent = null; } catch (_) {}
      return res.status(200).json({ user: me, pin, flash, xpEvent });
    }
    if (id === "all") return res.status(200).json({ rows: (await ranking(redis)).rows.map(({ badges, spark, ...r }) => r) });
    const raw = await redis.hget("users", id);
    if (!raw) return res.status(404).json({ error: "This member has no profile yet." });
    const { rows, adj, quest } = await ranking(redis);
    const mine = rows.find((r) => r.id === id);
    const u = JSON.parse(raw);
    const xp = mine ? { ...mine, of: rows.length } : { ...calc([], u.joined, +adj[id] || 0, quest), logs: 0, rank: null, of: rows.length };
    const last = (await redis.lrange("logs", 0, 99)).map((r) => { try { return JSON.parse(r); } catch (_) { return null; } }).find((l) => l && l.uid === id);
    return res.status(200).json({ user: pub(u), logs: xp.logs, lastLog: last ? last.at : null, xp });
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
