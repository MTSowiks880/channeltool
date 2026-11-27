const { clip, handle, getUser, isAdmin, canPost, canQuiz } = require("../lib/util");

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// What non-admins get: no correct answers.
const strip = (q) => ({
  id: q.id, title: q.title, description: q.description, passScore: q.passScore, timeLimit: q.timeLimit || 0, at: q.at,
  live: !!q.live, startedAt: q.startedAt || null,
  questions: q.questions.map((x) => ({ type: x.type, q: x.q, options: x.options || [] })),
});

function clean(b) {
  const title = clip(b.title, 100);
  if (!title) return { error: "Title is required." };
  const passScore = Math.min(100, Math.max(0, parseInt(b.passScore, 10) || 0));
  // Time limit in minutes, 0 = no limit (max 4 hours).
  const timeLimit = Math.min(240, Math.max(0, parseInt(b.timeLimit, 10) || 0));
  const src = Array.isArray(b.questions) ? b.questions : [];
  if (src.length < 1 || src.length > 30) return { error: "A quiz needs between 1 and 30 questions." };
  const questions = [];
  for (let i = 0; i < src.length; i++) {
    const x = src[i] || {};
    const q = clip(x.q, 500);
    if (!q) return { error: `Question ${i + 1} is empty.` };
    if (x.type === "text") { questions.push({ type: "text", q }); continue; }
    const options = (Array.isArray(x.options) ? x.options : []).map((o) => clip(o, 200));
    if (options.length < 2 || options.length > 6 || options.some((o) => !o)) {
      return { error: `Question ${i + 1}: 2 to 6 non-empty options are required.` };
    }
    const correct = Number.isInteger(x.correct) ? x.correct : -1;
    if (correct < 0 || correct >= options.length) return { error: `Question ${i + 1}: pick the correct answer.` };
    questions.push({ type: "choice", q, options, correct });
  }
  return { title, description: clip(b.description, 500), passScore, timeLimit, questions };
}

module.exports = handle(async (req, res, redis) => {
  const u = await getUser(redis, req);
  if (!u) return res.status(401).json({ error: "Not signed in." });
  if (!canPost(u)) return res.status(403).json({ error: "Your account is not approved yet." });

  if (req.method === "GET") {
    const all = Object.values(await redis.hgetall("quizzes")).map((r) => JSON.parse(r));
    all.sort((a, b) => b.at.localeCompare(a.at));
    return res.status(200).json(canQuiz(u) ? all : all.map(strip));
  }

  if (!canQuiz(u)) return res.status(403).json({ error: "Admins and trainers only." });

  if (req.method === "POST") {
    const b = req.body || {};
    // Admin gate: a quiz stays locked until an admin starts it for everyone.
    if (b.action === "start" || b.action === "stop") {
      const raw = await redis.hget("quizzes", String(b.id || ""));
      if (!raw) return res.status(404).json({ error: "Quiz not found." });
      const q = JSON.parse(raw);
      if (b.action === "start") { q.live = true; q.startedAt = new Date().toISOString(); q.startedBy = u.id; q.startedByName = u.name; }
      else { q.live = false; q.stoppedAt = new Date().toISOString(); }
      await redis.hset("quizzes", q.id, JSON.stringify(q));
      return res.status(200).json(q);
    }
    const c = clean(b);
    if (c.error) return res.status(400).json({ error: c.error });
    let quiz;
    if (b.id) {
      const raw = await redis.hget("quizzes", String(b.id));
      if (!raw) return res.status(404).json({ error: "Quiz not found." });
      quiz = { ...JSON.parse(raw), ...c, edited: new Date().toISOString() };
    } else {
      quiz = { id: newId(), ...c, by: u.id, byName: u.name, at: new Date().toISOString() };
    }
    await redis.hset("quizzes", quiz.id, JSON.stringify(quiz));
    return res.status(b.id ? 200 : 201).json(quiz);
  }

  if (req.method === "DELETE") {
    const id = String((req.query || {}).id || "");
    const n = await redis.hdel("quizzes", id);
    if (!n) return res.status(404).json({ error: "Quiz not found." });
    return res.status(200).json({ ok: true });
  }
  res.status(405).json({ error: "Method not allowed." });
});
