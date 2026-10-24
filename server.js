// Runs worker.js as a normal Node web server (Render or any Node 20+ host).
import http from "node:http";
import worker from "./worker.js";

const port = process.env.PORT || 3000;
// Keep only letters and numbers so the key is safe to put in a URL.
const connectorKey = (process.env.CONNECTOR_KEY || "").replace(/[^A-Za-z0-9]/g, "");
const env = { ...process.env, CONNECTOR_KEY: connectorKey };
const publicUrl = (process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");

http
  .createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://${req.headers.host || "localhost"}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500);
      res.end("Server error");
    }
  })
  .listen(port, () => {
    console.log(`Epos Now connector listening on ${port}`);
    if (connectorKey.length < 16) console.log("CONNECTOR_KEY is missing or too short, so the connector will refuse every request.");
    else if (publicUrl) console.log(`Your Claude connector link (keep it private): ${publicUrl}/${connectorKey}/mcp`);
  });

// Render's free plan sleeps after 15 minutes without visits, and waking takes about a minute.
// A visit to ourselves every 10 minutes keeps it awake; one service running all month fits in the 750 free hours.
if (publicUrl) setInterval(() => fetch(`${publicUrl}/health`).catch(() => {}), 10 * 60 * 1000).unref();
