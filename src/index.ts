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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

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

// --- In-Memory HTML Cache ---
function loadGameHtml(): string {
  const pathsToTry = [
    path.join(__dirname, "game/index.html"),
    path.join(__dirname, "../src/game/index.html"),
    path.join(process.cwd(), "src/game/index.html"),
    path.join(process.cwd(), "dist/game/index.html")
  ];

  for (const p of pathsToTry) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8");
      console.log(`[STARTUP] Pre-cached Breakout Game HTML from: ${p} (${content.length} chars)`);
      return content;
    }
  }

  console.error("[STARTUP ERROR] Breakout Game HTML not found! Using fallback shell.");
  return `<!DOCTYPE html><html><body style="background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:2rem;"><h2>Retro Breakout Game</h2><p>Game asset loaded in fallback mode.</p></body></html>`;
}

const CACHED_GAME_HTML = loadGameHtml();

// --- Standards-Compliant Cloud-Agnostic OAuth 2.0 Store ---
interface AuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  scope?: string;
  expiresAt: number;
}

interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  clientId: string;
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

// Helper to authenticate Bearer tokens if REQUIRE_AUTH=true
function authenticateRequest(req: Request): { authenticated: boolean; error?: string; client?: string } {
  const requireAuth = process.env.REQUIRE_AUTH === "true";
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    if (requireAuth) {
      return { authenticated: false, error: "Missing Authorization header" };
    }
    return { authenticated: true, client: "anonymous" };
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return { authenticated: false, error: "Invalid Authorization header format. Expected Bearer <token>" };
  }

  const token = parts[1];
  const tokenRecord = activeTokens.get(token);

  if (!tokenRecord) {
    if (requireAuth) {
      return { authenticated: false, error: "Invalid or expired Bearer token" };
    }
    return { authenticated: true, client: "unverified-bearer" };
  }

  if (tokenRecord.expiresAt < Date.now()) {
    activeTokens.delete(token);
    if (requireAuth) {
      return { authenticated: false, error: "Bearer token has expired" };
    }
    return { authenticated: true, client: "expired-bearer" };
  }

  return { authenticated: true, client: tokenRecord.clientId };
}

// --- Tool & Resource Definitions ---
const TOOL_DEFINITIONS = [
  {
    name: "launch_breakout",
    description: "Launches the retro Atari Breakout game inside the Gemini Enterprise conversation window. Use this when the user mentions playing breakout, starting a game, or wanting to see the interactive arcade game.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    _meta: {
      ui: {
        resourceUri: "ui://breakout"
      }
    }
  },
  {
    name: "get_game_config",
    description: "Internal tool called by the game UI on load to retrieve starting configurations. Do not invoke this tool directly unless inspecting default settings.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "get_breakout_settings",
    description: "Retrieves the current live configuration of your active game session.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "update_game_settings",
    description: "Live-updates parameters of the active Breakout game. You can use this to make the game easier or harder based on user request (e.g. widening the paddle, slowing down the ball, adding lives, or enabling AI Autopilot).",
    inputSchema: {
      type: "object",
      properties: {
        paddleSize: {
          type: "number",
          description: "The width of the paddle in pixels. Default is 120. Clamped between 40 and 350."
        },
        ballSpeed: {
          type: "number",
          description: "The speed of the ball. Default is 5.5. Clamped between 1.0 and 15.0."
        },
        lives: {
          type: "number",
          description: "Total player lives. Default is 3. Clamped between 1 and 20."
        },
        autopilot: {
          type: "boolean",
          description: "Whether to enable AI Autopilot mode where the paddle automatically tracks the ball."
        },
        godMode: {
          type: "boolean",
          description: "Enable God Mode where the ball bounces automatically at the bottom of the screen instead of falling out."
        }
      },
      required: []
    }
  },
  {
    name: "modify_breakout_settings",
    description: "Allows you to live-adjust gameplay physics and rules. You can make the paddle wider, speed up or slow down the ball, add lives, or turn on autopilot/god mode.",
    inputSchema: {
      type: "object",
      properties: {
        paddleWidth: {
          type: "number",
          description: "The width of the paddle in pixels. Default is 120. Clamped between 40 and 350."
        },
        paddleSize: {
          type: "number",
          description: "The width of the paddle in pixels. Default is 120. Clamped between 40 and 350."
        },
        ballSpeed: {
          type: "number",
          description: "The speed of the ball. Default is 5.5. Clamped between 1.0 and 15.0."
        },
        lives: {
          type: "number",
          description: "Total player lives. Default is 3. Clamped between 1 and 20."
        },
        autopilot: {
          type: "boolean",
          description: "Whether to enable AI Autopilot mode where the paddle automatically tracks the ball."
        },
        godMode: {
          type: "boolean",
          description: "Enable God Mode where the ball bounces automatically at the bottom of the screen instead of falling out."
        }
      },
      required: []
    }
  },
  {
    name: "trigger_game_cheat",
    description: "Activates a fun arcade cheat code inside the active game.",
    inputSchema: {
      type: "object",
      properties: {
        cheat: {
          type: "string",
          enum: ["mega_paddle", "laser_paddle", "god_mode", "extra_ball", "slow_ball", "win_level"],
          description: "The name of the cheat code to activate. 'mega_paddle' widens the paddle to 220px, 'laser_paddle' equips twin laser blaster cannons to shoot bricks, 'god_mode' makes you invincible, 'extra_ball' adds a life, 'slow_ball' reduces speed, 'win_level' instantly clears the level."
        }
      },
      required: ["cheat"]
    }
  },
  {
    name: "apply_breakout_cheat",
    description: "Triggers special, fun gameplay overrides on your active canvas.",
    inputSchema: {
      type: "object",
      properties: {
        cheatType: {
          type: "string",
          enum: ["megaPaddle", "laserPaddle", "godMode", "extraBall", "slowBall", "levelBypass"],
          description: "The name of the cheat code to activate."
        },
        cheat: {
          type: "string",
          enum: ["mega_paddle", "laser_paddle", "god_mode", "extra_ball", "slow_ball", "win_level"],
          description: "The name of the cheat code to activate."
        }
      },
      required: []
    }
  }
];

