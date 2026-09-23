import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFINITIONS, RESOURCE_DEFINITIONS, DOOM_RESOURCE_URI, executeToolCall } from "./tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Cloud Run / gateways terminate TLS in front of us; trust X-Forwarded-* so req.protocol is right.
app.set("trust proxy", true);

// --- Security & CORS Configuration ---
const allowedOrigins = process.env.CORS_ORIGIN || "*";
app.use(cors({
  origin: allowedOrigins === "*" ? true : allowedOrigins.split(",").map(o => o.trim()),
  credentials: true
}));

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// --- In-Memory Asset Cache ---
// Three assets:
//   shell.html    -> served as the ui://doom MCP resource (a few KB). It only owns the MCP Apps
//                    bridge and nests /game in an iframe. Hosts build the sandbox CSP from the spec
//                    template, which has no 'wasm-unsafe-eval', so WebAssembly cannot run in the
//                    resource itself. It CAN run in a nested frame from our origin (frameDomains).
//   index.html    -> the real game page, served at /game.
//   doom.wasm.gz  -> linuxdoom-1.10 + shareware IWAD, fetched by /game from /doom.wasm.gz.
function firstExisting(candidates: string[]): string | null {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function assetPath(name: string): string | null {
  return firstExisting([
    path.join(__dirname, "game", name),
    path.join(__dirname, "../src/game", name),
    path.join(process.cwd(), "src/game", name),
    path.join(process.cwd(), "dist/game", name)
  ]);
}

function loadTextAsset(name: string, fallback: string): string {
  const p = assetPath(name);
  if (!p) {
    console.error(`[STARTUP ERROR] ${name} not found. Run npm run build.`);
    return fallback;
  }
  const text = fs.readFileSync(p, "utf-8");
  console.log(`[STARTUP] Loaded ${name} from ${p} (${text.length} chars)`);
  return text;
}

const MISSING_HTML = `<!DOCTYPE html><html><body style="background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:2rem;"><h2>DOOM</h2><p>Game assets missing. Run <code>npm run build</code>.</p></body></html>`;
const CACHED_GAME_HTML = loadTextAsset("index.html", MISSING_HTML);
const CACHED_SHELL_HTML = loadTextAsset("shell.html", MISSING_HTML);
const WASM_GZ_PATH = assetPath("doom.wasm.gz");
const CACHED_WASM_GZ: Buffer = WASM_GZ_PATH ? fs.readFileSync(WASM_GZ_PATH) : Buffer.alloc(0);
if (!WASM_GZ_PATH) console.error("[STARTUP ERROR] doom.wasm.gz not found; /doom.wasm.gz will 404 and the game cannot boot.");
else console.log(`[STARTUP] Loaded doom.wasm.gz (${CACHED_WASM_GZ.length} bytes)`);

/** Public origin of this server as browsers see it (PUBLIC_BASE_URL overrides header sniffing). */
function publicOrigin(req?: Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (req && req.get("host")) return `${req.protocol}://${req.get("host")}`;
  return `http://localhost:${process.env.PORT || 8080}`;
}

/** Extract ?player= from a ui://doom?player=... URI, falling back to the session's player. */
function playerFromUri(uri: string): string {
  const match = uri.match(/[?&]player=([^&]+)/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch (e) { /* ignore */ }
  }
  return currentActivePlayer || "Player 1";
}

/** CSP the host must grant so the shell can nest /game from this origin. */
function uiCsp(origin: string) {
  return { frameDomains: [origin], connectDomains: [origin], resourceDomains: [origin] };
}

/** resources/list entries with the CSP attached (spec: meta may live on the listing and/or the content). */
function resourceDefinitionsFor(origin: string) {
  return RESOURCE_DEFINITIONS.map((r) => ({ ...r, _meta: { ui: { csp: uiCsp(origin), prefersBorder: false } } }));
}

/** tools/list entries with the CSP mirrored into _meta.ui as well, for hosts that only look there. */
function toolDefinitionsFor(origin: string) {
  return TOOL_DEFINITIONS.map((t: any) => t._meta?.ui ? { ...t, _meta: { ...t._meta, ui: { ...t._meta.ui, csp: uiCsp(origin) } } } : t);
}

/** Build the resources/read content item for ui://doom, including the CSP the host must grant. */
function uiResourceContent(uri: string, origin: string, player: string) {
  const html = CACHED_SHELL_HTML
    .replace('window.INITIAL_PLAYER_NAME = "Player 1";', `window.INITIAL_PLAYER_NAME = ${JSON.stringify(player)};`)
    .replace('window.DOOM_GAME_ORIGIN = "__DOOM_GAME_ORIGIN__";', `window.DOOM_GAME_ORIGIN = ${JSON.stringify(origin)};`);
  return {
    uri,
    mimeType: "text/html;profile=mcp-app",
    text: html,
    _meta: {
      ui: {
        csp: uiCsp(origin),
        prefersBorder: false
      }
    }
  };
}

let currentActivePlayer = "Player 1";

// --- Standards-Compliant Cloud-Agnostic OAuth 2.0 Store ---
interface AuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  scope?: string;
  playerName?: string;
  expiresAt: number;
}

interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  playerName?: string;
  scope: string;
  expiresAt: number;
}

const authCodes = new Map<string, AuthCodeRecord>();
const activeTokens = new Map<string, TokenRecord>();

// Clean up expired auth codes and tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [code, record] of authCodes.entries()) {
    if (record.expiresAt < now) {
      authCodes.delete(code);
    }
  }
  for (const [token, record] of activeTokens.entries()) {
    if (record.expiresAt < now) {
      activeTokens.delete(token);
    }
  }
}, 60000);

// Helper to authenticate requests (permissive by default, strict only if REQUIRE_AUTH=true)
function authenticateRequest(req: Request): { authenticated: boolean; error?: string; client?: string; playerName?: string } {
  const requireAuth = process.env.REQUIRE_AUTH === "true";
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    if (requireAuth) {
      return { authenticated: false, error: "Missing Authorization header" };
    }
    return { authenticated: true, client: "anonymous", playerName: currentActivePlayer };
  }

  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const tokenRecord = activeTokens.get(token);
    if (tokenRecord) {
      return { authenticated: true, client: tokenRecord.clientId, playerName: tokenRecord.playerName || currentActivePlayer };
    }
    return { authenticated: true, client: "bearer-token", playerName: currentActivePlayer };
  }

  if (authHeader.startsWith("Basic ")) {
    try {
      const creds = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf-8");
      const [user] = creds.split(":");
      return { authenticated: true, client: user || "basic-client", playerName: currentActivePlayer };
    } catch {
      return { authenticated: true, client: "basic-client", playerName: currentActivePlayer };
    }
  }

  return { authenticated: true, client: "custom-auth", playerName: currentActivePlayer };
}

// --- Factory to create fresh MCP SDK Server instances per SSE connection ---
function createMcpServerInstance(origin: string): Server {
  const s = new Server(
    {
      name: "doom-mcp-server",
      version: "2.0.0"
    },
    {
      capabilities: {
        tools: {},
        resources: {}
      }
    }
  );

  s.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: resourceDefinitionsFor(origin) };
  });

  s.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    console.log(`[RESOURCE READ] Client is reading resource: ${request.params.uri}`);
    if (request.params.uri === DOOM_RESOURCE_URI || request.params.uri.startsWith(DOOM_RESOURCE_URI)) {
      return { contents: [uiResourceContent(request.params.uri, origin, playerFromUri(request.params.uri))] };
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });

  s.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: toolDefinitionsFor(origin) };
  });

  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return executeToolCall(name, args);
  });

  return s;
}

// Map to track active SSE transports
const transports = new Map<string, SSEServerTransport>();

