/**
 * DOOM MCP App — tool & resource definitions plus pure tool execution logic.
 *
 * Nothing in here touches the network. The server (index.ts) wires these into
 * both the SSE transport and the stateless JSON-RPC dispatcher; unit tests in
 * tools.test.ts exercise them directly.
 *
 * Every tool result carries `_meta.ui.resourceUri` so the MCP Apps host forwards
 * the result into the running game iframe, where the UI turns it into real
 * keystrokes on DOOM's input queue (the cheats are the genuine 1993 id codes).
 */

export const DOOM_RESOURCE_URI = "ui://doom";

const uiMeta = { ui: { resourceUri: DOOM_RESOURCE_URI } } as const;

/** DOOM skill levels in menu order (index = position in the "New Game" skill menu). */
export const SKILLS = [
  { key: "im_too_young_to_die", label: "I'm too young to die" },
  { key: "hey_not_too_rough", label: "Hey, not too rough" },
  { key: "hurt_me_plenty", label: "Hurt me plenty" },
  { key: "ultra_violence", label: "Ultra-Violence" },
  { key: "nightmare", label: "Nightmare!" }
] as const;

export type SkillKey = (typeof SKILLS)[number]["key"];

/** Friendly cheat name -> the exact key sequence DOOM's ST_Responder is listening for. */
export const CHEATS: Record<string, { code: string; message: string }> = {
  god_mode:             { code: "iddqd",      message: "Degreelessness mode ON. You are invulnerable." },
  all_weapons_and_keys: { code: "idkfa",      message: "Very Happy Ammo Added: all weapons, full ammo, all keys." },
  all_weapons:          { code: "idfa",       message: "Ammo (no keys) added: all weapons and full ammo." },
  no_clip:              { code: "idspispopd", message: "No clipping mode ON. Walk through walls." },
  chainsaw:             { code: "idchoppers", message: "... doesn't suck - GM. Chainsaw equipped." },
  invulnerability:      { code: "idbeholdv",  message: "Invulnerability sphere activated (30 seconds)." },
  berserk:              { code: "idbeholds",  message: "Berserk pack activated. Punch like a truck." },
  partial_invisibility: { code: "idbeholdi",  message: "Partial invisibility activated." },
  radiation_suit:       { code: "idbeholdr",  message: "Radiation shielding suit activated." },
  computer_map:         { code: "idbeholda",  message: "Computer area map revealed. Press TAB for the automap." },
  light_amp:            { code: "idbeholdl",  message: "Light amplification visor activated." },
  show_position:        { code: "idmypos",    message: "Player coordinates shown in the HUD." }
};

const CHEAT_KEYS = Object.keys(CHEATS);

/** Shareware DOOM ships Episode 1 only: E1M1..E1M9 (M9 is the secret level). */
export const SHAREWARE_EPISODE = 1;
export const MIN_MAP = 1;
export const MAX_MAP = 9;

export const TOOL_DEFINITIONS = [
  {
    name: "launch_doom",
    description:
      "Launches DOOM (1993, shareware Episode 1: Knee-Deep in the Dead) inside the Gemini Enterprise conversation window. Use this when the user wants to play DOOM, asks 'can it run DOOM?', or wants to see the interactive game.",
    inputSchema: { type: "object", properties: {}, required: [] },
    _meta: uiMeta
  },
  {
    name: "start_new_game",
    description:
      "Starts a fresh game of DOOM on E1M1 at the requested skill level. Works from the title screen or mid-game (the current game is abandoned).",
    inputSchema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          enum: SKILLS.map(s => s.key),
          description:
            "Difficulty. 'im_too_young_to_die' (easiest), 'hey_not_too_rough', 'hurt_me_plenty' (default), 'ultra_violence', 'nightmare' (monsters respawn, cheats still work in this build)."
        }
      },
      required: []
    },
    _meta: uiMeta
  },
  {
    name: "trigger_doom_cheat",
    description:
      "Types a genuine id Software cheat code into the running game. Only works once a level is loaded; if the player is still on the title screen the UI starts a game first.",
    inputSchema: {
      type: "object",
      properties: {
        cheat: {
          type: "string",
          enum: CHEAT_KEYS,
          description:
            "'god_mode' (iddqd), 'all_weapons_and_keys' (idkfa), 'all_weapons' (idfa), 'no_clip' (idspispopd), 'chainsaw' (idchoppers), 'invulnerability', 'berserk', 'partial_invisibility', 'radiation_suit', 'computer_map', 'light_amp' (the idbehold powerups), 'show_position' (idmypos)."
        }
      },
      required: ["cheat"]
    },
    _meta: uiMeta
  },
  {
    name: "warp_to_level",
    description:
      "Warps the player to a level in Episode 1 using the idclev cheat. Shareware includes maps 1-9 (E1M9 is the secret level, Military Base).",
    inputSchema: {
      type: "object",
      properties: {
        map: {
          type: "number",
          description: "Map number within Episode 1, from 1 (Hangar) to 9 (Military Base). Clamped to that range."
        }
      },
      required: ["map"]
    },
    _meta: uiMeta
  }
];

