const { handle, redirectUri, makeSession, cookie } = require("../lib/util");

module.exports = handle(async (req, res, redis) => {
  const { code, state } = req.query || {};
  const st = (req.headers.cookie || "").match(/(?:^|; )st=([^;]+)/);
  if (!code || !st || st[1] !== state) {
    return res.status(400).json({ error: "Login expired. Go back to the site and try again." });
  }
  const t = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(req),
    }),
  });
  const tok = await t.json();
  if (!tok.access_token) {
    return res.status(400).json({ error: "Discord refused the login (check the redirect URI and the client secret)." });
  }
  const d = await (await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: "Bearer " + tok.access_token },
  })).json();
  if (!d.id) return res.status(400).json({ error: "Could not read your Discord profile." });

  const ext = (h) => (h.startsWith("a_") ? "gif" : "png");
  const old = await redis.hget("users", d.id);
  const prev = old ? JSON.parse(old) : null;
  let idBanned = false;
  if (d.id !== process.env.OWNER_ID) {
    const bn = await redis.hget("idbans", d.id);
    if (bn) { let x = {}; try { x = JSON.parse(bn) || {}; } catch (_) {} if (x.until && x.until < Date.now()) await redis.hdel("idbans", d.id); else idBanned = true; }
    if (!prev && !idBanned && (await redis.get("lock"))) return res.status(403).json({ error: "Sign-ups are closed right now. Ask a staff member." });
  }
  const u = {
    ...(prev || {}),
    id: d.id,
    name: d.global_name || d.username,
    username: d.username,
    avatar: d.avatar
      ? `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.${ext(d.avatar)}?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(d.id) >> 22n) % 6n)}.png`,
    banner: d.banner ? `https://cdn.discordapp.com/banners/${d.id}/${d.banner}.${ext(d.banner)}?size=600` : null,
    color: d.accent_color != null ? "#" + d.accent_color.toString(16).padStart(6, "0") : null,
    role: idBanned ? "banned" : prev ? prev.role : d.id === process.env.OWNER_ID ? "owner" : "pending",
    seen: new Date().toISOString(),
    joined: (prev && prev.joined) || new Date().toISOString(),
  };
  await redis.hset("users", d.id, JSON.stringify(u));
  await redis.lpush("logins", JSON.stringify({ id: d.id, name: u.name, at: u.seen }));
  await redis.ltrim("logins", 0, 199);
  res.setHeader("Set-Cookie", [cookie(makeSession(d.id), 2592000), "st=; Path=/; Max-Age=0"]);
  res.statusCode = 302;
  res.setHeader("Location", "/");
  res.end();
});
