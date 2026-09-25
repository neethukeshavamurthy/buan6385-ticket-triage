// ---------------------------------------------------------------------------
// BUAN 6385 · Automation Gals · Ticket Triage & Escalation engine
//
// This file is a line-by-line code version of our n8n workflow
// ("BUAN6385 - Ticket Triage & Escalation"). Each function below is named
// after the n8n node it mirrors, and each one is tagged with the Spec Pack
// block it comes from (1 Trigger ... 6 Observability).
// Files that start with "_" inside /api are NOT exposed as URLs by Vercel.
// ---------------------------------------------------------------------------

const CATEGORIES = ["HR", "Device", "IT Access", "Systems", "Facilities"];
const URGENCIES = ["Low", "Medium", "High", "Critical"];

// Thresholds straight from the Spec Pack (tabs 3 and 5)
const CLASSIFIER_CONFIDENCE_MIN = 0.8; // below this -> human triage
const KB_SIMILARITY_MIN = 0.75;        // below this -> do not auto-close
const BODY_MAX_CHARS = 3000;           // Data Contract: ticket_body rule

// Stand-in for the HR directory (Workday) lookup. In production this is an API call.
const EMPLOYEE_DIRECTORY = {
  "priya.shah@acme.com":     { employee_id: "E1001", name: "Priya Shah",     department: "Finance",    tier: "Standard",  active: true,  timezone: "America/Chicago" },
  "marcus.lee@acme.com":     { employee_id: "E1002", name: "Marcus Lee",     department: "Operations", tier: "Standard",  active: true,  timezone: "America/New_York" },
  "dana.ortiz@acme.com":     { employee_id: "E1003", name: "Dana Ortiz",     department: "Risk",       tier: "Executive", active: true,  timezone: "America/Los_Angeles" },
  "sam.wong@acme.com":       { employee_id: "E1004", name: "Sam Wong",       department: "HR",         tier: "Standard",  active: true,  timezone: "Asia/Kolkata" },
  "jordan.miles@acme.com":   { employee_id: "E1005", name: "Jordan Miles",   department: "Operations", tier: "Standard",  active: false, timezone: "America/Chicago" }, // left the company
};

// Knowledge base used by the "Get KB Match Score" step
const KB_ARTICLES = [
  { id: "KB-101", title: "Reset your password or unlock your account", url: "https://kb.acme.internal/KB-101",
    keywords: ["password", "reset", "unlock", "locked", "forgot", "login", "sign"] },
  { id: "KB-204", title: "Connect to the office Wi-Fi and VPN", url: "https://kb.acme.internal/KB-204",
    keywords: ["wifi", "wi-fi", "vpn", "connect", "network", "internet", "globalprotect"] },
  { id: "KB-310", title: "Set up a printer on your laptop", url: "https://kb.acme.internal/KB-310",
    keywords: ["printer", "print", "printing", "scanner", "setup", "add"] },
  { id: "KB-415", title: "Request PTO and check your leave balance", url: "https://kb.acme.internal/KB-415",
    keywords: ["pto", "leave", "vacation", "balance", "holiday", "time off", "request"] },
  { id: "KB-520", title: "Book a meeting room", url: "https://kb.acme.internal/KB-520",
    keywords: ["book", "meeting", "room", "conference", "reserve", "calendar"] },
];

// Words that ALWAYS go to a human (Failure Modes tab: security, legal, HR disputes)
const SENSITIVE_TERMS = ["security", "breach", "phishing", "hacked", "malware", "legal", "lawsuit",
  "lawyer", "harassment", "discrimination", "compensation", "salary dispute", "payroll error", "underpaid"];
const ANGRY_TERMS = ["unacceptable", "furious", "angry", "ridiculous", "third time", "still not fixed",
  "escalate", "quit", "resign", "fed up", "worst", "asap!!", "!!!"];

// Backup owner added after the Red Team review (tab 7)
const ESCALATION_OWNERS = { primary: "Support Lead", backup: "On-call Support Engineer" };

// ------------------------------- helpers -----------------------------------
const lower = (s) => String(s || "").toLowerCase();
const countHits = (text, terms) => terms.filter((t) => text.includes(t)).length;
const round = (n) => Math.round(n * 100) / 100;