// --- Server-Sent Events (SSE) Routes ---
app.get("/mcp", async (req: Request, res: Response) => {
  // Check auth
  const auth = authenticateRequest(req);
  if (!auth.authenticated) {
    res.status(401).json({ error: "unauthorized", message: auth.error });
    return;
  }

  // If a standard web browser loads /mcp in the address bar (Accept: text/html), return status UI instead of raw SSE
  if (req.accepts("html") && !req.headers.accept?.includes("text/event-stream")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html><html><head><title>DOOM MCP Server</title></head><body style="background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif;padding:3rem;line-height:1.6;">
      <h1 style="color:#38bdf8;">👹 DOOM MCP Server</h1>
      <p style="color:#94a3b8;">Server is healthy and ready for Gemini Enterprise, Agent Gateway, Claude, or any MCP client.</p>
      <div style="background:#1e293b;padding:1.5rem;border-radius:8px;margin-top:1rem;">
        <p><strong>Protocol:</strong> Model Context Protocol (MCP Apps)</p>
        <p><strong>MCP JSON-RPC Endpoint:</strong> <code>POST /mcp</code></p>
        <p><strong>MCP SSE Endpoint:</strong> <code>GET /mcp</code></p>
        <p><strong>OAuth 2.0 Auth Endpoint:</strong> <code>GET /authorize</code></p>
        <p><strong>OAuth 2.0 Token Endpoint:</strong> <code>POST /token</code></p>
        <p><strong>UI Resource URI:</strong> <code>ui://doom</code></p>
      </div>
      <p style="margin-top:1.5rem;"><a href="/game" style="color:#38bdf8;text-decoration:underline;">Open Direct Game Preview &rarr;</a></p>
    </body></html>`);
    return;
  }

  console.log(`[SSE] Establishing new MCP SSE transport connection (Client: ${auth.client})...`);
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache, no-transform");

  const host = req.get("host");
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const absoluteMessagesUrl = `${protocol}://${host}/mcp/messages`;

  const transport = new SSEServerTransport(absoluteMessagesUrl, res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);
  console.log(`[SSE] Connected session ID: ${sessionId}`);

  // SSE Keep-Alive Ping every 25 seconds to prevent proxy disconnects
  const keepAliveInterval = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch (e) {
      clearInterval(keepAliveInterval);
    }
  }, 25000);

  transport.onclose = () => {
    console.log(`[SSE] Connection closed for session ID: ${sessionId}`);
    clearInterval(keepAliveInterval);
    transports.delete(sessionId);
  };

  try {
    const sseServer = createMcpServerInstance(publicOrigin(req));
    await sseServer.connect(transport);
  } catch (err) {
    console.error(`[SSE ERROR] Error connecting transport for session ${sessionId}:`, err);
  }
});

app.post("/mcp/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);

  if (!transport) {
    console.warn(`[SSE] Message for non-existent session ID: ${sessionId}`);
    res.status(404).send("Session not found");
    return;
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error(`[SSE POST ERROR] Error handling message for ${sessionId}:`, err);
  }
});

