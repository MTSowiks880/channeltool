const { handle, getUser, clip, canPost } = require("../lib/util");

const pub = (u) => ({
  id: u.id, name: u.name, username: u.username, avatar: u.avatar, banner: u.banner,
  color: u.color, accent: u.accent || "", role: u.id === process.env.OWNER_ID ? "owner" : u.role,
  bio: u.bio || "", status: u.status || "", pronouns: u.pronouns || "", title: u.title || "", showcase: Array.isArray(u.showcase) ? u.showcase.slice(0, 3) : [], joined: u.joined || null, seen: u.seen || null,
});


// ---- XP / levels / badges (computed from the logs, nothing stored) ----
const W = { Warn: 10, Mute: 15, Kick: 20, Ban: 30, Unban: 10, Other: 5 };
const TITLES = [[20, "Legend"], [15, "Warden"], [10, "Enforcer"], [7, "Sentinel"], [4, "Guardian"], [2, "Watcher"], [1, "Rookie"]];
const need = (L) => 50 * L * (L - 1);
const dayOf = (t) => Math.floor(t / 864e5);
function calc(list, joined, adj, quest, kud) {
  let xp = 0, ev = 0, det = 0, week = 0, boosted = 0, mxp = 0, first = 0; const heat = new Array(84).fill(0), m0 = new Date(); m0.setUTCDate(1); m0.setUTCHours(0, 0, 0, 0); const act = {}, days = new Set(), spark = [0, 0, 0, 0, 0, 0, 0], today = dayOf(Date.now());
  list.forEach((l) => {
    const a = W[l.action] ? l.action : "Other"; act[a] = (act[a] || 0) + 1; let g = W[a];
    if (l.images && l.images.length) { g += 5; ev++; }
    if ((l.note || "").length >= 40) { g += 5; det++; }
    xp += g * (l.xm || 1); // x2 / x3 / x4 XP events
    const tt = new Date(l.at).getTime();
    if (tt >= m0.getTime()) mxp += g * (l.xm || 1);
    if (tt && (!first || tt < first)) first = tt;
    const hg = today - dayOf(tt); if (tt && hg >= 0 && hg < 84) heat[83 - hg]++;
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
  const ac = (k) => act[k] || 0, k = kud || 0;
  const badges = [
    ["first", "🎯", "First log", "Wrote a first log", total >= 1], ["ten", "📝", "Getting started", "10 logs", total >= 10],
    ["fifty", "📚", "Regular", "50 logs", total >= 50], ["hundred", "💯", "Centurion", "100 logs", total >= 100], ["fivehundred", "🏛️", "Pillar", "500 logs", total >= 500],
    ["warn50", "⚠️", "Warn master", "50 warns logged", ac("Warn") >= 50], ["mute25", "🔇", "Silencer", "25 mutes logged", ac("Mute") >= 25],
    ["kick25", "🥾", "Bouncer", "25 kicks logged", ac("Kick") >= 25], ["ban", "🔨", "Banhammer", "25 bans logged", ac("Ban") >= 25],
    ["unban10", "🕊️", "Second chances", "10 unbans logged", ac("Unban") >= 10],
    ["evidence", "📸", "Evidence pro", "25 logs with screenshots", ev >= 25], ["evidence100", "🎞️", "Archivist", "100 logs with screenshots", ev >= 100],
    ["detail", "🧾", "Thorough", "25 logs with a detailed note", det >= 25], ["all", "🧰", "All-rounder", "Used 5 different actions", Object.keys(act).length >= 5],
    ["s7", "🔥", "On fire", "7-day streak", best >= 7], ["s14", "☄️", "Blazing", "14-day streak", best >= 14], ["s30", "🌋", "Unstoppable", "30-day streak", best >= 30],
    ["vet", "🛡️", "Veteran", "Member for 90+ days", !!old], ["boost", "⚡", "Event grinder", "10 logs during XP events", boosted >= 10],
    ["xp1000", "💎", "Four digits", "1000 XP", xp >= 1000], ["lv5", "⭐", "Rising star", "Level 5", level >= 5], ["lv10", "🌟", "Elite", "Level 10", level >= 10], ["lv20", "👑", "Legendary", "Level 20", level >= 20],
    ["kud5", "👏", "Well liked", "Received 5 kudos", k >= 5], ["kud25", "🤝", "Team favourite", "Received 25 kudos", k >= 25],
  ].map(([id, icon, name, desc, on]) => ({ id, icon, name, desc, on }));
  const lvTitles = TITLES.filter((t) => level >= t[0]).map((t) => t[1]);
  const titles = [...lvTitles, ...badges.filter((b) => b.on).map((b) => b.name)];
  return { kudos: k, month: mxp, first: first || null, activeDays: days.size, heat, titles, quest: qd, xp, level, title: (TITLES.find((t) => level >= t[0]) || TITLES[6])[1], from: need(level), to: need(level + 1), streak: cur, best, week, spark, actions: act, badges };
}
async function ranking(redis) {
  const c = global.__xpc; if (c && Date.now() - c.t < 20000) return c.v;
  const by = {};
  (await redis.lrange("logs", 0, -1)).forEach((r) => { try { const l = JSON.parse(r); (by[l.uid] = by[l.uid] || []).push(l); } catch (_) {} });
  let quest = null; try { quest = JSON.parse((await redis.get("quest")) || "null"); if (quest && quest.until < Date.now()) quest = null; } catch (_) {}
  const adj = await redis.hgetall("xpadj"), kd = await redis.hgetall("kudos");
  const joined = {}; Object.entries(await redis.hgetall("users")).forEach(([k, r]) => { try { joined[k] = JSON.parse(r).joined; } catch (_) {} });
  const rows = Object.keys(by).map((id) => ({ id, name: by[id][0].mod, avatar: by[id][0].avatar, logs: by[id].length, recent: by[id].slice(0, 5).map((l) => ({ action: l.action, target: l.target, at: l.at })), ...calc(by[id], joined[id], (+adj[id] || 0) + 5 * (+kd[id] || 0), quest, +kd[id] || 0) })).sort((a, b) => b.xp - a.xp);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const wk = rows.filter((r) => r.week).sort((a, b) => b.week - a.week)[0];
  if (wk) wk.badges.push({ id: "week", icon: "👑", name: "Mod of the week", desc: "Most logs in the last 7 days", on: true });
  const v = { rows, joined, adj, kd, quest }; global.__xpc = { t: Date.now(), v }; return v;
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
    if (id === "all") return res.status(200).json({ rows: (await ranking(redis)).rows.map(({ badges, spark, heat, titles, recent, ...r }) => r) });
    const raw = await redis.hget("users", id);
    if (!raw) return res.status(404).json({ error: "This member has no profile yet." });
    const { rows, adj, kd, quest } = await ranking(redis);
    const mine = rows.find((r) => r.id === id);
    const u = JSON.parse(raw);
    const xp = mine ? { ...mine, of: rows.length } : { ...calc([], u.joined, (+adj[id] || 0) + 5 * (+kd[id] || 0), quest, +kd[id] || 0), logs: 0, rank: null, of: rows.length, recent: [] };
    xp.shown = u.title && xp.titles.includes(u.title) ? u.title : xp.title;
    if (!canPost(me)) xp.recent = [];
    xp.canKudos = canPost(me) && me.id !== id && canPost(u);
    const last = (await redis.lrange("logs", 0, 99)).map((r) => { try { return JSON.parse(r); } catch (_) { return null; } }).find((l) => l && l.uid === id);
    return res.status(200).json({ user: pub(u), logs: xp.logs, lastLog: last ? last.at : null, xp });
  }

  if (req.method === "POST") {
    const b = req.body || {};
    if (b.kudos) {
      const tid = String(b.kudos), tr = await redis.hget("users", tid);
      if (!tr || !canPost(me) || tid === me.id || !canPost(JSON.parse(tr))) return res.status(403).json({ error: "You cannot give kudos to this member." });
      if (!(await redis.set("kudos:" + me.id + ":" + tid, "1", "EX", 86400, "NX"))) return res.status(400).json({ error: "You already gave this member kudos today." });
      const n = await redis.hincrby("kudos", tid, 1); global.__xpc = null;
      return res.status(200).json({ ok: true, kudos: n });
    }
    const raw = await redis.hget("users", me.id);
    const u = JSON.parse(raw);
    u.bio = clip(b.bio, 200);
    u.status = clip(b.status, 60);
    u.accent = /^#[0-9a-f]{6}$/i.test(b.accent || "") ? b.accent : "";
    u.pronouns = clip(b.pronouns, 20); u.title = clip(b.title, 30);
    u.showcase = (Array.isArray(b.showcase) ? b.showcase : []).map((x) => clip(x, 20)).filter(Boolean).slice(0, 3);
    await redis.hset("users", u.id, JSON.stringify(u));
    if (u.id === process.env.OWNER_ID) u.role = "owner";
    return res.status(200).json({ user: u });
  }
  res.status(405).json({ error: "Method not allowed." });
});
