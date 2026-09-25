// GET /api/health -> quick check that the deployment and settings are live
module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    app: "Automation Gals - Ticket Triage & Escalation",
    llm_classifier: process.env.OPENAI_API_KEY ? "on (OpenAI)" : "off (keyword fallback)",
    n8n_forwarding: process.env.N8N_WEBHOOK_URL ? "on" : "off",
    time: new Date().toISOString(),
  });
};
