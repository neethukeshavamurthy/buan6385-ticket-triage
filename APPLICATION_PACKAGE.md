# Application Package: Ticket Triage & Escalation

**Course:** BUAN 6385
**Team:** Automation Gals
**Members:** Saanvi Dusa, Alicia Penuelas, Neethu Keshava Murthy

**Live app (Vercel):** https://REPLACE-ME.vercel.app
**Source code (GitHub):** https://github.com/REPLACE-ME/buan6385-ticket-triage
**n8n workflow:** `n8n/workflow.json` (BUAN6385 - Ticket Triage & Escalation)

**What it does:** when an employee submits a support ticket, the system validates it against our
data contract, drops duplicates, sends an acknowledgement, classifies it with a model, and then
auto-closes it with a knowledge-base link, routes it to a department queue, or hands it to a
person. Every run writes one trace row, and the dashboard shows our three health numbers.

**How we built it:** we wired the Week 4 blocks in n8n first. Vercel cannot host n8n or reach an
n8n running on our laptop, so we ported the same nodes, in the same order, into a small web app
(`api/_engine.js`, one function per n8n node). When `N8N_WEBHOOK_URL` is set, the app also sends
every ticket to the published n8n webhook, so each run appears in both places.

---

## 1. Did we build what we specced in Week 4?

