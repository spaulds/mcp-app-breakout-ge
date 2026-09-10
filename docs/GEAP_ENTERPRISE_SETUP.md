# 🛡️ Gemini Enterprise Agent Platform (GEAP) — Enterprise Setup Guide

This guide provides step-by-step instructions for deploying, securing, registering, and connecting the **Retro Breakout MCP App** within the **Gemini Enterprise Agent Platform (GEAP)** ecosystem on Google Cloud.

---

## 🧭 Why GEAP? Architecture & Differentiation

In traditional AI tool architectures, agents invoke external APIs via hardcoded URLs, static API keys, and uninspected webhooks. This introduces severe enterprise risks:
* **Tool Sprawl & Blind Egress:** No centralized visibility into which tools agents can access.
* **Credential Leaks:** Static API keys and secrets hardcoded into agent configurations.
* **Prompt Injection & Parameter Tampering:** Malicious user inputs directly triggering uninspected backend executions.
* **CDN & XSS Vulnerabilities:** Web UIs loaded from external CDNs that can be hijacked or blocked by strict enterprise Content Security Policies (CSP).

```mermaid
sequenceDiagram
    autonumber
    actor User as 👤 Enterprise User
    participant GE as 🧠 Gemini Enterprise Agent<br/>(SPIFFE Agent Identity)
    participant AGW as 🛡️ Agent Gateway<br/>(AuthzPolicy + Model Armor)
    participant REG as 📚 MCP Registry<br/>(Central Tool Catalog)
    participant CR as 🔒 Private Cloud Run<br/>(Zero-Trust Ingress)

    Note over GE,REG: 1. Dynamic Tool Discovery
    GE->>REG: Discover MCP Tools & UI Spec via Gateway
    REG-->>GE: Tool definitions + UI resource (ui://breakout)

    Note over User,GE: 2. Interactive Request
    User->>GE: "Let's play Atari Breakout!"

    Note over GE,AGW: 3. Governed Zero-Trust Egress
    GE->>AGW: mTLS (SPIFFE Identity: principal://agents...)
    Note over AGW: • Validates Agent Identity<br/>• Enforces AuthzPolicy<br/>• Model Armor sanitizes payloads
    AGW->>CR: Authenticated POST /mcp (launch_breakout)
    CR-->>AGW: Result (_meta.ui.resourceUri: "ui://breakout")
    AGW-->>GE: Forwarded MCP Response

    Note over GE,CR: 4. Authenticated Zero-CDN UI Delivery
    GE->>AGW: resources/read ("ui://breakout")
    AGW->>CR: Authenticated POST /mcp (resources/read)
    CR-->>AGW: Streamed HTML5 Canvas Game Bundle
    AGW-->>GE: App Payload Delivered
    GE->>User: Renders Interactive Canvas in Chat!
```

### The 4 Pillars of GEAP Governance

1. **Central Tool Catalog (MCP Registry):** Single pane of glass for all enterprise MCP servers, OpenAPI tools, and UI extensions.
2. **Cryptographic Zero-Trust Ingress (Private Cloud Run):** Workloads are completely private (`--no-allow-unauthenticated`), strictly accepting Google OIDC tokens from authorized Service Agents.
3. **Egress Governance & Inspection (Agent Gateway + Model Armor):** Evaluates SPIFFE agent identities over mTLS and sanitizes payloads in-flight before tools execute.
4. **Zero-CDN Secure UI Delivery (MCP Apps Protocol):** Delivers full interactive HTML5/JS applications directly through the authenticated MCP channel (`resources/read`), running inside sandboxed iframes with origin-locked postMessage bridges.

---

## ⚠️ Architecture Considerations: Governed Gateway vs. Direct Connection