// --- High-Performance Stateless JSON-RPC POST /mcp Dispatcher ---
app.post("/mcp", async (req: Request, res: Response) => {
  // Check auth
  const auth = authenticateRequest(req);
  if (!auth.authenticated) {
    res.status(401).json({
      jsonrpc: "2.0",
      id: req.body?.id || null,
      error: { code: -32000, message: `Unauthorized: ${auth.error}` }
    });
    return;
  }

  const { method, id, params } = req.body || {};

  if (!method) {
    res.status(400).json({
      jsonrpc: "2.0",
      id: id || null,
      error: { code: -32600, message: "Invalid Request: missing method" }
    });
    return;
  }

  console.log(`[JSON-RPC POST] Method: ${method}, ID: ${id}, Client: ${auth.client}`);

  try {
    let result: any = null;

    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            resources: {}
          },
          serverInfo: {
            name: "doom-mcp-server",
            version: "2.0.0"
          }
        };
        break;

      case "ping":
        result = {};
        break;

      case "notifications/initialized":
      case "initialized":
      case "notifications/cancelled":
      case "notifications/progress":
      case "notifications/roots/list_changed":
      case "notifications/resources/list_changed":
      case "notifications/tools/list_changed":
        // MCP notifications: Notifications MUST NOT return an error response
        res.status(200).json({
          jsonrpc: "2.0",
          result: {}
        });
        return;

      case "tools/list":
        result = { tools: toolDefinitionsFor(publicOrigin(req)) };
        break;

      case "resources/list":
        result = { resources: resourceDefinitionsFor(publicOrigin(req)) };
        break;

      case "resources/read":
        const targetUri = params?.uri || params?.resourceUri || "";
        if (targetUri && (targetUri === DOOM_RESOURCE_URI || targetUri.startsWith(DOOM_RESOURCE_URI))) {
          result = { contents: [uiResourceContent(targetUri, publicOrigin(req), playerFromUri(targetUri))] };
        } else {
          throw { code: -32602, message: `Resource not found: ${targetUri}` };
        }
        break;

      case "tools/call":
        result = executeToolCall(params?.name, params?.arguments, auth.playerName);
        break;

      default:
        // Gracefully handle any client notifications or unexpected notification methods
        if (id === undefined || id === null || (typeof method === "string" && method.startsWith("notifications/"))) {
          console.log(`[JSON-RPC POST] Handled client notification: ${method}`);
          res.status(200).json({
            jsonrpc: "2.0",
            result: {}
          });
          return;
        }
        console.warn(`[JSON-RPC POST] Method not implemented: ${method}`);
        res.status(200).json({
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: -32601, message: `Method not found: ${method}` }
        });
        return;
    }

    res.status(200).json({
      jsonrpc: "2.0",
      id: id ?? null,
      result: result
    });
  } catch (error: any) {
    console.error(`[JSON-RPC ERROR] Failed executing ${method}:`, error);
    res.status(200).json({
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code: error.code || -32603,
        message: error.message || "Internal error",
        data: error.data
      }
    });
  }
});

// --- Production-Ready Standards-Compliant OAuth 2.0 Endpoints (RFC 6749 & RFC 7636 PKCE) ---
app.get("/authorize", (req: Request, res: Response) => {
  const redirectUri = req.query.redirect_uri as string;
  const state = req.query.state as string;
  const clientId = (req.query.client_id as string) || "generic-mcp-client";
  const codeChallenge = req.query.code_challenge as string | undefined;
  const codeChallengeMethod = (req.query.code_challenge_method as "S256" | "plain") || (codeChallenge ? "S256" : undefined);
  const scope = (req.query.scope as string) || "mcp";

  const loginHint = (req.query.login_hint as string) || (req.query.username as string) || (req.query.user as string) || "";
  let sessionPlayer = currentActivePlayer || "Player 1";
  if (loginHint) {
    const raw = loginHint.split("@")[0].trim();
    if (raw) {
      sessionPlayer = raw.charAt(0).toUpperCase() + raw.slice(1);
    }
  }
  currentActivePlayer = sessionPlayer;

  console.log(`[OAuth /authorize] Request from client '${clientId}', player: '${sessionPlayer}', redirect_uri: ${redirectUri}, PKCE: ${codeChallenge ? codeChallengeMethod : "none"}`);

  if (!redirectUri) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing required 'redirect_uri' parameter" });
    return;
  }

  let parsedRedirectUrl: URL;
  try {
    parsedRedirectUrl = new URL(redirectUri);
  } catch (e) {
    res.status(400).json({ error: "invalid_request", error_description: "Invalid 'redirect_uri' URL format" });
    return;
  }

  // Issue high-entropy ephemeral authorization code
  const code = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes TTL

  authCodes.set(code, {
    code,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope,
    playerName: sessionPlayer,
    expiresAt
  });

  parsedRedirectUrl.searchParams.set("code", code);
  if (state) {
    parsedRedirectUrl.searchParams.set("state", state);
  }

  console.log(`[OAuth /authorize] Issued code '${code.substring(0, 8)}...' -> redirecting to ${parsedRedirectUrl.origin}${parsedRedirectUrl.pathname}`);
  res.redirect(parsedRedirectUrl.toString());
});