Mostly yes. We compared every row we wrote in the Spec Pack (25 rows across tabs 1, 2, 3, 4, 5
and 6, not counting the template's orange example rows) against the build:

| Result | Rows | Share |
|---|---|---|
| Built as specced | 18 | 72% |
| Built, but changed | 6 | 24% |
| Deferred (not built this week) | 1 | 4% |

Across the board, the side effects (email, helpdesk updates, Teams notification) are simulated and
written to the trace instead of hitting real systems, and the HR directory and knowledge base are
stand-in data. Our Spec Pack already planned for this: the Actions note in n8n points every action
at a placeholder endpoint until real credentials exist.

**Changed (6) and why**

| Spec Pack row | What we specced | What we built | Justification |
|---|---|---|---|
| 1 Trigger: employee replies to an open ticket | Separate reply trigger, dedupe on message_id | A **Reopen** button on auto-closed tickets stands in for the employee replying | We have no real helpdesk to receive replies. The Reopen button still exercises the "reversible" action and feeds the 24-hour reopen rate. |
| 3 Decision Table step 1: classify category | Categories "billing / bug / how to / other" | Categories HR / Device / IT Access / Systems / Facilities, plus a separate how-to vs issue flag | Our Spec Pack contradicted itself: the Data Contract listed HR / Device / IT Access / Systems / Facilities. We followed the Data Contract and kept "how-to" as its own flag because step 3 depends on it. |
| 3 Decision Table step 3: KB auto-close | Semantic match using KB embeddings | Keyword-overlap similarity score, same 0.75 threshold | Embeddings need a vector store we did not have time to stand up. The threshold and decision stay the same, so swapping in embeddings later changes one function. |
| 5 Failure Modes: helpdesk API rate-limited | Queue and retry with exponential backoff | A timeout on the model call, then a fallback to the keyword classifier | A serverless function cannot hold a queue between requests. The fallback keeps every ticket moving instead of failing, and the trace records that the fallback was used. |
| 1 Trigger: daily 6am unresolved-ticket sweep | Scheduled job at 6am against the helpdesk database | A **Run daily sweep** button that sweeps the trace log, schedules each reminder for 6:00 AM in the employee's own time zone, skips tickets already reminded today, and archives tickets 60+ days old. The header warns when the sweep has not run in 24 hours. | We have no helpdesk database. The sweep logic (reminders, no double re-notify, 60-day archive, "never fired" warning) is all there; production would run it on a schedule. |
| 6 Observability: escalation reason text | Archived Microsoft Teams conversation | Escalation reason written to the trace row | No Teams connection yet. Keeping it in the trace means it is still searchable and exportable (CSV). |

**Deferred (1)**

| Spec Pack row | Why it is deferred |
|---|---|
| 6 Observability: time to first response | Needs a real human reply to measure against. We log processing time (`latency_ms`) for now. |

**Red Team findings (tab 7): all four are built and testable**

| What the AutoBot Team found | What we changed | Where to test it in the app |
|---|---|---|
| Escalation assumes a human is always available; urgent tickets could pile up if the support lead is out | Every escalation notifies the Support Lead **and** a backup on-call engineer | Submit **Payroll dispute**: the route shows "Notify Support Lead / On-Call" with the backup owner |
| The daily sweep may not work well if reviewers are in different time zones | Each reminder is scheduled for 6:00 AM in the **employee's** time zone (Chicago, New York, Los Angeles, Kolkata in our directory) | Submit a few tickets, then click **Run daily sweep** |
| The human-override log has no owner, so it could silently pile up | The Support Lead owns the override log and reviews it weekly; every override is recorded with who made it | Click **Override** on any trace row; the owner is named above the trace log |
| A second way to request tickets in case the system is down | Email is a second trigger. A raw email is parsed into the same ticket fields and runs through the same workflow. If the form can't reach the server, the page offers a pre-filled email to helpdesk@acme.com | Use **Backup: send the ticket as an email** → **Process email** |

**Added beyond the spec**
- The Red Team found that escalations assumed one person was always available. Every escalation now notifies the Support Lead **and** a backup on-call engineer.
- A sensitive-topic override runs *before* the confidence check, so a confident classifier cannot skip a person on security, legal or pay disputes. This comes from our Failure Modes tab.
- Every human override is logged against the original decision (Observability row 5, also a Red Team note).
- A CSV export of the trace log, used for the weekly sample checks in the Failure Modes tab.

## 2. How does the process trigger?

- **Second event trigger (Red Team fix):** an email to the helpdesk. The app parses the sender, subject and body into the same fields, so the email runs the same workflow. Emails without a Message-ID get a stable id from their content, so a resent email is still caught by dedupe.
- **Schedule trigger:** the daily unresolved-ticket sweep (run with the **Run daily sweep** button), with reminders at 6:00 AM in each employee's time zone.
- **Event trigger:** a new ticket is submitted. In the app, the ticket form sends `POST /api/triage`. In n8n, the same fields go to the **New Ticket Submitted** webhook.
- **Payload:** `ticket_id`, `requester_email`, `subject`, `ticket_body`, `ticket_category` (optional), `urgency`.
- **If it fires twice:** the Dedupe step keys on `ticket_id + requester_email`. A repeat is dropped before any action runs, so no second auto-reply goes out. You can see this with the **Submit again** button.
- **If it never fires:** the dashboard shows "No runs yet" and the metrics stay blank. The planned daily sweep (deferred above) is our alert for this.

## 3. Decision layer

Each decision point, in the order a ticket meets them:

| # | Decision point | Type | What it decides | Why this type |
|---|---|---|---|---|
| 1 | Validate Data Contract | RULE | Is the ticket complete and within limits (body 1–3,000 chars, valid category and urgency)? | Fixed, checkable rules. No judgement needed. |
| 2 | Requester Verified? | RULE | Is this an active employee in the HR directory? | A lookup against a system of record. |
| 3 | Dedupe Check | RULE | Have we already seen this ticket? | An exact-match key. |
| 4 | Category Already Tagged? | RULE | Trust the form's category or call the model? | If the employee picked a valid category, a model adds cost without adding accuracy. |
| 5 | Classifier | MODEL | Category, how-to vs issue, confidence | Free text is paraphrased endlessly; keyword rules miss too much. |
| 6 | Confidence ≥ 0.8? | RULE (gate on a model) | Trust the model or send to a person? | A model needs a threshold we can defend and audit. |
| 7 | Sensitive Topic Override | RULE | Is this about security, legal or a pay dispute? | These are too costly to get wrong, however confident the model is. |
| 8 | Employee Tier | RULE | Standard or priority queue | A static field. No judgement needed. |
| 9 | Escalate to Human? | HUMAN | Does a person need to step in now? | See section 4. |
| 10 | KB Match Score ≥ 0.75? | MODEL + RULE gate | Can a KB article close this without a person? | Needs similarity against documentation, not exact words. |

## 4. Human-in-the-loop

We did not aim for a number of human steps. A person is added only where the automated action
would be hard to undo or costly to get wrong. A person is left out where the action is cheap and
reversible.

**Where a person steps in, and why that is justified**

| When | Who | Why a person and not the system |
|---|---|---|
| The requester is not an active employee (**Hold**) | Support ops | Acting for an unknown or former employee is a security risk. Confirming identity is a judgement call. |
| The ticket body is empty or too long (**Flagged**) | Support ops | The system cannot read it, so a person has to. |
| The classifier's confidence is below 0.8 (**Flagged**) | Support ops | This is our "confidently wrong" guard. Below the threshold, a wrong route costs more than a person's time. |
| Security, legal, harassment or pay-dispute language (**Escalated**) | Support Lead, with backup on-call | Legal and reputational risk. A misroute here cannot be cleanly undone. |
| Frustrated language or Critical urgency (**Escalated**) | Support Lead, with backup on-call | Retention risk. A sentiment signal can surface the ticket, but a person reads the context and decides. |
| After the fact: an employee reopens, or a lead overrides a decision | Employee / Support Lead | This is the correction loop. Overrides are the ground truth for measuring real accuracy. |

**Where we deliberately do not use a person**
- **Auto-close with a KB link.** It is reversible: the ticket reopens if the employee replies. It only happens above both thresholds (0.8 and 0.75), and the 24-hour reopen rate watches for mistakes.
- **Routing to a department queue.** It is reversible, since support ops can re-route manually.
- **The acknowledgement auto-reply.** It cannot be unsent, but it is a generic "we're on it" message. It only goes out after the requester is verified and the dedupe step passes, so it cannot go to the wrong person or go out twice.

## 5. Actions and failures

**Actions**

| Action | Triggered by | Reversible? | How to undo | Owner |
|---|---|---|---|---|
| Send "we are working on it" auto-reply | Verified, non-duplicate ticket | **No** | Send a follow-up correction | Support lead |
| Auto-close with KB link | Confidence ≥ 0.8, how-to, KB score ≥ 0.75 | Yes | Reopen (button in the app) | Support lead |
| Route to department queue (priority queue for Executive tier) | Not auto-closable | Yes | Manual re-route | Support ops |
| Notify Support Lead + backup on-call | Escalation | No (the notification is sent) | Resolve or de-escalate | Support lead |
| Hold ticket until requester is confirmed | Unverified requester | Yes | Release after confirmation | Support ops |

**Failures**

| Failure | Broken or wrong? | How we detect it | What the system does |
|---|---|---|---|
| Classifier confidently mislabels a pay dispute as a how-to | **Wrong** | Weekly sample of auto-closed tickets (CSV export), plus the reopen rate | Sensitive-topic override; below 0.8 goes to a person |
| An urgent security or legal ticket is under-rated | **Wrong** | Weekly sample of routed low-priority tickets | Sensitive terms always go to a person, whatever the confidence |
| The LLM is down, rate-limited or slow | Broken | The trace shows `classifier_source = keyword-fallback` and a data-contract flag | 6-second timeout, then the keyword classifier; the ticket still moves |
| The ticket system itself is down | Broken | The form cannot reach the server | The page tells the employee to email helpdesk@acme.com (pre-filled), and emails enter the same workflow |
| n8n is unreachable | Broken | The trace log's n8n column shows "unreachable" | The app keeps triaging; the n8n copy is skipped |
| A bad or incomplete payload | Broken | A data-contract flag on the run | Defaults applied (e.g. urgency Medium) or routed to a person |

## 6. End-to-end run

Open the live app and submit each sample ticket. Every outcome path in the workflow is covered,
and each one shows the full route it took, node by node.

| Sample | Expected outcome | What it proves |
|---|---|---|
| Password how-to | **Auto-Closed** with KB-101 | Model + both thresholds + reversible action |
| Broken laptop | **Routed** to Desktop Support | Classification + routing |
| Payroll dispute | **Escalated** to Support Lead + backup | Sensitive-topic override and human gate |
| Vague request | **Flagged for Human Triage** | Low-confidence guard |
| Former employee | **Hold (Unverified Requester)** | Data contract / identity rule |
| Executive outage | **Routed** to the priority queue | Tier rule |
| **Submit again** on any ticket | **Dropped (Duplicate)** | Trigger dedupe |
| **Process email** (backup email intake) | **Auto-Closed** with KB-204; pressing it again gives **Dropped (Duplicate)** | Second trigger (Red Team fix) |
| **Run daily sweep** (click it twice) | Reminders at 6:00 AM in each employee's time zone; the second run sends none again | Schedule trigger + time-zone fix |

Then click **Reopen** on an auto-closed row and watch the 24-hour reopen rate change. The same
seven paths are also checked automatically with `npm test`.

**Evidence** (screenshots in the `screenshots/` folder): the n8n canvas, a successful n8n
execution, the app's route trace for each outcome, and the three health numbers.

## 7. UI: is it the right choice?

In production, employees would not use our screen. They would submit tickets the way they already
do (the helpdesk form or email), and that would fire the same trigger. So our UI serves two users:

- **A simple intake form** that stands in for the helpdesk form, so anyone can trigger a real run.
- **An operations console for support leads**, which is the part we think matters. It shows the route every ticket took and why (the rule, model or human step behind each decision), the three health numbers with their alert thresholds, and the Reopen and Override controls that feed our correction loop.

We considered two alternatives and rejected them:
- **A chatbot** would turn a structured intake-and-route process into an open-ended conversation. That adds ambiguity to the one step that should be most predictable.
- **The n8n canvas alone** works for us as builders, but a support lead cannot use it to see why a ticket was routed or to correct a decision.

## 8. How we prompted AI

**a) The prompt inside the product.** The classifier (Decision Table step 1) sends this system
prompt, with the ticket's subject and body as the user message. Temperature is 0 and the response
format is forced to JSON:

