import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create the MCP Server
const server = new Server(
  {
    name: "retro-breakout-server",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {},
      resources: {}
    }
  }
);

// Map to track active SSE transports
const transports = new Map<string, SSEServerTransport>();

// Helper to load the game HTML file (supporting src/ and dist/ paths)
function getGameHtml(): string {
  const pathsToTry = [
    path.join(__dirname, "game/index.html"),
    path.join(__dirname, "../src/game/index.html"),
    path.join(process.cwd(), "src/game/index.html"),
    path.join(process.cwd(), "dist/game/index.html")
  ];

  for (const p of pathsToTry) {
    if (fs.existsSync(p)) {
      console.log(`Loading Breakout Game HTML from: ${p}`);
      return fs.readFileSync(p, "utf-8");
    }
  }
  
  // Fallback inline basic game if file is missing (to prevent server crash)
  console.error("Warning: Breakout Game HTML file not found!");
  return `<!DOCTYPE html><html><body><h1>Error: Breakout game source not found!</h1></body></html>`;
}

// 1. Register resources (the Breakout UI)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "ui://breakout",
        name: "Retro Breakout Game",
        description: "An interactive, retro Atari-style Breakout game with color particle explosions and AI autopilot mode.",
        mimeType: "text/html;profile=mcp-app"
      }
    ]
  };
});

// Handler for reading resources (serving the HTML game content)
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  console.log(`[RESOURCE READ] GECX is reading resource: ${request.params.uri}`);
  if (request.params.uri === "ui://breakout") {
    const htmlContent = getGameHtml();
    console.log(`[RESOURCE READ] Successfully serving Retro Breakout Game HTML (length: ${htmlContent.length} characters)`);
    return {
      contents: [
        {
          uri: "ui://breakout",
          mimeType: "text/html;profile=mcp-app",
          text: htmlContent
        }
      ]
    };
  }
  console.warn(`[RESOURCE READ] Resource not found: ${request.params.uri}`);
  throw new Error(`Resource not found: ${request.params.uri}`);
});

// 2. Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "launch_breakout",
        description: "Launches the retro Atari Breakout game inside the conversation window. Use this when the user mentions playing breakout, starting a game, or wanting to see the interactive breakout app.",
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
              description: "The width of the paddle in pixels. Default is 120. Set to 200 or 250 to make it wider/easier."
            },
            ballSpeed: {
              type: "number",
              description: "The speed of the ball. Default is 5. Lower (e.g. 3) makes it slower/easier, higher (e.g. 8) makes it faster/harder."
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
              description: "The width of the paddle in pixels. Default is 120. Set to 200 or 250 to make it wider/easier."
            },
            paddleSize: {
              type: "number",
              description: "The width of the paddle in pixels. Default is 120. Set to 200 or 250 to make it wider/easier."
            },
            ballSpeed: {
              type: "number",
              description: "The speed of the ball. Default is 5. Lower (e.g. 3) makes it slower/easier, higher (e.g. 8) makes it faster/harder."
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
    ]
  };
});

// 3. Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  console.log(`[TOOL CALL] Received execution request for tool: ${name} with arguments:`, JSON.stringify(args || {}));

  if (name === "get_breakout_game" || name === "launch_game" || name === "launch_breakout") {
    console.log(`[TOOL CALL] Successfully triggered breakout launch! Returning ui://breakout resourceUri in _meta.ui for tool: ${name}`);
    return {
      content: [
        {
          type: "text",
          text: "I have initialized the Retro Breakout Game! The interactive Retro Atari Breakout canvas has been loaded directly into your chat window below. Prepare to slide the paddle and enjoy the color pixel explosions! Control the paddle using your Left and Right arrow keys or touch swipe, or ask me to turn on Autopilot or adjust settings for you."
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
    // Return standard defaults for the iframe to sync on startup
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            settings: {
              paddleSize: 120,
              ballSpeed: 5,
              lives: 3,
              autopilot: false,
              godMode: false
            }
          })
        }
      ]
    };
  }

  if (name === "update_game_settings" || name === "modify_breakout_settings") {
    // Process configuration updates and format the payload
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

    // We return JSON string in text, which iframe's ontoolresult will parse
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
      ]
    };
  }

  if (name === "trigger_game_cheat" || name === "apply_breakout_cheat") {
    let cheat = (args?.cheat || args?.cheatType) as string;

    // Map GECX camelCase cheat names to snake_case names
    if (cheat === "godMode") cheat = "god_mode";
    if (cheat === "extraBall") cheat = "extra_ball";
    if (cheat === "slowBall") cheat = "slow_ball";
    if (cheat === "laserPaddle") cheat = "laser_paddle";
    if (cheat === "levelBypass") cheat = "win_level";

    let desc = "";
    if (cheat === "god_mode") desc = "invincibility (God Mode) enabled! Bouncing on screen bottom activated.";
    if (cheat === "extra_ball") desc = "one extra life awarded!";
    if (cheat === "slow_ball") desc = "ball speed decreased for perfect tracking.";
    if (cheat === "laser_paddle") desc = "paddle widened to a super laser width!";
    if (cheat === "win_level") desc = "active level bypassed!";

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
      ]
    };
  }

  throw new Error(`Tool not found: ${name}`);
});

