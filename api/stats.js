const { handle, getUser, canPost } = require("../lib/util");

function classifyAction(action) {
  const a = String(action || "").trim().toLowerCase();
  if (a === "warn" || a === "warning" || a === "warns") return "Warn";
  if (a === "mute" || a === "muted" || a === "mutes") return "Mute";
  if (a === "kick" || a === "kicked" || a === "kicks") return "Kick";
  if (a === "ban" || a === "banned" || a === "bans") return "Ban";
  if (a === "unban" || a === "unbanned" || a === "unbans") return "Unban";
  return "Other";
}

function formatDuration(ms) {
  if (ms == null || isNaN(ms) || ms <= 0) return "0m";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = seconds / 3600;
  const days = seconds / 86400;

  if (minutes < 60) {
    return `${Math.max(1, minutes)}m`;
  } else if (hours < 24) {
    const h = Math.round(hours * 10) / 10;
    return `${h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)}h`;
  } else {
    const d = Math.round(days * 10) / 10;
    return `${d % 1 === 0 ? d.toFixed(0) : d.toFixed(1)}d`;
  }
}

function buildTimeline(filteredLogs, period, now) {
  const countsByDate = {};
  for (const log of filteredLogs) {
    if (!log.at) continue;
    const d = new Date(log.at);
    if (isNaN(d.getTime())) continue;
    const dateStr = d.toISOString().slice(0, 10);
    countsByDate[dateStr] = (countsByDate[dateStr] || 0) + 1;
  }

  const result = [];
  const nowDate = new Date(now);

  if (period === "7d" || period === "30d") {
    const days = period === "7d" ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(nowDate.getTime() - i * 86400000);
      const dateStr = d.toISOString().slice(0, 10);
      result.push({
        date: dateStr,
        count: countsByDate[dateStr] || 0,
      });
    }
  } else {
    // "all"
    const dates = Object.keys(countsByDate).sort();
    if (dates.length === 0) {
      return [];
    }
    const minDateStr = dates[0];
    const maxDateStr = nowDate.toISOString().slice(0, 10);
    const current = new Date(minDateStr + "T00:00:00.000Z");
    const end = new Date(maxDateStr + "T00:00:00.000Z");
    const maxDays = 3650;
    let loopCount = 0;
    while (current <= end && loopCount < maxDays) {
      const dateStr = current.toISOString().slice(0, 10);
      result.push({
        date: dateStr,
        count: countsByDate[dateStr] || 0,
      });
      current.setUTCDate(current.getUTCDate() + 1);
      loopCount++;
    }
  }

  return result;
}

