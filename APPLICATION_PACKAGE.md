# Application Package: Ticket Triage & Escalation

**Course:** BUAN 6385
**Team:** Automation Gals
**Members:**
- Saanvi Dusa
- Alicia Penuelas
- Neethu Keshava Murthy

**Live app (Vercel):** https://REPLACE-ME.vercel.app
**Source code (GitHub):** https://github.com/REPLACE-ME/buan6385-ticket-triage
**n8n workflow:** `n8n/workflow.json` in the repo (BUAN6385 - Ticket Triage & Escalation)

## What it does
When an employee submits a support ticket, the system validates it against our data contract,
drops duplicates, sends an auto-reply, classifies the category with a model, and then either
auto-closes it with a knowledge-base link, routes it to a department queue, or escalates it to
a person. Every run writes one trace row, and the dashboard shows our three health numbers.

## How it maps to our Week 4 Spec Pack (9/14 design)
| Spec Pack block | Where it lives in the app |
|---|---|
| 1 Trigger | Ticket form -> `POST /api/triage` (same payload as the n8n webhook); dedupe on ticket_id + email |
| 2 Data Contract | `validateDataContract()` and `lookupRequester()`: body under 3,000 chars, valid category/urgency, active employee |
| 3 Decision Table | Classifier (MODEL, 0.8 confidence gate), employee tier (RULE), KB match (MODEL, 0.75 gate), escalation (HUMAN) |
| 4 Actions | Auto-reply (irreversible), auto-close with KB link (reversible: Reopen button), route to queue, notify support lead + backup |
| 5 Failure Modes | Low confidence -> human triage; security/legal/HR disputes always go to a human; LLM outage falls back to the keyword classifier |
| 6 Observability | Trace log per run, CSV export, escalation rate / auto-close rate / 24-hour reopen rate with alert thresholds |
| 7 Red Team fixes | Backup on-call owner for escalations; human overrides are logged in the trace |

## How to test it (2 minutes)
1. Open the live app and click each sample: Password how-to (Auto-Closed), Broken laptop (Routed),
   Payroll dispute (Escalated), Vague request (Flagged for Human Triage), Former employee (Hold).
2. Click **Submit again** on any ticket to see the duplicate get dropped.
3. Click **Reopen** on an auto-closed row and watch the 24-hour reopen rate change.