> [!NOTE]
> * **Governed Agent Gateway Mode (Target Architecture for GEAP):** When routing through the **Agent Gateway** and discovering tools via the **MCP Registry**, all three components (Registry, Gateway, and Gemini Enterprise Data Store) must reside in the **same Google Cloud region** (e.g. `us-central1`) for private mTLS routing and catalog auto-discovery. This delivers the full suite of enterprise controls: SPIFFE agent identity verification, fine-grained `AuthzPolicy`, and in-flight payload sanitization via Model Armor.
> * **Direct Custom MCP Mode (Standalone / Simplified Path):** Connects directly from any region (including `global` Gemini Enterprise applications) to your Cloud Run deployment over authenticated HTTPS with OAuth 2.0 PKCE. Useful for rapid standalone testing without an active Gateway perimeter.

---

## 📋 Prerequisites & Environment Variables

Define your project variables:

```bash
export PROJECT_ID="<YOUR_PROJECT_ID>"
export REGION="us-central1"
export SERVICE_NAME="mcp-breakout-arcade"
export GATEWAY_NAME="<YOUR_AGENT_GATEWAY_NAME>"   # e.g. "my-agent-gateway"
export SERVICE_ID="retro-breakout-service"

# Retrieve numeric project ID
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
```

### Enable Required Google Cloud APIs
```bash
gcloud services enable \
  run.googleapis.com \
  discoveryengine.googleapis.com \
  agentregistry.googleapis.com \
  networkservices.googleapis.com \
  iam.googleapis.com \
  --project=$PROJECT_ID
```

---

## 🛠️ Step 1: Deploy Private Cloud Run Workload

Deploy the MCP server with public internet access disabled (`--no-allow-unauthenticated`):

```bash
gcloud run deploy $SERVICE_NAME \
  --source . \
  --platform managed \
  --region $REGION \
  --project $PROJECT_ID \
  --no-allow-unauthenticated \
  --port 8080
```

Capture the deployed private service URL:
```bash
export CLOUD_RUN_URL=$(gcloud run services describe $SERVICE_NAME \
  --platform managed \
  --region $REGION \
  --project $PROJECT_ID \
  --format='value(status.url)')
echo "Private Cloud Run URL: $CLOUD_RUN_URL"
```

---

## 🔐 Step 2: Configure Service Agent IAM Roles

Grant `roles/run.invoker` to the Google Cloud Service Agents that facilitate Discovery Engine and Agent Gateway routing:

```bash
# 1. Discovery Engine Service Agent (always present when Discovery Engine is enabled)
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-discoveryengine.iam.gserviceaccount.com" \
  --role="roles/run.invoker" \
  --region=$REGION \
  --project=$PROJECT_ID

# 2. Agent Gateway Service Agent (if Agent Gateway is enabled in your project)
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-agentgateway.iam.gserviceaccount.com" \
  --role="roles/run.invoker" \
  --region=$REGION \
  --project=$PROJECT_ID || echo "Agent Gateway service agent not created yet; grant when gateway is initialized."

# 3. Service Extensions Data Plane Agent (if cross-project DEP is used)
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-dep.iam.gserviceaccount.com" \
  --role="roles/run.invoker" \
  --region=$REGION \
  --project=$PROJECT_ID || true
```

---

## 📚 Step 3: Grant MCP Registry & Gateway Permissions

Create a custom IAM role to allow Discovery Engine to browse the MCP Registry catalog and route through your Agent Gateway:

```bash
gcloud iam roles create geAgentRegistryViewer \
  --project=$PROJECT_ID \
  --title="Gemini Enterprise Agent Registry Viewer" \
  --description="Allows Discovery Engine to discover services in MCP Registry and use Agent Gateways" \
  --permissions="agentregistry.agents.list,agentregistry.agents.get,agentregistry.agents.search,agentregistry.mcpServers.list,agentregistry.mcpServers.get,agentregistry.mcpServers.search,networkservices.agentGateways.list,networkservices.agentGateways.get,networkservices.agentGateways.use"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-discoveryengine.iam.gserviceaccount.com" \
  --role="projects/${PROJECT_ID}/roles/geAgentRegistryViewer"
```

---

## 📑 Step 4: Register the App in MCP Registry

In the Google Cloud Console, the catalog is called **MCP Registry** (located under **Agent Builder &rarr; MCP Registry**). 