// 4. Server-Sent Events (SSE) Routes
app.get("/mcp", async (req, res) => {
  console.log("Establishing new MCP SSE transport connection...");
  
  // Set explicit headers to disable buffering on Cloud Run, then let SSEServerTransport handle the write head
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  
  // Build an absolute URL for the messages endpoint to ensure robust routing on GCP backend
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const absoluteMessagesUrl = `${protocol}://${host}/mcp/messages`;
  console.log(`Using absolute messages endpoint: ${absoluteMessagesUrl}`);

  // Create an SSEServerTransport pointing to the absolute messages endpoint
  const transport = new SSEServerTransport(absoluteMessagesUrl, res);
  const sessionId = transport.sessionId;
  
  transports.set(sessionId, transport);
  console.log(`Transport connected with Session ID: ${sessionId}`);

  transport.onclose = () => {
    console.log(`Transport connection closed for Session ID: ${sessionId}`);
    transports.delete(sessionId);
  };

  // Connect the server to the transport
  await server.connect(transport);
});

app.post("/mcp/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  
  if (!transport) {
    console.warn(`Attempted to send messages to non-existent Session ID: ${sessionId}`);
    res.status(404).send("Session not found");
    return;
  }

  console.log(`Received message for Session ID: ${sessionId}`);
  await transport.handlePostMessage(req, res);
});

// Stateless JSON-RPC fallback handler for GECX Custom Actions/Data Connector
app.post("/mcp", async (req, res) => {
  console.log("Received POST request on /mcp (stateless JSON-RPC):", JSON.stringify(req.body));
  
  const { method, id, params } = req.body || {};
  
  if (!method) {
    res.status(400).json({
      jsonrpc: "2.0",
      id: id || null,
      error: {
        code: -32600,
        message: "Invalid Request: missing method"
      }
    });
    return;
  }

  // Get the request handler from the server
  const handler = (server as any)._requestHandlers?.get(method);
  
  if (!handler) {
    console.warn(`No handler registered for method: ${method}`);
    res.status(200).json({
      jsonrpc: "2.0",
      id: id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      }
    });
    return;
  }

  try {
    const extra = {
      sessionId: "stateless-session",
      requestInfo: {
        headers: req.headers,
        url: new URL(req.url, `${req.protocol}://${req.get("host")}`)
      }
    };
    
    console.log(`Executing stateless handler for method: ${method}`);
    const result = await handler(req.body, extra);
    
    res.status(200).json({
      jsonrpc: "2.0",
      id: id,
      result: result
    });
  } catch (error: any) {
    console.error(`Error executing stateless handler for method ${method}:`, error);
    res.status(200).json({
      jsonrpc: "2.0",
      id: id,
      error: {
        code: error.code || -32603,
        message: error.message || "Internal error",
        data: error.data
      }
    });
  }
});

// 5. Mock OAuth 2.0 Endpoints for Gemini Enterprise
app.get("/authorize", (req, res) => {
  console.log("Received OAuth Authorize request:", req.query);
  const redirectUri = req.query.redirect_uri as string;
  const state = req.query.state as string;
  
  if (!redirectUri) {
    res.status(400).send("Missing redirect_uri parameter");
    return;
  }

  // Redirect back to GECX's redirect_uri with a mock auth code
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", "mock_gecx_auth_code_12345");
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }

  console.log(`Redirecting GECX back to: ${redirectUrl.toString()}`);
  res.redirect(redirectUrl.toString());
});

app.post("/token", (req, res) => {
  console.log("Received OAuth Token Exchange request:", req.body);
  
  // Return a standard compliant OAuth 2.0 token response
  res.status(200).json({
    access_token: "mock_gecx_access_token_67890",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "mock_gecx_refresh_token_54321",
    scope: req.body.scope || "mcp"
  });
});

// Simple root health check endpoint
app.get("/", (req, res) => {
  res.status(200).json({
    status: "healthy",
    app: "retro-breakout-mcp-server",
    activeSessions: transports.size
  });
});

// Start the Express server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`=============================================================`);
  console.log(`🚀 Retro Breakout MCP Server running on port ${port}`);
  console.log(`🔗 MCP SSE Endpoint: http://localhost:${port}/mcp`);
  console.log(`🔗 MCP Messages Endpoint: http://localhost:${port}/mcp/messages`);
  console.log(`=============================================================`);
});
