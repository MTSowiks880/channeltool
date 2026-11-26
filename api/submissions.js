const { clip, handle, getUser, isAdmin, canPost } = require("../lib/util");

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

module.exports = handle(async (req, res, redis) => {
  const u = await getUser(redis, req);
  if (!u) return res.status(401).json({ error: "Not signed in." });
  if (!canPost(u)) return res.status(403).json({ error: "Your account is not approved yet." });

  const loadAll = async () =>
    Object.values(await redis.hgetall("subs")).map((r) => JSON.parse(r)).sort((a, b) => b.at.localeCompare(a.at));

  if (req.method === "GET") {
    const all = await loadAll();
    if (isAdmin(u)) return res.status(200).json(all.slice(0, 300));
    return res.status(200).json(
      all.filter((s) => s.uid === u.id).map((s) => ({
        id: s.id, uid: s.uid, quizId: s.quizId, quizTitle: s.quizTitle, status: s.status,
        pct: s.pct, feedback: s.feedback || "", at: s.at, reviewedAt: s.reviewedAt || null,
      }))
    );
  }

  if (req.method === "POST") {
    const b = req.body || {};
    const raw = await redis.hget("quizzes", String(b.quizId || ""));
    if (!raw) return res.status(404).json({ error: "Quiz not found." });
    const quiz = JSON.parse(raw);
    if (!quiz.live && !["owner", "admin", "developer"].includes(u.role)) {
      return res.status(403).json({ error: "This quiz has not been started by an admin yet." });
    }

    const mine = (await loadAll()).filter((s) => s.uid === u.id && s.quizId === quiz.id);
    if (mine.some((s) => s.status === "pending")) return res.status(409).json({ error: "You already have a submission waiting for review." });
    if (mine.some((s) => s.status === "passed")) return res.status(409).json({ error: "You already passed this quiz." });

    const given = Array.isArray(b.answers) ? b.answers : [];
    // When the timer runs out, the quiz is sent as is: blank answers are allowed (and count as wrong).
    const timeUp = !!b.timeUp && (quiz.timeLimit || 0) > 0;
    const answers = [];
    let correct = 0, choiceTotal = 0, hasText = false;
    for (let i = 0; i < quiz.questions.length; i++) {
      const q = quiz.questions[i], a = given[i];
      if (q.type === "choice") {
        choiceTotal++;
        const ok = Number.isInteger(a) && a >= 0 && a < q.options.length;
        if (!ok && !timeUp) return res.status(400).json({ error: "Answer every question." });
        if (ok && a === q.correct) correct++;
        answers.push(ok ? a : -1);
      } else {
        hasText = true;
        const t = clip(a, 2000);
        if (!t && !timeUp) return res.status(400).json({ error: "Answer every question." });
        answers.push(t || "(no answer — time ran out)");
      }
    }
    const pct = choiceTotal ? Math.round((correct / choiceTotal) * 100) : null;
    // Pure multiple-choice quizzes are graded automatically; anything with free text waits for a reviewer.
    const status = hasText ? "pending" : pct >= quiz.passScore ? "passed" : "failed";
    const sub = {
      id: newId(), quizId: quiz.id, quizTitle: quiz.title, passScore: quiz.passScore,
      uid: u.id, name: u.name, avatar: u.avatar,
      questions: quiz.questions, answers, correct, choiceTotal, pct, hasText,
      status, auto: !hasText, feedback: "", timeUp, timeLimit: quiz.timeLimit || 0,
      // How many times the member left the page during the quiz, and for how long (seconds).
      leaves: Math.min(9999, Math.max(0, parseInt(b.leaves, 10) || 0)),
      awaySec: Math.min(86400, Math.max(0, parseInt(b.awaySec, 10) || 0)),
      at: new Date().toISOString(),
    };
    await redis.hset("subs", sub.id, JSON.stringify(sub));
    return res.status(201).json({ id: sub.id, status, pct });
  }

  if (!isAdmin(u)) return res.status(403).json({ error: "Admins only." });

  if (req.method === "PUT") {
    const b = req.body || {};
    if (!["passed", "failed"].includes(b.verdict)) return res.status(400).json({ error: "Unknown verdict." });
    const r = await redis.hget("subs", String(b.id || ""));
    if (!r) return res.status(404).json({ error: "Submission not found." });
    const s = JSON.parse(r);
    if (s.uid === u.id && u.role !== "owner") return res.status(403).json({ error: "You can't review your own submission." });
    s.status = b.verdict;
    s.feedback = clip(b.feedback, 1000);
    s.reviewer = u.id; s.reviewerName = u.name; s.reviewedAt = new Date().toISOString(); s.auto = false;
    await redis.hset("subs", s.id, JSON.stringify(s));
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    const n = await redis.hdel("subs", String((req.query || {}).id || ""));
    if (!n) return res.status(404).json({ error: "Submission not found." });
    return res.status(200).json({ ok: true });
  }
  res.status(405).json({ error: "Method not allowed." });
});