// =========================== BLOCK 2 · DATA CONTRACT ========================
// n8n node: "Validate Data Contract"
function validateDataContract(input) {
  const flags = [];
  const ticket = {
    ticket_id: String(input.ticket_id || "").trim(),
    requester_email: lower(input.requester_email).trim(),
    subject: String(input.subject || "").trim(),
    ticket_body: String(input.ticket_body || ""),
    ticket_category: input.ticket_category ? String(input.ticket_category) : "",
    urgency: input.urgency ? String(input.urgency) : "",
  };

  if (!ticket.ticket_id) {
    ticket.ticket_id = "TCK-" + Date.now().toString(36).toUpperCase();
    flags.push("ticket_id missing: generated one");
  }

  let bodyValid = true;
  if (!ticket.ticket_body.trim()) { bodyValid = false; flags.push("ticket_body is empty: needs manual read"); }
  if (ticket.ticket_body.length > BODY_MAX_CHARS) { bodyValid = false; flags.push(`ticket_body over ${BODY_MAX_CHARS} characters: needs manual read`); }

  if (ticket.ticket_category && !CATEGORIES.includes(ticket.ticket_category)) {
    flags.push(`ticket_category "${ticket.ticket_category}" is not a defined category: will classify instead`);
    ticket.ticket_category = "";
  }

  if (!URGENCIES.includes(ticket.urgency)) {
    flags.push("urgency missing or invalid: defaulted to Medium, supervisor review");
    ticket.urgency = "Medium";
  }

  return { ticket, bodyValid, flags };
}

// n8n node: "Requester Verified?"  (Data Contract: requester_employee_id)
function lookupRequester(email) {
  const rec = EMPLOYEE_DIRECTORY[email];
  if (!rec || !rec.active) return { verified: false, record: rec || null };
  return { verified: true, record: rec };
}

// =========================== BLOCK 1 · TRIGGER =============================
// n8n node: "Dedupe Check (ticket_id + email)" / "Already Seen (Duplicate)?"
// Serverless functions have no shared memory, so the browser sends the keys it
// has already seen and we also keep a warm-instance cache.
const warmCache = new Set();
function dedupeKey(ticket) { return `${ticket.ticket_id}|${ticket.requester_email}`; }
function isDuplicate(ticket, seenKeys) {
  const key = dedupeKey(ticket);
  const seen = warmCache.has(key) || (Array.isArray(seenKeys) && seenKeys.includes(key));
  return { key, seen };
}

// Red Team fix (tab 7): a second way in when the form is down. A raw email is
// parsed into the same ticket fields and goes through the same pipeline.
function parseEmail(raw) {
  const text = String(raw || "").replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + 2).trim() : "";
  const header = (name) => {
    const m = head.match(new RegExp("^" + name + ":\\s*(.*)$", "im"));
    return m ? m[1].trim() : "";
  };
  const from = header("From");
  const addr = (from.match(/<([^>]+)>/) || [null, from])[1].trim();
  const messageId = header("Message-ID").replace(/[<>]/g, "");
  // No Message-ID? Build a stable id from the content so a resent email is still caught by dedupe.
  let h = 0;
  for (const ch of addr + header("Subject") + body) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    ticket_id: messageId ? "EML-" + messageId.slice(0, 40) : "EML-" + h.toString(36).toUpperCase(),
    requester_email: addr,
    subject: header("Subject"),
    ticket_body: body,
    urgency: "",
    ticket_category: "",
    channel: "email",
  };
}

// =========================== BLOCK 3 · DECISION TABLE ======================
// Step 1 (MODEL): n8n nodes "Call Classifier LLM (Model)" + "Parse Classifier Response"
const CATEGORY_KEYWORDS = {
  "HR": ["pto", "leave", "benefit", "payroll", "salary", "compensation", "manager", "harassment", "onboarding", "vacation", "hr"],
  "Device": ["laptop", "monitor", "keyboard", "mouse", "printer", "phone", "screen", "battery", "headset", "device", "charger"],
  "IT Access": ["password", "login", "locked", "access", "permission", "account", "mfa", "sso", "unlock", "sign in", "vpn"],
  "Systems": ["error", "crash", "outage", "server", "system", "bug", "slow", "down", "sap", "salesforce", "workday", "wifi", "wi-fi", "network"],
  "Facilities": ["room", "desk", "badge", "parking", "office", "air conditioning", "heating", "light", "building", "meeting room", "cleaning"],
};
const HOW_TO_TERMS = ["how do i", "how to", "how can i", "where do i", "where can i", "can you tell me", "steps to", "what is the process", "help me set up", "forgot"];

