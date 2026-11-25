module.exports = (req, res) => {
  res.setHeader("Set-Cookie", "s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.statusCode = 302;
  res.setHeader("Location", "/");
  res.end();
};