> You classify internal employee support tickets. Reply with JSON only:
> {"category": one of ["HR","Device","IT Access","Systems","Facilities","General"],
> "intent": "how_to" if the employee is asking how to do something that documentation could answer, otherwise "issue",
> "confidence": number 0-1 for the category}. Use General with low confidence if unclear.

Why it is written this way:
- The category list matches our Data Contract enum exactly, so any other answer fails validation and falls back to "General".
- "General with low confidence if unclear" is how the model says *I don't know*. That trips the 0.8 gate and sends the ticket to a person, which is our "confidently wrong" defense.
- Temperature 0 makes the same ticket get the same answer, so the trace can be audited.

The n8n "Call Classifier LLM" node uses: `PASTE THE PROMPT FROM YOUR N8N NODE HERE`

**b) Prompts we used to build it (AI-assisted development with Claude).**

1. Choosing the process and filling in the Spec Pack: *"can you make it on n8n platform"* and *"before we build it can you input the idea in the excel file to the one I have attached"*
2. Building and deploying the app: *"Refer to the above excel, refer to the automation we are trying to accomplish and also the instructions clearly. We are trying to use n8n and I will also attach the screenshot until where we have achieved on n8n platform... Deploy the code on Vercel... please give me clear very clear steps on how to build and deploy this."*
3. Mapping the build to the grading criteria: we pasted the professor's grading list and asked for the package to cover each item.

`ADD ANY OTHER PROMPTS YOUR TEAM USED HERE (for example, while building the n8n workflow)`

We reviewed and tested all AI-generated work ourselves: we ran every outcome path, checked the
thresholds against our Spec Pack, and decided which variances were acceptable.
