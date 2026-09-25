// POST /api/triage  -> runs the triage pipeline and returns the trace row.
// If N8N_WEBHOOK_URL is set in Vercel, the same ticket is also sent to the
// n8n workflow so the run shows up under n8n "Executions".
const { runTriage } = require("./_engine");

async function forwardToN8n(payload) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return { status: "not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify(payload),
    });
    return { status: r.ok ? "delivered" : `n8n replied HTTP ${r.status}` };
  } catch (err) {
    return { status: `n8n unreachable (${err.name === "AbortError" ? "timed out" : err.message})` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Send a POST request with the ticket as JSON." });
  }
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    body = body || {};
    const { seen_keys, ...ticket } = body;

    const trace = await runTriage(ticket, seen_keys);
    const n8n = trace.outcome === "Dropped (Duplicate)"
      ? { status: "skipped (duplicate)" }
      : await forwardToN8n({
          ticket_id: trace.ticket_id,
          requester_email: trace.requester_email,
          subject: ticket.subject || "",
          ticket_body: ticket.ticket_body || "",
          ticket_category: ticket.ticket_category || "",
          urgency: trace.urgency,
          source: "vercel-app",
        });
    trace.n8n = n8n.status;
    return res.status(200).json(trace);
  } catch (err) {
    return res.status(400).json({ error: `Could not process the ticket: ${err.message}` });
  }
};