function keywordClassifier(text) {
  const t = lower(text);
  const scores = Object.fromEntries(CATEGORIES.map((c) => [c, countHits(t, CATEGORY_KEYWORDS[c])]));
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topCat, topHits] = ranked[0];
  const secondHits = ranked[1][1];
  // Confidence = how clearly one category wins over the others.
  let confidence = 0.3;
  if (topHits > 0) confidence = Math.min(0.97, 0.55 + 0.12 * (topHits - secondHits) + 0.05 * topHits);
  if (topHits > 0 && topHits === secondHits) confidence = 0.5; // a tie is genuinely ambiguous
  return {
    category: topHits > 0 ? topCat : "General",
    confidence: round(confidence),
    intent: HOW_TO_TERMS.some((h) => t.includes(h)) ? "how_to" : "issue",
    source: "keyword-fallback",
  };
}

async function llmClassifier(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content:
            "You classify internal employee support tickets. Reply with JSON only: " +
            '{"category": one of ["HR","Device","IT Access","Systems","Facilities","General"], ' +
            '"intent": "how_to" if the employee is asking how to do something that documentation could answer, otherwise "issue", ' +
            '"confidence": number 0-1 for the category}. Use General with low confidence if unclear.' },
          { role: "user", content: text.slice(0, BODY_MAX_CHARS) },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
    const data = await r.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    const category = CATEGORIES.includes(parsed.category) ? parsed.category : "General";
    return {
      category,
      confidence: round(Math.max(0, Math.min(1, Number(parsed.confidence) || 0))),
      intent: parsed.intent === "how_to" ? "how_to" : "issue",
      source: "llm:" + (process.env.OPENAI_MODEL || "gpt-4o-mini"),
    };
  } catch (err) {
    // Failure mode "Broken": the model call fails -> fall back, never crash.
    return { error: String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Step 2 (RULE): n8n node "Get Employee Tier (Rule Lookup)"
function tierRule(record) {
  const tier = (record && record.tier) || "Standard";
  return { tier, priority: tier === "Executive" ? "Priority queue" : "Standard queue" };
}

// Step 4 (HUMAN gate): n8n nodes "Escalation Decision" + "Escalate to Human?"
function escalationDecision(ticket, category) {
  const t = lower(ticket.subject + " " + ticket.ticket_body);
  const reasons = [];
  const sensitive = SENSITIVE_TERMS.filter((w) => t.includes(w));
  if (sensitive.length) reasons.push(`sensitive topic (${sensitive.join(", ")}) always goes to a human`);
  const angry = countHits(t, ANGRY_TERMS);
  if (angry >= 1) reasons.push("frustrated or at-risk employee language detected");
  if (ticket.urgency === "Critical") reasons.push("urgency is Critical");
  return { escalate: reasons.length > 0, sensitive: sensitive.length > 0, reasons, sentiment: angry >= 1 ? "frustrated" : "neutral" };
}

// Step 3 (MODEL): n8n nodes "Get KB Match Score (Model)" + "Parse KB Score"
// Keyword-overlap similarity. Same placeholder role as in n8n; swap for embeddings later.
function kbMatch(text) {
  const t = lower(text);
  let best = { article: null, score: 0 };
  for (const a of KB_ARTICLES) {
    const hits = countHits(t, a.keywords);
    const score = hits === 0 ? 0.1 : hits === 1 ? 0.6 : hits === 2 ? 0.8 : 0.92;
    if (score > best.score) best = { article: a, score };
  }
  return { ...best, score: round(best.score) };
}

// Department routing used by "Route to Department Queue (Action)"
const QUEUE_BY_CATEGORY = {
  "HR": "People Ops queue", "Device": "Desktop Support queue", "IT Access": "Identity & Access queue",
  "Systems": "Systems Engineering queue", "Facilities": "Facilities queue", "General": "General triage queue",
};

// ============================ MAIN PIPELINE ===============================
async function runTriage(input, seenKeys) {
  const startedAt = Date.now();
  const path = [];   // every decision, in order (Observability)
  const actions = []; // everything that changed in the world (Actions tab)
  const step = (node, block, kind, result, detail) => path.push({ node, block, kind, result, detail });

  // BLOCK 1 · Trigger
  const channel = input.channel === "email" ? "email" : "form";
  step("New Ticket Submitted", "1 Trigger", "EVENT", `received by ${channel}`,
    channel === "email" ? "Backup email intake parsed into ticket fields" : "Webhook fired by the ticket form");

  // BLOCK 2 · Data Contract
  const { ticket, bodyValid, flags } = validateDataContract(input);
  step("Validate Data Contract", "2 Data Contract", "RULE", flags.length ? "passed with flags" : "passed",
    flags.length ? flags.join("; ") : "All required fields meet their rules");

  const finish = (outcome, extra = {}) => {
    warmCache.add(dedupeKey(ticket));
    return buildTraceRow({ ticket, outcome, path, actions, flags, startedAt, channel, ...extra });
  };

  const escalate = (esc, who, cls, tier) => {
    step("Escalate to Human?", "3 Decision Table", "HUMAN", "yes", esc.reasons.join("; "));
    actions.push({ action: `Notify ${ESCALATION_OWNERS.primary} (backup: ${ESCALATION_OWNERS.backup})`, target: "Teams / on-call", reversible: false, owner: "Support lead" });
    step("Notify Support Lead / On-Call (Action)", "4 Actions", "ACTION", "notified", `Backup owner: ${ESCALATION_OWNERS.backup}`);
    return finish("Escalated", { requester: who.record, classification: cls, tier, sentiment: esc.sentiment,
      escalation_reason: esc.reasons.join("; ") });
  };

  const who = lookupRequester(ticket.requester_email);
  step("Requester Verified?", "2 Data Contract", "RULE", who.verified ? "yes" : "no",
    who.verified ? `${who.record.name} (${who.record.employee_id}), ${who.record.department}`
      : who.record ? "Employee record is inactive" : "Email not found in HR directory");
  if (!who.verified) {
    actions.push({ action: "Hold ticket until requester is confirmed", target: "Helpdesk", reversible: true, owner: "Support ops" });
    return finish("Hold (Unverified Requester)");
  }

  const dup = isDuplicate(ticket, seenKeys);
  step("Dedupe Check (ticket_id + email)", "1 Trigger", "RULE", dup.seen ? "duplicate" : "new", `key = ${dup.key}`);
  if (dup.seen) return buildTraceRow({ ticket, outcome: "Dropped (Duplicate)", path, actions, flags, startedAt, channel, requester: who.record });

  actions.push({ action: "Send \"we are working on it\" auto-reply", target: "Email", reversible: false, owner: "Support lead" });
  step("Send Auto-Reply (Action)", "4 Actions", "ACTION", "sent", `To ${ticket.requester_email}. Cannot be unsent.`);

  if (!bodyValid) {
    actions.push({ action: "Route to General queue flagged 'needs manual read'", target: "Helpdesk", reversible: true, owner: "Support ops" });
    step("Route to Department Queue (Action)", "4 Actions", "ACTION", "General triage queue", "Body failed the Data Contract");
    return finish("Flagged for Human Triage", { requester: who.record, escalation_reason: "ticket body failed the data contract" });
  }

  // Step 1 · classify (or trust a valid tag from the form)
  let cls;
  const fullText = `${ticket.subject}\n${ticket.ticket_body}`;
  if (ticket.ticket_category) {
    const kw = keywordClassifier(fullText);
    cls = { category: ticket.ticket_category, confidence: 1, intent: kw.intent, source: "form tag" };
    step("Category Already Tagged?", "3 Decision Table", "RULE", "yes", `Tagged "${cls.category}" on the form, skip the model`);
  } else {
    step("Category Already Tagged?", "3 Decision Table", "RULE", "no", "Send to classifier");
    const llm = await llmClassifier(fullText);
    if (llm && !llm.error) cls = llm;
    else {
      cls = keywordClassifier(fullText);
      if (llm && llm.error) flags.push(`LLM classifier unavailable (${llm.error}): used keyword fallback`);
    }
    step("Call Classifier LLM (Model)", "3 Decision Table", "MODEL", `${cls.category} @ ${cls.confidence}`,
      `source: ${cls.source}; intent: ${cls.intent}`);
  }

  // Failure Modes tab: security / legal / HR-dispute tickets ALWAYS go to a
  // human, regardless of how confident the classifier is.
  const esc = escalationDecision(ticket, cls.category);
  if (esc.sensitive) {
    step("Sensitive Topic Override", "5 Failure Modes", "RULE", "yes", "Security, legal and HR disputes skip automation");
    return escalate(esc, who, cls, tierRule(who.record));
  }

  const confident = cls.confidence >= CLASSIFIER_CONFIDENCE_MIN;
  step(`Classifier Confidence >= ${CLASSIFIER_CONFIDENCE_MIN}?`, "3 Decision Table", "RULE", confident ? "yes" : "no",
    confident ? "Trust the model" : "Not sure enough, a person decides");
  if (!confident) {
    actions.push({ action: "Place in human triage queue", target: "Helpdesk", reversible: true, owner: "Support ops" });
    return finish("Flagged for Human Triage", { requester: who.record, classification: cls,
      escalation_reason: `classifier confidence ${cls.confidence} below ${CLASSIFIER_CONFIDENCE_MIN}` });
  }

  // Step 2 · tier rule
  const tier = tierRule(who.record);
  step("Get Employee Tier (Rule Lookup)", "3 Decision Table", "RULE", tier.tier, tier.priority);

  // Step 4 · human escalation gate
  if (esc.escalate) return escalate(esc, who, cls, tier);
  step("Escalate to Human?", "3 Decision Table", "HUMAN", "no", "No sensitive topic, calm tone, not Critical");

  // Step 3 · can a KB article close it?
  const kb = kbMatch(fullText);
  step("Get KB Match Score (Model)", "3 Decision Table", "MODEL", `${kb.score}`,
    kb.article ? `Best match ${kb.article.id}: ${kb.article.title}` : "No article matched");
  const autoClose = cls.intent === "how_to" && kb.score >= KB_SIMILARITY_MIN;
  step(`KB Similarity >= ${KB_SIMILARITY_MIN}?`, "3 Decision Table", "RULE", autoClose ? "yes" : "no",
    cls.intent !== "how_to" ? "Not a how-to question, a person should fix it" : autoClose ? "Docs answer this" : "Match too weak");

  if (autoClose) {
    actions.push({ action: `Auto-close with ${kb.article.id} link`, target: "Helpdesk", reversible: true, owner: "Support lead" });
    step("Auto-Close w/ KB Link (Action)", "4 Actions", "ACTION", "closed", `${kb.article.url}. Reopens if the employee replies.`);
    return finish("Auto-Closed", { requester: who.record, classification: cls, tier, kb });
  }

  const queue = tier.tier === "Executive" ? `${QUEUE_BY_CATEGORY[cls.category]} (priority)` : QUEUE_BY_CATEGORY[cls.category];
  actions.push({ action: `Route to ${queue}`, target: "Helpdesk", reversible: true, owner: "Support ops" });
  step("Route to Department Queue (Action)", "4 Actions", "ACTION", queue, "Support ops can re-route manually");
  return finish("Routed", { requester: who.record, classification: cls, tier, kb, queue });
}

// =========================== BLOCK 6 · OBSERVABILITY =======================
// n8n node: "Build Trace Row"
function buildTraceRow({ ticket, outcome, path, actions, flags, startedAt, channel, requester, classification, tier, kb, queue, sentiment, escalation_reason }) {
  path.push({ node: "Build Trace Row", block: "6 Observability", kind: "LOG", result: outcome, detail: "One row per run" });
  return {
    run_id: "RUN-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase(),
    timestamp: new Date().toISOString(),
    ticket_id: ticket.ticket_id,
    dedupe_key: dedupeKey(ticket),
    requester_email: ticket.requester_email,
    requester_name: requester ? requester.name : null,
    requester_timezone: requester && requester.timezone ? requester.timezone : "America/Chicago",
    channel: channel || "form",
    department: requester ? requester.department : "Unassigned",
    subject: ticket.subject,
    urgency: ticket.urgency,
    category: classification ? classification.category : null,
    confidence: classification ? classification.confidence : null,
    classifier_source: classification ? classification.source : null,
    intent: classification ? classification.intent : null,
    tier: tier ? tier.tier : null,
    sentiment: sentiment || null,
    kb_article: kb && kb.article ? kb.article.id : null,
    kb_url: kb && kb.article ? kb.article.url : null,
    kb_score: kb ? kb.score : null,
    queue: queue || null,
    outcome,
    sent_to_human: outcome === "Escalated" || outcome === "Flagged for Human Triage",
    escalation_reason: escalation_reason || null,
    data_contract_flags: flags,
    actions,
    decision_path: path,
    latency_ms: Date.now() - startedAt,
  };
}

module.exports = { runTriage, parseEmail, CATEGORIES, URGENCIES, EMPLOYEE_DIRECTORY, KB_ARTICLES };
