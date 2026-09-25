// Optional local preview without the Vercel CLI:  node scripts/local-server.js  -> http://localhost:3000
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
http.createServer(async (req, res) => {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
  const url = req.url.split("?")[0];
  if (url.startsWith("/api/")) {
    const file = path.join(root, "api", url.slice(5) + ".js");
    if (!fs.existsSync(file) || path.basename(file).startsWith("_")) return res.status(404).json({ error: "Not found" });
    let body = ""; for await (const c of req) body += c;
    try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = body; }
    return require(file)(req, res);
  }
  res.setHeader("Content-Type", "text/html"); res.end(fs.readFileSync(path.join(root, "index.html")));
}).listen(3000, () => console.log("Open http://localhost:3000"));
