const { Redis } = require("@upstash/redis");

const clip = (v, n) => String(v || "").trim().slice(0, n);

module.exports = async (req, res) => {
  try {
    if (!process.env.MOD_PASSWORD) {
      return res.status(500).json({ error: "MOD_PASSWORD n'est pas défini dans Vercel (ou pas redéployé)." });
    }
    if (req.headers["x-mod-password"] !== process.env.MOD_PASSWORD) {
      return res.status(401).json({ error: "Mot de passe incorrect." });
    }

const find = (re) => { const k = Object.keys(process.env).find((k) => re.test(k)); return k ? process.env[k] : undefined; };
const url = find(/(REST_API_URL|REDIS_REST_URL)$/);
const token = find(/(REST_API_TOKEN|REDIS_REST_TOKEN)$/);
    if (!url || !token) {
      return res.status(500).json({ error: "La base Redis n'est pas connectée au projet (Storage → Upstash Redis), puis redéploie." });
    }
    const redis = new Redis({ url, token });

    if (req.method === "GET") {
      const logs = await redis.lrange("logs", 0, 199);
      return res.status(200).json(logs);
    }
    if (req.method === "POST") {
      const b = req.body || {};
      const mod = clip(b.mod, 40);
      const target = clip(b.target, 80);
      if (!mod || !target) return res.status(400).json({ error: "Nom du mod et cible requis." });
      const images = (Array.isArray(b.images) ? b.images : [])
        .filter((i) => typeof i === "string" && i.startsWith("data:image/") && i.length < 600000)
        .slice(0, 4);
      const log = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        mod, target,
        action: clip(b.action, 40) || "Autre",
        note: clip(b.note, 2000),
        images,
        at: new Date().toISOString(),
      };
      await redis.lpush("logs", JSON.stringify(log));
      return res.status(201).json(log);
    }
    return res.status(405).json({ error: "Méthode non autorisée." });
  } catch (e) {
    return res.status(500).json({ error: "Erreur serveur : " + e.message });
  }
};
