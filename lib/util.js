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

async function getUser(redis, req) {
  const id = readSession(req);
  if (!id) return null;
  const raw = await redis.hget("users", id);
  if (!raw) return null;
  const u = JSON.parse(raw);
  if (id === process.env.OWNER_ID) u.role = "owner";
  return u;
}
const isAdmin = (u) => !!u && ["owner", "admin", "developer"].includes(u.role);
const canPost = (u) => !!u && ["owner", "admin", "mod", "developer"].includes(u.role);

const handle = (fn) => async (req, res) => {
  let redis;
  try {
    if (!process.env.REDIS_URL) return res.status(500).json({ error: "REDIS_URL is missing." });
    if (!secret()) return res.status(500).json({ error: "SESSION_SECRET is missing in Vercel." });
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 8000 });
    await fn(req, res, redis);
  } catch (e) {
    res.status(500).json({ error: "Server error: " + e.message });
  } finally {
    if (redis) redis.disconnect();
  }
};

module.exports = { clip, makeSession, cookie, redirectUri, getUser, isAdmin, canPost, handle };
