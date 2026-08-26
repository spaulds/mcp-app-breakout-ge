# Retro Breakout - MCP App for Gemini Enterprise

An interactive, retro Atari-style Breakout game built as a **Model Context Protocol (MCP) App** (UI Extension) and designed to run seamlessly inside the **Gemini Enterprise Agent Platform (GEAP)**.

When a user in Gemini Enterprise prompts something like:
> *"Let's play a game"* or *"Launch Breakout"*

Gemini calls the MCP server's `launch_breakout` tool. The tool response references an interactive UI resource (`ui://breakout`), prompting Gemini Enterprise to render the interactive HTML5 canvas game directly inside the conversation thread. The user and the agent can then interact with the game in real-time, tweak gameplay physics (paddle width, ball speed, lives), or enable cheat codes via natural language.

This project follows the [Model Context Protocol Apps Specification](https://github.com/modelcontextprotocol/ext-apps) (referencing examples such as the [budget-allocator-server](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/budget-allocator-server)).

---

## 🕹️ Architecture & Features

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Gemini Enterprise (Chat UI)                     │
│                                                                        │
│   User: "Let's play Breakout, and make the paddle wider!"              │
│   Gemini: "Launching Breakout with a wider paddle..."                  │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │  🎮 [Embedded Iframe: ui://breakout]                           │   │
│   │  Retro Breakout Canvas • CRT Scanline Filters • Particle FX    │   │
│   │  Connected via @modelcontextprotocol/ext-apps                  │   │
│   └────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ MCP Protocol (SSE / JSON-RPC)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     MCP Server (Express / TypeScript)                  │
│                                                                        │
│   • Resources:                                                         │
│     - ui://breakout (text/html;profile=mcp-app)                        │
│                                                                        │
│   • Tools:                                                             │
│     - launch_breakout: Renders the breakout UI iframe                  │
│     - update_game_settings: Adjusts paddle width, ball speed, lives    │
│     - trigger_game_cheat: God mode, laser paddle, slow ball            │
│     - get_game_config: Syncs game configuration                        │
│                                                                        │
│   • Transports & Auth:                                                 │
│     - SSE (/mcp & /mcp/messages) + Stateless JSON-RPC POST /mcp       │
│     - Mock OAuth 2.0 endpoints (/authorize & /token) for GEAP          │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Features
- **Embedded In-Chat Rendering**: Serves a standalone HTML5/Canvas arcade game (`ui://breakout`) with retro styling, CRT scanline effects, audio-visual feedback, and particle bursts.
- **MCP Ext-Apps SDK Bridge**: The web client uses `@modelcontextprotocol/ext-apps` to communicate bidirectionally with the MCP host.
- **Real-Time Gameplay Adjustments via LLM**:
  - *"Make the ball slower"*
  - *"Turn on AI Autopilot"*
  - *"Give me 10 lives"*
  - *"Activate God Mode"*
- **Dual Transport Support**:
  - **Server-Sent Events (SSE)**: Full stateful streaming over `/mcp` and `/mcp/messages`.
  - **Stateless JSON-RPC POST**: Direct compatibility with Cloud Connectors and webhook environments.
- **Gemini Enterprise Ready**: Includes mock OAuth 2.0 endpoints (`/authorize`, `/token`) to satisfy Gemini Enterprise Agent Platform connector setup requirements out-of-the-box.

---

## 🛠️ MCP Tools & Resources

### Resources
- `ui://breakout` (`mimeType: text/html;profile=mcp-app`): Serves the complete Breakout game application bundle (HTML, CSS, JavaScript).

### Tools
| Tool Name | Description |
| :--- | :--- |
| `launch_breakout` | Launches the Breakout game by returning a reference to `ui://breakout` in `_meta.ui`. |
| `update_game_settings` | Live-adjusts game parameters (`paddleSize`, `ballSpeed`, `lives`, `autopilot`, `godMode`). |
| `modify_breakout_settings` | Alias tool with flexible property aliases (`paddleWidth`, `paddleSize`). |
| `trigger_game_cheat` | Applies cheat codes (`god_mode`, `extra_ball`, `slow_ball`, `laser_paddle`, `win_level`). |
| `apply_breakout_cheat` | Alias for triggering cheat modes with camelCase/snake_case support. |
| `get_game_config` | Syncs initial and current game configuration for the UI client. |
| `get_breakout_settings` | Returns active game session state and physics parameters. |

---

## 🚀 Getting Started

### Prerequisites
- Node.js 20+
- npm or yarn

### Installation
```bash
# Clone the repository
git clone git@github.com:spaulds/mcp-app-breakout-ge.git
cd mcp-app-breakout-ge

# Install dependencies
npm install
```

### Local Development
```bash
# Run in development mode with nodemon & ts-node
npm run dev
```
The server will start on `http://localhost:8080`.

### Production Build & Run
```bash
# Compile TypeScript and copy game assets
npm run build

# Start the compiled server
npm start
```

---

## 🐳 Running with Docker

You can containerize and run the server locally or in any container platform:

```bash
# Build the Docker image
docker build -t mcp-app-breakout-ge .

# Run the container
docker run -p 8080:8080 mcp-app-breakout-ge
```

---

## ☁️ Deploying to Google Cloud Run

To connect the app to the Gemini Enterprise Agent Platform, deploy it as a publicly accessible service on Google Cloud Run:

```bash
gcloud run deploy mcp-app-breakout-ge \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080
```

Once deployed, Cloud Run will provide a service URL (e.g., `https://mcp-app-breakout-ge-xyz-uc.a.run.app`).

---

## ⚙️ Connecting to Gemini Enterprise Agent Platform (GEAP)

1. Open your **Gemini Enterprise / Agent Platform Console**.
2. Navigate to **Data Connectors / Extensions / MCP Agents** and choose **Register Custom MCP Server**.
3. Fill in the connection settings:
   - **MCP Server URL**: `https://<YOUR_CLOUD_RUN_URL>/mcp`
   - **Authentication Type**: OAuth 2.0 (or None if unauthenticated)
   - **Authorization Endpoint**: `https://<YOUR_CLOUD_RUN_URL>/authorize`
   - **Token Endpoint**: `https://<YOUR_CLOUD_RUN_URL>/token`
   - **Client ID / Secret**: Any placeholder value (handled by the mock OAuth service)
4. Upload or verify the tool definitions using [`toolspec.json`](file:///Users/aspaulding/code/google/mcp-app-breakout-ge/toolspec.json).
5. Save and activate the connector.
6. In your Gemini Enterprise chat session, prompt:
   > *"Let's play a game of Breakout!"*

---

## 📂 Project Structure

```
mcp-app-breakout-ge/
├── Dockerfile              # Multi-stage production container build
├── package.json            # Node.js project manifest & scripts
├── toolspec.json           # MCP tool declarations and input schemas
├── tsconfig.json           # TypeScript configuration
├── .gitignore              # Git ignored files (node_modules, dist, etc.)
└── src/
    ├── index.ts            # MCP Server, SSE/RPC routes, OAuth mock endpoints
    └── game/
        └── index.html      # Self-contained Breakout UI with MCP App bridge
```

---

## 📄 License

Apache 2.0