const RESOURCE_DEFINITIONS = [
  {
    uri: "ui://breakout",
    name: "Retro Breakout Game",
    description: "An interactive, retro Atari-style Breakout arcade game with color particle explosions and AI autopilot mode.",
    mimeType: "text/html;profile=mcp-app"
  }
];

// --- Core Tool Execution Logic with Parameter Bounds & Sanitization ---
function executeToolCall(name: string, args: any) {
  console.log(`[TOOL CALL] Executing tool: ${name} with args:`, JSON.stringify(args || {}));

  if (name === "launch_breakout" || name === "get_breakout_game" || name === "launch_game") {
    return {
      content: [
        {
          type: "text",
          text: "I have initialized the Retro Breakout Game! The interactive Atari Breakout canvas is loaded directly into your chat window below. Control the paddle using your Left and Right arrow keys or touch swipe, or ask me to turn on AI Autopilot or adjust settings for you!"
        }
      ],
      _meta: {
        ui: {
          resourceUri: "ui://breakout"
        }
      }
    };
  }

  if (name === "get_game_config" || name === "get_breakout_settings") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            settings: {
              paddleSize: 120,
              ballSpeed: 5.5,
              lives: 3,
              autopilot: false,
              godMode: false
            }
          })
        }
      ],
      _meta: {
        ui: {
          resourceUri: "ui://breakout"
        }
      }
    };
  }

  if (name === "update_game_settings" || name === "modify_breakout_settings") {
    const settings: Record<string, any> = {};
    const paddleValue = args?.paddleSize !== undefined ? Number(args.paddleSize) : (args?.paddleWidth !== undefined ? Number(args.paddleWidth) : undefined);
    
    // Explicit parameter bounding & validation
    if (paddleValue !== undefined && !isNaN(paddleValue)) {
      settings.paddleSize = Math.max(40, Math.min(350, Math.round(paddleValue)));
    }
    if (args?.ballSpeed !== undefined) {
      const speed = Number(args.ballSpeed);
      if (!isNaN(speed)) {
        settings.ballSpeed = Math.max(1.0, Math.min(15.0, Number(speed.toFixed(1))));
      }
    }
    if (args?.lives !== undefined) {
      const lives = Number(args.lives);
      if (!isNaN(lives)) {
        settings.lives = Math.max(1, Math.min(20, Math.floor(lives)));
      }
    }
    if (args?.autopilot !== undefined) settings.autopilot = Boolean(args.autopilot);
    if (args?.godMode !== undefined) settings.godMode = Boolean(args.godMode);

    const summaryParts = [];
    if (settings.paddleSize !== undefined) summaryParts.push(`paddle size to ${settings.paddleSize}px`);
    if (settings.ballSpeed !== undefined) summaryParts.push(`ball speed to ${settings.ballSpeed}`);
    if (settings.lives !== undefined) summaryParts.push(`lives config to ${settings.lives}`);
    if (settings.autopilot !== undefined) summaryParts.push(`AI autopilot to ${settings.autopilot ? "ON" : "OFF"}`);
    if (settings.godMode !== undefined) summaryParts.push(`God Mode to ${settings.godMode ? "ON" : "OFF"}`);

    const textSummary = summaryParts.length > 0 
      ? `Successfully updated game settings: ${summaryParts.join(", ")}.`
      : "No settings changes requested.";

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            message: textSummary,
            settings: settings
          })
        }
      ],
      _meta: {
        ui: {
          resourceUri: "ui://breakout"
        }
      }
    };
  }

  if (name === "trigger_game_cheat" || name === "apply_breakout_cheat") {
    let cheat = (args?.cheat || args?.cheatType) as string;

    if (cheat === "godMode") cheat = "god_mode";
    if (cheat === "extraBall") cheat = "extra_ball";
    if (cheat === "slowBall") cheat = "slow_ball";
    if (cheat === "megaPaddle") cheat = "mega_paddle";
    if (cheat === "laserPaddle") cheat = "laser_paddle";
    if (cheat === "levelBypass") cheat = "win_level";

    const allowedCheats = ["god_mode", "extra_ball", "slow_ball", "mega_paddle", "laser_paddle", "win_level"];
    if (!allowedCheats.includes(cheat)) {
      throw new Error(`Invalid cheat code: '${cheat}'. Allowed cheats: ${allowedCheats.join(", ")}`);
    }

    let desc = "";
    if (cheat === "god_mode") desc = "Invincibility (God Mode) enabled! The ball bounces safely on the screen bottom.";
    if (cheat === "extra_ball") desc = "One extra life awarded!";
    if (cheat === "slow_ball") desc = "Ball speed decreased for easy tracking.";
    if (cheat === "mega_paddle") desc = "Mega Paddle activated! Paddle widened to 220px.";
    if (cheat === "laser_paddle") desc = "Laser Cannons equipped! Twin blaster turrets shoot lasers on click/space to destroy bricks.";
    if (cheat === "win_level") desc = "Current level cleared!";

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            message: `Cheat code triggered: ${desc}`,
            cheatApplied: cheat
          })
        }
      ],
      _meta: {
        ui: {
          resourceUri: "ui://breakout"
        }
      }
    };
  }

  throw new Error(`Tool not found: ${name}`);
}

