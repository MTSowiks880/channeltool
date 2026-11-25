const crypto = require("crypto");
const { handle, redirectUri } = require("../lib/util");

module.exports = handle(async (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return res.status(500).json({ error: "DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET are missing in Vercel." });
  }
  const state = crypto.randomBytes(12).toString("hex");
  const q = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "identify",
    state,
  });
  res.setHeader("Set-Cookie", `st=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.statusCode = 302;
  res.setHeader("Location", "https://discord.com/api/oauth2/authorize?" + q);
  res.end();
});
