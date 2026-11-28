const crypto = require("crypto");
const Redis = require("ioredis");

const clip = (v, n) => String(v || "").trim().slice(0, n);
const secret = () => process.env.SESSION_SECRET || "";
const sign = (s) => crypto.createHmac("sha256", secret()).update(s).digest("base64url");

const makeSession = (id) => {
  const p = id + "." + (Date.now() + 30 * 864e5);
  return p + "." + sign(p);
};
const readSession = (req) => {
  const m = (req.headers.cookie || "").match(/(?:^|; )s=([^;]+)/);
  if (!m) return null;
  const [id, exp, sig] = m[1].split(".");
  if (!id || !exp || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(id + "." + exp));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || Date.now() > +exp) return null;
  return id;
};
const cookie = (v, age) => `s=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const redirectUri = (req) =>
  (process.env.SITE_URL || "https://" + req.headers.host).replace(/\/$/, "") + "/api/callback";

async function getUser(redis, req, bypass) {
  const id = readSession(req);
  if (!id) return null;
  const [raw, kick, mt] = await Promise.all([redis.hget("users", id), redis.hget("kicked", id), redis.get("maint")]);
  if (!raw) return null;
  if (kick) {
    const m = (req.headers.cookie || "").match(/(?:^|; )s=[^.]+\.(\d+)/);
    if (!m || +m[1] - 30 * 864e5 < +kick) return null; // session issued before a forced logout
  }
  const u = JSON.parse(raw);
  if (id === process.env.OWNER_ID) u.role = "owner";
  else if (u.temp && Date.now() > u.temp.until) { // temporary role ended
    u.role = u.temp.back; delete u.temp;
    await redis.hset("users", id, JSON.stringify(u));
  }
  if (!bypass && mt) {
    try { if (JSON.parse(mt).on && !["owner", "developer"].includes(u.role)) return null; } catch (_) {}
  }
  return u;
}
const isAdmin = (u) => !!u && ["owner", "admin", "developer"].includes(u.role);
const canPost = (u) => !!u && ["owner", "admin", "mod", "developer", "trainer"].includes(u.role);
// Trainers (between mod and admin) can build and run quizzes.
const canQuiz = (u) => !!u && ["owner", "admin", "developer", "trainer"].includes(u.role);

const handle = (fn) => async (req, res) => {
  let redis;
  try {
    if (!process.env.REDIS_URL) return res.status(500).json({ error: "REDIS_URL is missing." });
    if (!secret()) return res.status(500).json({ error: "SESSION_SECRET is missing in Vercel." });
    redis = global.__redis || (global.__redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 8000, keepAlive: 10000 }));
    await fn(req, res, redis);
  } catch (e) {
    res.status(500).json({ error: "Server error: " + e.message });
  }
};

module.exports = { clip, makeSession, cookie, redirectUri, getUser, isAdmin, canPost, canQuiz, handle };