You can publish your tool specification (`toolspec.json`) via CLI:

```bash
SPEC_CONTENT=$(cat toolspec.json)

gcloud agent-registry services create $SERVICE_ID \
  --project=$PROJECT_ID \
  --location=$REGION \
  --display-name="Breakout MCP" \
  --description="Interactive MCP Apps Breakout arcade game with inline HTML/canvas UI rendering, live gameplay parameter controls, and cheat code integrations for Gemini Enterprise." \
  --interfaces="[{\"protocolBinding\": \"JSONRPC\", \"url\": \"${CLOUD_RUN_URL}/mcp\"}]" \
  --mcp-server-spec-type=tool-spec \
  --mcp-server-spec-content="$SPEC_CONTENT"
```

*(Note: If updating an existing registration, use `gcloud agent-registry services update` instead).*

---

## 🛡️ Step 5: Create & Configure a New Agent Gateway

Create a dedicated **Agent Gateway** to govern and audit all tool invocations made by Gemini Enterprise:

### 1. Create the Agent Gateway in the same region
```bash
gcloud network-services agent-gateways create $GATEWAY_NAME \
  --location=$REGION \
  --project=$PROJECT_ID
```

### 2. Configure Authorization Policy (`AuthzPolicy`)
Ensure the Gateway allows incoming requests originating from the Gemini Enterprise Agent SPIFFE identity:
* **Principal:** `principal://agents.global.discoveryengine.googleapis.com/...`
* **Action:** `ALLOW`
* **Protocol:** `tools/call`, `tools/list`, `resources/read`, `resources/list`

### 3. Attach Model Armor Inspection Template
Enable payload sanitization on the Gateway to inspect and validate all tool parameters before forwarding to Cloud Run.

---

## 🖥️ Step 6: Connect to Gemini Enterprise

Select the connection option matching your architecture:

### Option A: Governed Egress via Agent Gateway & MCP Registry (Target Enterprise Architecture)

For production enterprise deployments requiring centralized perimeter policy enforcement (`AuthzPolicy`), cryptographic SPIFFE agent identity verification over mTLS, and in-flight payload sanitization via Model Armor:

1. Ensure Steps 3, 4, and 5 above were completed in the same region (`$REGION`).
2. Open **Google Cloud Console** &rarr; **Agent Builder (Discovery Engine)** &rarr; **Data Stores** &rarr; **Create Data Store**.
3. Select **Agent Gateway / MCP Registry**:
   - The registered **`Breakout MCP`** service will automatically appear in the catalog list.
4. Configure OAuth 2.0 authentication (`${CLOUD_RUN_URL}/authorize` & `${CLOUD_RUN_URL}/token`) with PKCE `S256`.
5. Verify authentication and attach the Data Store to your Agent.
6. Navigate to your **Gemini Enterprise Agent** &rarr; **Actions / Tools** tab:
   - Verify all MCP tools (`launch_breakout`, `update_game_settings`, `trigger_game_cheat`, etc.) and the `ui://breakout` resource are recognized.
7. Save and publish the Agent configuration.

---

### Option B: Direct Custom MCP Data Store (Standalone / Simplified Path)

For rapid prototyping, local development, or standalone demonstrations evaluating MCP Apps prior to configuring an enterprise gateway perimeter:

1. Open **Google Cloud Console** &rarr; **Agent Builder (Discovery Engine)** &rarr; **Data Stores**.
2. Click **Create Data Store**.
3. Select **Custom MCP** (or **Model Context Protocol**).
4. Configure the connection parameters:
   - **Data Store ID:** `breakout-mcp-direct`
   - **Display Name:** `Retro Breakout MCP`
   - **MCP Server URL:** `${CLOUD_RUN_URL}/mcp`
   - **Authentication Method:** `OAuth 2.0`
   - **Authorization URL:** `${CLOUD_RUN_URL}/authorize`
   - **Token URL:** `${CLOUD_RUN_URL}/token`
   - **Client ID:** `gemini-enterprise-agent`
   - **Client Secret:** `secret123` (or any placeholder string)
   - **PKCE Support:** ☑️ **Enabled (`S256`)**
