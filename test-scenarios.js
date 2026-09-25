// Run with:  npm test   (checks every outcome path of the pipeline, no API keys needed)
delete process.env.OPENAI_API_KEY; // test the deterministic path
const { runTriage } = require("../api/_engine");
const scenarios = require("./scenarios.json");

(async () => {
  let failed = 0;
  const seen = [];
  for (const s of scenarios) {
    const row = await runTriage(s.ticket, seen);
    seen.push(row.dedupe_key);
    const ok = row.outcome === s.expect;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${s.label.padEnd(26)} -> ${row.outcome}  (category ${row.category}, conf ${row.confidence})`);
  }
  const dup = await runTriage(scenarios[0].ticket, seen);
  const dupOk = dup.outcome === "Dropped (Duplicate)";
  if (!dupOk) failed++;
  console.log(`${dupOk ? "PASS" : "FAIL"}  ${"Resubmitted T-1001".padEnd(26)} -> ${dup.outcome}`);
  console.log(failed ? `\n${failed} scenario(s) failed` : "\nAll scenarios passed");
  process.exit(failed ? 1 : 0);
})();
