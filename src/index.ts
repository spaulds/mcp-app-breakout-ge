import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import zlib from "zlib";
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
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// --- In-Memory HTML Cache (Eliminates File I/O Overhead) ---
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
          description: "The width of the paddle in pixels. Default is 120. Set to 180 or 240 to make it wider/easier."
        },
        ballSpeed: {
          type: "number",
          description: "The speed of the ball. Default is 5.5. Lower (e.g. 3.5) makes it slower/easier, higher (e.g. 8) makes it faster/harder."
        },
        lives: {
          type: "number",
          description: "Total player lives. Default is 3. Set to 5 or 10 to give the player more chances."
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
          description: "The width of the paddle in pixels. Default is 120. Set to 180 or 240 to make it wider/easier."
        },
        paddleSize: {
          type: "number",
          description: "The width of the paddle in pixels. Default is 120. Set to 180 or 240 to make it wider/easier."
        },
        ballSpeed: {
          type: "number",
          description: "The speed of the ball. Default is 5.5. Lower (e.g. 3.5) makes it slower/easier, higher (e.g. 8) makes it faster/harder."
        },
        lives: {
          type: "number",
          description: "Total player lives. Default is 3. Set to 5 or 10 to give the player more chances."
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
          enum: ["god_mode", "extra_ball", "slow_ball", "laser_paddle", "win_level"],
          description: "The name of the cheat code to activate."
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
          enum: ["godMode", "extraBall", "slowBall", "laserPaddle", "levelBypass"],
          description: "The name of the cheat code to activate."
        },
        cheat: {
          type: "string",
          enum: ["god_mode", "extra_ball", "slow_ball", "laser_paddle", "win_level"],
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

// --- Core Tool Execution Logic ---
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
    const paddleValue = args?.paddleSize !== undefined ? args.paddleSize : args?.paddleWidth;
    if (paddleValue !== undefined) settings.paddleSize = paddleValue;
    if (args?.ballSpeed !== undefined) settings.ballSpeed = args.ballSpeed;
    if (args?.lives !== undefined) settings.lives = args.lives;
    if (args?.autopilot !== undefined) settings.autopilot = args.autopilot;
    if (args?.godMode !== undefined) settings.godMode = args.godMode;

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
    if (cheat === "laserPaddle") cheat = "laser_paddle";
    if (cheat === "levelBypass") cheat = "win_level";

    let desc = "";
    if (cheat === "god_mode") desc = "Invincibility (God Mode) enabled! The ball bounces on the screen bottom.";
    if (cheat === "extra_ball") desc = "One extra life awarded!";
    if (cheat === "slow_ball") desc = "Ball speed decreased for easy tracking.";
    if (cheat === "laser_paddle") desc = "Paddle widened to laser width!";
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

// --- Initialize MCP SDK Server ---
const server = new Server(
  {
    name: "retro-breakout-server",
    version: "1.1.0"
  },
  {
    capabilities: {
      tools: {},
      resources: {}
    }
  }
);

// Register MCP SDK Handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: RESOURCE_DEFINITIONS };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOL_DEFINITIONS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return executeToolCall(name, args);
});

// Map to track active SSE transports
const transports = new Map<string, SSEServerTransport>();

// --- Server-Sent Events (SSE) Routes ---
app.get("/mcp", async (req, res) => {
  console.log("[SSE] Establishing new MCP SSE transport connection...");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache, no-transform");

  const host = req.get("host");
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const absoluteMessagesUrl = `${protocol}://${host}/mcp/messages`;

  const transport = new SSEServerTransport(absoluteMessagesUrl, res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);
  console.log(`[SSE] Connected session ID: ${sessionId}`);

  // SSE Keep-Alive Ping every 25 seconds to prevent Cloud Run proxy disconnects
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

  await server.connect(transport);
});

app.post("/mcp/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);

  if (!transport) {
    console.warn(`[SSE] Message for non-existent session ID: ${sessionId}`);
    res.status(404).send("Session not found");
    return;
  }

  await transport.handlePostMessage(req, res);
});

// --- High-Performance Stateless JSON-RPC POST /mcp Dispatcher ---
// Used directly by Gemini Enterprise / Discovery Engine MCP Connector
app.post("/mcp", async (req, res) => {
  const { method, id, params } = req.body || {};

  if (!method) {
    res.status(400).json({
      jsonrpc: "2.0",
      id: id || null,
      error: { code: -32600, message: "Invalid Request: missing method" }
    });
    return;
  }

  console.log(`[JSON-RPC POST] Method: ${method}, ID: ${id}`);

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
            version: "1.1.0"
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

// --- Mock OAuth 2.0 Endpoints for Gemini Enterprise ---
app.get("/authorize", (req, res) => {
  console.log("[OAuth] Authorize query:", req.query);
  const redirectUri = req.query.redirect_uri as string;
  const state = req.query.state as string;

  if (!redirectUri) {
    res.status(400).send("Missing redirect_uri parameter");
    return;
  }

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", "mock_gecx_auth_code_12345");
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }

  res.redirect(redirectUrl.toString());
});

app.post("/token", (req, res) => {
  console.log("[OAuth] Token exchange request body:", req.body);
  res.status(200).json({
    access_token: "mock_gecx_access_token_67890",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "mock_gecx_refresh_token_54321",
    scope: req.body.scope || "mcp"
  });
});

// Health check endpoint
app.get("/", (req, res) => {
  res.status(200).json({
    status: "healthy",
    app: "retro-breakout-mcp-server",
    version: "1.1.0",
    cachedHtmlLength: CACHED_GAME_HTML.length,
    activeSessions: transports.size
  });
});

// Direct UI preview endpoint for browser verification
app.get("/game", (req, res) => {
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
  console.log(`🎮 Direct Game Preview: http://localhost:${port}/game`);
  console.log(`=============================================================`);
});
