module.exports = (req, res) => {
  const names = ["SESSION_SECRET","REDIS_URL","DISCORD_CLIENT_ID","DISCORD_CLIENT_SECRET","OWNER_ID","SITE_URL"];
  const out = {};
  names.forEach((n) => (out[n] = process.env[n] ? "présent (" + process.env[n].length + " caractères)" : "ABSENT"));
  out.autres_variables_proches = Object.keys(process.env).filter((k) => /secret|session|token/i.test(k));
  res.status(200).json(out);
};
