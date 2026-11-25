const { handle, getUser } = require("../lib/util");

module.exports = handle(async (req, res, redis) => {
  const u = await getUser(redis, req);
  if (!u) return res.status(401).json({ error: "Not signed in." });
  res.status(200).json({ user: u });
});