function calculateStats(logs, tickets, period = "7d", now = Date.now()) {
  let windowStart = 0;
  if (period === "7d") {
    windowStart = now - 7 * 86400000;
  } else if (period === "30d") {
    windowStart = now - 30 * 86400000;
  } else {
    windowStart = 0;
  }

  // Filter logs by requested time window
  const filteredLogs = logs.filter((l) => {
    if (windowStart === 0) return true;
    const t = l && l.at ? new Date(l.at).getTime() : 0;
    return !isNaN(t) && t >= windowStart;
  });

  // Filter tickets by requested time window
  const filteredTickets = tickets.filter((t) => {
    if (windowStart === 0) return true;
    const time = t && t.at ? new Date(t.at).getTime() : 0;
    return !isNaN(time) && time >= windowStart;
  });

  // 1. Leaderboard: Group logs by moderator (uid, mod, avatar)
  const modsMap = new Map();
  for (const log of filteredLogs) {
    if (!log) continue;
    const uid = log.uid || log.mod || "unknown";
    if (!modsMap.has(uid)) {
      modsMap.set(uid, {
        uid: log.uid || null,
        mod: log.mod || "Unknown",
        avatar: log.avatar || null,
        count: 0,
        warns: 0,
        mutes: 0,
        kicks: 0,
        bans: 0,
        unbans: 0,
        other: 0,
        lastActive: log.at || null,
        _lastActiveTs: log.at ? new Date(log.at).getTime() : 0,
      });
    }

    const m = modsMap.get(uid);
    m.count++;
    if (log.avatar && !m.avatar) m.avatar = log.avatar;
    if (log.mod && m.mod === "Unknown") m.mod = log.mod;

    const logTs = log.at ? new Date(log.at).getTime() : 0;
    if (!isNaN(logTs) && logTs >= m._lastActiveTs) {
      m._lastActiveTs = logTs;
      m.lastActive = log.at;
    }

    const actType = classifyAction(log.action);
    if (actType === "Warn") m.warns++;
    else if (actType === "Mute") m.mutes++;
    else if (actType === "Kick") m.kicks++;
    else if (actType === "Ban") m.bans++;
    else if (actType === "Unban") m.unbans++;
    else m.other++;
  }

  const leaderboard = Array.from(modsMap.values())
    .sort((a, b) => b.count - a.count)
    .map((m) => ({
      uid: m.uid,
      mod: m.mod,
      avatar: m.avatar,
      count: m.count,
      warns: m.warns,
      mutes: m.mutes,
      kicks: m.kicks,
      bans: m.bans,
      unbans: m.unbans,
      other: m.other,
      actions: {
        warns: m.warns,
        mutes: m.mutes,
        kicks: m.kicks,
        bans: m.bans,
        unbans: m.unbans,
        other: m.other,
      },
      lastActive: m.lastActive,
    }));

  // 2. Action Breakdown: Counts and percentages
  const actionNames = ["Warn", "Mute", "Kick", "Ban", "Unban", "Other"];
  const actionCounts = { Warn: 0, Mute: 0, Kick: 0, Ban: 0, Unban: 0, Other: 0 };
  for (const log of filteredLogs) {
    if (!log) continue;
    const act = classifyAction(log.action);
    actionCounts[act]++;
  }

  const totalActions = filteredLogs.length;
  const actionBreakdown = {};
  for (const act of actionNames) {
    const cnt = actionCounts[act];
    const pct = totalActions > 0 ? Math.round((cnt / totalActions) * 1000) / 10 : 0;
    actionBreakdown[act] = {
      action: act,
      count: cnt,
      percentage: pct,
    };
  }

  // 3. Ticket Metrics
  const totalTickets = filteredTickets.length;
  const openTickets = filteredTickets.filter((t) => t && t.status === "open").length;
  const closedTickets = filteredTickets.filter((t) => t && t.status === "closed").length;
  const ticketCloseRate = totalTickets > 0 ? Math.round((closedTickets / totalTickets) * 1000) / 10 : 0;

  // Average first staff response time
  const firstResponseTimes = [];
  for (const t of filteredTickets) {
    if (!t) continue;
    const createdAt = t.at ? new Date(t.at).getTime() : 0;
    if (!createdAt || isNaN(createdAt)) continue;

    const msgs = Array.isArray(t.messages) ? t.messages : [];
    let firstStaffMsg = null;
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg && msg.staff && (i > 0 || msg.uid !== t.uid)) {
        firstStaffMsg = msg;
        break;
      }
    }

    if (firstStaffMsg && firstStaffMsg.at) {
      const respAt = new Date(firstStaffMsg.at).getTime();
      if (!isNaN(respAt) && respAt >= createdAt) {
        firstResponseTimes.push(respAt - createdAt);
      }
    }
  }

  const avgFirstResponseTimeMs = firstResponseTimes.length > 0
    ? Math.round(firstResponseTimes.reduce((acc, v) => acc + v, 0) / firstResponseTimes.length)
    : 0;
  const avgFirstResponseTime = firstResponseTimes.length > 0
    ? formatDuration(avgFirstResponseTimeMs)
    : "N/A";

  // Average resolution time for closed tickets
  const resolutionTimes = [];
  for (const t of filteredTickets) {
    if (!t || t.status !== "closed") continue;
    const createdAt = t.at ? new Date(t.at).getTime() : 0;
    const closedAt = t.updated ? new Date(t.updated).getTime() : 0;
    if (createdAt && closedAt && !isNaN(createdAt) && !isNaN(closedAt) && closedAt >= createdAt) {
      resolutionTimes.push(closedAt - createdAt);
    }
  }

  const avgResolutionTimeMs = resolutionTimes.length > 0
    ? Math.round(resolutionTimes.reduce((acc, v) => acc + v, 0) / resolutionTimes.length)
    : 0;
  const avgResolutionTime = resolutionTimes.length > 0
    ? formatDuration(avgResolutionTimeMs)
    : "N/A";

  const ticketMetrics = {
    total: totalTickets,
    open: openTickets,
    closed: closedTickets,
    closeRate: ticketCloseRate,
    closeRatePercentage: ticketCloseRate,
    avgFirstResponseTimeMs,
    avgFirstResponseTime,
    avgResolutionTimeMs,
    avgResolutionTime,
  };

  // 4. Summary KPIs
  const summary = {
    totalActions,
    activeModsCount: leaderboard.length,
    topModerator: leaderboard.length > 0 ? leaderboard[0].mod : null,
    avgResolutionTime,
    ticketCloseRate,
  };

  // 5. Activity Timeline
  const timeline = buildTimeline(filteredLogs, period, now);

  return {
    period,
    summary,
    leaderboard,
    actionBreakdown,
    ticketMetrics,
    timeline,
  };
}

async function handleStats(req, res, redis) {
  const u = await getUser(redis, req);
  if (!u) return res.status(401).json({ error: "Not signed in." });
  if (!canPost(u)) return res.status(403).json({ error: "Your account is not approved yet." });

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const rawPeriod = (req.query && req.query.period) || "7d";
  const period = ["7d", "30d", "all"].includes(rawPeriod) ? rawPeriod : "7d";

  const [rawLogs, rawTicketsObj] = await Promise.all([
    redis.lrange("logs", 0, -1),
    redis.hgetall("tickets"),
  ]);

  const logs = (rawLogs || [])
    .map((r) => {
      try {
        return typeof r === "string" ? JSON.parse(r) : r;
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);

  const tickets = Object.values(rawTicketsObj || {})
    .map((r) => {
      try {
        return typeof r === "string" ? JSON.parse(r) : r;
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);

  const stats = calculateStats(logs, tickets, period);
  return res.status(200).json(stats);
}

const exported = handle(handleStats);
exported.handleStats = handleStats;
exported.calculateStats = calculateStats;
exported.classifyAction = classifyAction;
exported.formatDuration = formatDuration;
exported.buildTimeline = buildTimeline;

module.exports = exported;