5. Click **Verify Auth**:
   - A consent popup window appears requesting access to the Breakout arcade service.
   - Click **Authorize Access**.
6. Click **Create & Connect**.
7. Navigate to your **Gemini Enterprise Agent** &rarr; **Actions / Tools** tab:
   - Click **Add Action** and attach your new `breakout-mcp-direct` data store.
   - Verify all MCP tools (`launch_breakout`, `update_game_settings`, `trigger_game_cheat`, etc.) are recognized.
8. Save and publish the Agent configuration.

> [!TIP]
> **Enterprise Production vs Rapid Standalone Testing:**
> - **Option A (Agent Gateway + MCP Registry):** Target architecture for enterprise production environments requiring full zero-trust governance, SPIFFE identity attestation, `AuthzPolicy` enforcement, and Model Armor payload sanitization.
> - **Option B (Direct Custom MCP):** Lightweight developer option connecting directly over HTTPS, ideal for isolated testing, POCs, or initial integration verification before enabling perimeter policies.

---

## 🎮 Step 7: Test & Verify the Interactive Experience

1. Open the **Gemini Enterprise Chat** interface.
2. Type:
   > *"Let's play a game"* or *"Launch Breakout"*
3. **Observe the Handshake:**
   - Gemini Enterprise calls `launch_breakout`.
   - The tool returns `{ _meta: { ui: { resourceUri: "ui://breakout" } } }`.
   - Gemini Enterprise fetches `resources/read: ui://breakout` over the Agent Gateway.
   - The sandboxed iframe mounts, performs the 3-way `postMessage` handshake, and renders the retro arcade game directly inside the conversation thread.
4. **Test Live Gameplay Control via Chat:**
   - *"Equip laser cannons"* &rarr; Agent invokes `trigger_game_cheat(cheat="laser_paddle")`. Twin laser turrets appear on the paddle.
   - *"Make the paddle wider and slow down the ball"* &rarr; Agent invokes `update_game_settings(paddleSize=220, ballSpeed=3.5)`.

---

## 🔍 Troubleshooting & Observability

### Inspect Invocations via Cloud Logging
```bash
# Cloud Run Execution Logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE_NAME}" \
  --limit=20 \
  --format="table(timestamp, textPayload)" \
  --project=$PROJECT_ID

# Agent Gateway Ingress & Audit Logs
gcloud logging read "resource.type=network_services_gateway AND log_name:agent_gateway" \
  --limit=20 \
  --project=$PROJECT_ID
```

### Common Issues & Solutions
| Issue | Root Cause | Resolution |
| :--- | :--- | :--- |
| **MCP App not appearing in Console picker** | Regional mismatch between MCP Registry, Gateway, and Agent Builder. | Verify all three are deployed in the **exact same region** (e.g. `us-central1`). |
| **`403 Forbidden` on `/mcp`** | Missing `roles/run.invoker` on Cloud Run. | Run Step 2 to re-bind Discovery Engine & Agent Gateway Service Accounts. |
| **`401 Unauthorized` on OAuth** | PKCE verifier mismatch or expired authorization code. | Ensure `PKCE S256` is enabled in Data Store configuration. Codes expire in 5 minutes. |
| **Tool listed but UI doesn't render** | Missing `_meta.ui.resourceUri` in tool spec. | Re-sync `toolspec.json` in MCP Registry (Step 4). |
| **Iframe postMessage Warning** | Origin spoofing or unverified parent domain. | Ensure parent origin matches your enterprise domain. The bridge locks origin on first handshake. |

---

## 📄 References & Related Documentation
* [Model Context Protocol (MCP) Specification](https://modelcontextprotocol.io/)
* [MCP Apps Specification (Ext-Apps)](https://github.com/modelcontextprotocol/ext-apps)
* [Google Cloud MCP Registry Documentation](https://cloud.google.com/gemini/docs/enterprise)
* [Google Cloud Agent Gateway Documentation](https://cloud.google.com/network-services/docs)