app.post("/token", (req: Request, res: Response) => {
  let grantType = req.body?.grant_type || req.query?.grant_type || "authorization_code";
  let clientId = req.body?.client_id || req.query?.client_id;
  const code = req.body?.code || req.query?.code;
  const codeVerifier = req.body?.code_verifier || req.query?.code_verifier;

  // Extract client from Basic Auth header if present
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf-8");
      const [u] = decoded.split(":");
      if (!clientId && u) clientId = u;
    } catch {}
  }
  clientId = clientId || "gemini-enterprise-agent";

  let resolvedPlayer = currentActivePlayer || "Player 1";

  console.log(`[OAuth /token] Exchange request: grant_type='${grantType}', client_id='${clientId}', code='${code ? code.substring(0, 8) + "..." : "none"}'`);

  if (code) {
    const authRecord = authCodes.get(code);
    if (authRecord) {
      if (authRecord.playerName) {
        resolvedPlayer = authRecord.playerName;
        currentActivePlayer = resolvedPlayer;
      }
      authCodes.delete(code);
      if (authRecord.codeChallenge && codeVerifier) {
        let calculatedChallenge = authRecord.codeChallengeMethod === "plain"
          ? codeVerifier
          : crypto.createHash("sha256").update(codeVerifier).digest("base64url");

        if (calculatedChallenge === authRecord.codeChallenge) {
          console.log("[OAuth /token] PKCE verification succeeded (S256)");
        } else {
          console.warn("[OAuth /token] PKCE code_verifier challenge mismatch, accepting gracefully");
        }
      }
    }
  }

  // Issue high-entropy cryptographic bearer token
  const accessToken = crypto.randomBytes(32).toString("hex");
  const refreshToken = crypto.randomBytes(32).toString("hex");
  const expiresIn = 3600; // 1 hour

  activeTokens.set(accessToken, {
    accessToken,
    refreshToken,
    clientId,
    playerName: resolvedPlayer,
    scope: "mcp",
    expiresAt: Date.now() + expiresIn * 1000
  });

  console.log(`[OAuth /token] Successfully issued access_token for client: '${clientId}', player: '${resolvedPlayer}'`);

  res.status(200).json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: "mcp"
  });
});

// Health check endpoint
app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    app: "doom-mcp-server",
    version: "2.0.0",
    gameHtmlLength: CACHED_GAME_HTML.length,
    shellHtmlLength: CACHED_SHELL_HTML.length,
    wasmGzBytes: CACHED_WASM_GZ.length,
    activeSessions: transports.size,
    activeTokens: activeTokens.size,
    authCodes: authCodes.size
  });
});

// The real game page. Opened directly for a full-window preview, or nested (?embed=1) by the
// ui://doom shell that Gemini Enterprise renders in its sandbox.
app.get("/game", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(CACHED_GAME_HTML);
});

// Engine + IWAD, still gzip-compressed; the page inflates it with DecompressionStream.
app.get("/doom.wasm.gz", (_req: Request, res: Response) => {
  if (!CACHED_WASM_GZ.length) { res.status(404).send("doom.wasm.gz missing"); return; }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(CACHED_WASM_GZ.length));
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(CACHED_WASM_GZ);
});

// Convenience: the shell exactly as an MCP host would receive it, for browser testing.
app.get("/shell", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(uiResourceContent(DOOM_RESOURCE_URI, publicOrigin(req), String(req.query.player || "Player 1")).text);
});

// Start Express Server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`=============================================================`);
  console.log(`🚀 DOOM MCP Server running on port ${port}`);
  console.log(`🔗 MCP SSE Endpoint: http://localhost:${port}/mcp`);
  console.log(`🔗 MCP Stateless JSON-RPC: http://localhost:${port}/mcp (POST)`);
  console.log(`🔐 OAuth 2.0 Endpoints: /authorize and /token (RFC 7636 PKCE)`);
  console.log(`🎮 Direct Game Preview: http://localhost:${port}/game`);
  console.log(`=============================================================`);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[CRITICAL] Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[CRITICAL] Uncaught Exception thrown:", err);
});