export const RESOURCE_DEFINITIONS = [
  {
    uri: DOOM_RESOURCE_URI,
    name: "DOOM",
    description:
      "The original 1993 DOOM (linuxdoom-1.10 compiled to WebAssembly, shareware Episode 1) rendered on an HTML5 canvas. The resource is a small shell that nests the game page from the DOOM MCP server (declared via _meta.ui.csp.frameDomains), because MCP App sandboxes do not permit WebAssembly compilation.",
    mimeType: "text/html;profile=mcp-app"
  }
];

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
  _meta: { ui: { resourceUri: string } };
}

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
    _meta: { ui: { resourceUri: DOOM_RESOURCE_URI } }
  };
}

/** Resolve a skill argument (key, label fragment, or 0-4 index) to a SKILLS entry. */
export function resolveSkill(input: unknown): { key: SkillKey; label: string; index: number } {
  if (input === undefined || input === null || input === "") {
    return { ...SKILLS[2], index: 2 };
  }
  if (typeof input === "number" && Number.isInteger(input) && input >= 0 && input < SKILLS.length) {
    return { ...SKILLS[input], index: input };
  }
  const norm = String(input).toLowerCase().replace(/[^a-z]/g, "");
  const idx = SKILLS.findIndex(
    s => s.key.replace(/_/g, "") === norm || s.label.toLowerCase().replace(/[^a-z]/g, "") === norm
  );
  if (idx === -1) {
    throw new Error(`Invalid skill: '${input}'. Allowed skills: ${SKILLS.map(s => s.key).join(", ")}`);
  }
  return { ...SKILLS[idx], index: idx };
}

/** Resolve a cheat argument (friendly key or raw id code) to its CHEATS entry. */
export function resolveCheat(input: unknown): { key: string; code: string; message: string } {
  const raw = String(input ?? "").trim().toLowerCase();
  if (raw && CHEATS[raw]) return { key: raw, ...CHEATS[raw] };
  const byCode = CHEAT_KEYS.find(k => CHEATS[k].code === raw);
  if (byCode) return { key: byCode, ...CHEATS[byCode] };
  throw new Error(`Invalid cheat code: '${input}'. Allowed cheats: ${CHEAT_KEYS.join(", ")}`);
}

export function executeToolCall(name: string, args: any, sessionPlayerName?: string): ToolResult {
  const playerName = sessionPlayerName || args?.playerName || "Player 1";
  console.log(`[TOOL CALL] Executing tool: ${name} for player: ${playerName}`);

  if (name === "launch_doom" || name === "launch_game") {
    const named = playerName && playerName !== "Player 1";
    const greeting = named ? `Welcome ${playerName}! ` : "";
    return {
      content: [
        {
          type: "text",
          text:
            `${greeting}DOOM is loading directly in your chat window below (the real 1993 engine, running as WebAssembly). ` +
            `Click the screen to start a new game on E1M1. Arrow keys move, Ctrl fires, Space opens doors, Alt strafes, Tab is the automap. ` +
            `Ask me for god mode, all weapons, no-clip, or to warp to another level and I will type the cheat for you.`
        }
      ],
      isError: false,
      _meta: {
        ui: {
          resourceUri: named ? `${DOOM_RESOURCE_URI}?player=${encodeURIComponent(playerName)}` : DOOM_RESOURCE_URI
        }
      }
    };
  }

  if (name === "start_new_game") {
    const skill = resolveSkill(args?.skill);
    return jsonResult({
      status: "success",
      action: "new_game",
      skill: skill.key,
      skillIndex: skill.index,
      message: `Starting a new game on E1M1: Hangar at skill '${skill.label}'.`
    });
  }

  if (name === "trigger_doom_cheat") {
    const cheat = resolveCheat(args?.cheat ?? args?.cheatType ?? args?.code);
    return jsonResult({
      status: "success",
      cheatApplied: cheat.key,
      code: cheat.code,
      message: `Cheat code ${cheat.code.toUpperCase()} typed: ${cheat.message}`
    });
  }

  if (name === "warp_to_level") {
    const parsed = Number(args?.map ?? args?.level);
    if (args?.map === undefined && args?.level === undefined || Number.isNaN(parsed)) {
      throw new Error(`Invalid or missing 'map': expected a number between ${MIN_MAP} and ${MAX_MAP}`);
    }
    const map = Math.max(MIN_MAP, Math.min(MAX_MAP, Math.round(parsed)));
    const code = `idclev${SHAREWARE_EPISODE}${map}`;
    return jsonResult({
      status: "success",
      warpTo: { episode: SHAREWARE_EPISODE, map },
      code,
      message: `Warping to E${SHAREWARE_EPISODE}M${map} via ${code.toUpperCase()}.`
    });
  }

  throw new Error(`Tool not found: ${name}`);
}