// --- Factory to create fresh MCP SDK Server instances per SSE connection ---
function createMcpServerInstance(): Server {
  const s = new Server(
    {
      name: "retro-breakout-server",
      version: "1.2.0"
    },
    {
      capabilities: {
        tools: {},
        resources: {}
      }
    }
  );

  s.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: RESOURCE_DEFINITIONS };
  });

  s.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    console.log(`[RESOURCE READ] Client is reading resource: ${request.params.uri}`);
    if (request.params.uri === "ui://breakout") {
      return {
        contents: [
          {
            uri: "ui://breakout",
            mimeType: "text/html;profile=mcp-app",
            text: CACHED_GAME_HTML
          }
        ]
      };
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });

  s.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
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
    res.send(`<!DOCTYPE html><html><head><title>Breakout MCP Server</title></head><body style="background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif;padding:3rem;line-height:1.6;">
      <h1 style="color:#38bdf8;">🕹️ Retro Breakout MCP Server</h1>
      <p style="color:#94a3b8;">Server is healthy and ready for Gemini Enterprise, Agent Gateway, Claude, or any MCP client.</p>
      <div style="background:#1e293b;padding:1.5rem;border-radius:8px;margin-top:1rem;">
        <p><strong>Protocol:</strong> Model Context Protocol (MCP Apps)</p>
        <p><strong>MCP JSON-RPC Endpoint:</strong> <code>POST /mcp</code></p>
        <p><strong>MCP SSE Endpoint:</strong> <code>GET /mcp</code></p>
        <p><strong>OAuth 2.0 Auth Endpoint:</strong> <code>GET /authorize</code></p>
        <p><strong>OAuth 2.0 Token Endpoint:</strong> <code>POST /token</code></p>
        <p><strong>UI Resource URI:</strong> <code>ui://breakout</code></p>
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
    const sseServer = createMcpServerInstance();
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
            name: "retro-breakout-server",
            version: "1.2.0"
          }
        };
        break;

      case "ping":
        result = {};
        break;

      case "tools/list":
        result = { tools: TOOL_DEFINITIONS };
        break;

      case "resources/list":
        result = { resources: RESOURCE_DEFINITIONS };
        break;

      case "resources/read":
        if (params?.uri === "ui://breakout") {
          result = {
            contents: [
              {
                uri: "ui://breakout",
                mimeType: "text/html;profile=mcp-app",
                text: CACHED_GAME_HTML
              }
            ]
          };
        } else {
          throw { code: -32602, message: `Resource not found: ${params?.uri}` };
        }
        break;

      case "tools/call":
        result = executeToolCall(params?.name, params?.arguments);
        break;

      default:
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

  console.log(`[OAuth /authorize] Request from client '${clientId}', redirect_uri: ${redirectUri}, PKCE: ${codeChallenge ? codeChallengeMethod : "none"}`);

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
  const grantType = req.body?.grant_type || req.query?.grant_type;
  const clientId = req.body?.client_id || req.query?.client_id || "generic-mcp-client";

  console.log(`[OAuth /token] Exchange request: grant_type='${grantType}', client_id='${clientId}'`);

  if (grantType === "authorization_code") {
    const code = req.body?.code || req.query?.code;
    const redirectUri = req.body?.redirect_uri || req.query?.redirect_uri;
    const codeVerifier = req.body?.code_verifier || req.query?.code_verifier;

    if (!code) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing 'code' parameter" });
      return;
    }

    const authRecord = authCodes.get(code);
    if (!authRecord) {
      res.status(400).json({ error: "invalid_grant", error_description: "Authorization code is invalid or has already been used" });
      return;
    }

    // Single-use guarantee: remove code immediately
    authCodes.delete(code);

    if (authRecord.expiresAt < Date.now()) {
      res.status(400).json({ error: "invalid_grant", error_description: "Authorization code has expired" });
      return;
    }

    if (redirectUri && authRecord.redirectUri && redirectUri !== authRecord.redirectUri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }

    // RFC 7636 PKCE Verification
    if (authRecord.codeChallenge) {
      if (!codeVerifier) {
        res.status(400).json({ error: "invalid_request", error_description: "Missing 'code_verifier' for PKCE challenge" });
        return;
      }

      let calculatedChallenge: string;
      if (authRecord.codeChallengeMethod === "plain") {
        calculatedChallenge = codeVerifier;
      } else {
        // S256 default
        calculatedChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
      }

      if (calculatedChallenge !== authRecord.codeChallenge) {
        console.warn("[OAuth /token] PKCE code_verifier mismatch!");
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
      console.log("[OAuth /token] PKCE verification succeeded (S256)");
    }

    // Issue cryptographic bearer token
    const accessToken = crypto.randomBytes(32).toString("hex");
    const refreshToken = crypto.randomBytes(32).toString("hex");
    const expiresIn = 3600; // 1 hour

    activeTokens.set(accessToken, {
      accessToken,
      refreshToken,
      clientId: authRecord.clientId,
      scope: authRecord.scope || "mcp",
      expiresAt: Date.now() + expiresIn * 1000
    });

    console.log(`[OAuth /token] Successfully issued access_token for client: '${authRecord.clientId}'`);

    res.status(200).json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: authRecord.scope || "mcp"
    });
    return;
  }

  if (grantType === "refresh_token") {
    const refreshToken = req.body?.refresh_token || req.query?.refresh_token;
    if (!refreshToken) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing 'refresh_token' parameter" });
      return;
    }

    let foundToken: TokenRecord | undefined;
    for (const [_, record] of activeTokens.entries()) {
      if (record.refreshToken === refreshToken) {
        foundToken = record;
        break;
      }
    }

    if (!foundToken) {
      res.status(400).json({ error: "invalid_grant", error_description: "Invalid refresh token" });
      return;
    }

    // Rotate tokens
    activeTokens.delete(foundToken.accessToken);
    const newAccessToken = crypto.randomBytes(32).toString("hex");
    const newRefreshToken = crypto.randomBytes(32).toString("hex");
    const expiresIn = 3600;

    activeTokens.set(newAccessToken, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      clientId: foundToken.clientId,
      scope: foundToken.scope,
      expiresAt: Date.now() + expiresIn * 1000
    });

    res.status(200).json({
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: foundToken.scope
    });
    return;
  }

  if (grantType === "client_credentials") {
    const accessToken = crypto.randomBytes(32).toString("hex");
    const expiresIn = 3600;

    activeTokens.set(accessToken, {
      accessToken,
      refreshToken: "",
      clientId,
      scope: req.body?.scope || "mcp",
      expiresAt: Date.now() + expiresIn * 1000
    });

    res.status(200).json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: req.body?.scope || "mcp"
    });
    return;
  }

  res.status(400).json({
    error: "unsupported_grant_type",
    error_description: `Grant type '${grantType}' is not supported. Supported: authorization_code, refresh_token, client_credentials`
  });
});

// Health check endpoint
app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    app: "retro-breakout-mcp-server",
    version: "1.2.0",
    cachedHtmlLength: CACHED_GAME_HTML.length,
    activeSessions: transports.size,
    activeTokens: activeTokens.size,
    authCodes: authCodes.size
  });
});

// Direct UI preview endpoint for browser verification
app.get("/game", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(CACHED_GAME_HTML);
});

// Start Express Server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`=============================================================`);
  console.log(`🚀 Retro Breakout MCP Server running on port ${port}`);
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

