import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_DEFINITIONS,
  RESOURCE_DEFINITIONS,
  DOOM_RESOURCE_URI,
  executeToolCall
} from "./tools.js";

function parsePayload(result: any) {
  return JSON.parse(result.content[0].text);
}

test("resource definition advertises the Doom MCP App", () => {
  assert.equal(DOOM_RESOURCE_URI, "ui://doom");
  assert.equal(RESOURCE_DEFINITIONS.length, 1);
  assert.equal(RESOURCE_DEFINITIONS[0].uri, "ui://doom");
  assert.equal(RESOURCE_DEFINITIONS[0].mimeType, "text/html;profile=mcp-app");
});

test("every tool is bound to the Doom UI resource and has a schema", () => {
  const names = TOOL_DEFINITIONS.map((t: any) => t.name);
  assert.deepEqual(names, ["launch_doom", "start_new_game", "trigger_doom_cheat", "warp_to_level"]);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool._meta.ui.resourceUri, "ui://doom", `${tool.name} missing ui binding`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("launch_doom returns a UI resource and greets a named player", () => {
  const anon = executeToolCall("launch_doom", {});
  assert.equal(anon.isError, false);
  assert.equal(anon._meta.ui.resourceUri, "ui://doom");
  assert.match(anon.content[0].text, /DOOM/i);

  const named = executeToolCall("launch_doom", {}, "Ripley");
  assert.equal(named._meta.ui.resourceUri, "ui://doom?player=Ripley");
  assert.match(named.content[0].text, /Ripley/);
});

test("launch_game is accepted as an alias for launch_doom", () => {
  const r = executeToolCall("launch_game", {});
  assert.equal(r._meta.ui.resourceUri, "ui://doom");
});

test("start_new_game defaults to Hurt Me Plenty and resolves named skills", () => {
  const dflt = parsePayload(executeToolCall("start_new_game", {}));
  assert.equal(dflt.action, "new_game");
  assert.equal(dflt.skill, "hurt_me_plenty");
  assert.equal(dflt.skillIndex, 2);

  const nm = parsePayload(executeToolCall("start_new_game", { skill: "nightmare" }));
  assert.equal(nm.skillIndex, 4);
  assert.equal(nm.skill, "nightmare");
});

test("start_new_game rejects an unknown skill", () => {
  assert.throws(() => executeToolCall("start_new_game", { skill: "impossible" }), /Invalid skill/);
});

test("trigger_doom_cheat maps friendly names to real id-Software cheat codes", () => {
  const cases: Record<string, string> = {
    god_mode: "iddqd",
    all_weapons_and_keys: "idkfa",
    all_weapons: "idfa",
    no_clip: "idspispopd",
    chainsaw: "idchoppers",
    invulnerability: "idbeholdv",
    berserk: "idbeholds",
    partial_invisibility: "idbeholdi",
    radiation_suit: "idbeholdr",
    computer_map: "idbeholda",
    light_amp: "idbeholdl",
    show_position: "idmypos"
  };
  for (const [cheat, code] of Object.entries(cases)) {
    const p = parsePayload(executeToolCall("trigger_doom_cheat", { cheat }));
    assert.equal(p.status, "success");
    assert.equal(p.cheatApplied, cheat);
    assert.equal(p.code, code, `${cheat} should type ${code}`);
    assert.ok(p.message.length > 0);
  }
});

test("trigger_doom_cheat accepts the raw code as input too", () => {
  const p = parsePayload(executeToolCall("trigger_doom_cheat", { cheat: "iddqd" }));
  assert.equal(p.cheatApplied, "god_mode");
  assert.equal(p.code, "iddqd");
});

test("trigger_doom_cheat rejects unknown cheats", () => {
  assert.throws(() => executeToolCall("trigger_doom_cheat", { cheat: "idspawnbfg" }), /Invalid cheat/);
  assert.throws(() => executeToolCall("trigger_doom_cheat", {}), /Invalid cheat/);
});

test("warp_to_level clamps to the shareware episode and builds idclev", () => {
  const p = parsePayload(executeToolCall("warp_to_level", { map: 5 }));
  assert.equal(p.warpTo.episode, 1);
  assert.equal(p.warpTo.map, 5);
  assert.equal(p.code, "idclev15");

  const hi = parsePayload(executeToolCall("warp_to_level", { map: 42 }));
  assert.equal(hi.warpTo.map, 9);
  assert.equal(hi.code, "idclev19");

  const lo = parsePayload(executeToolCall("warp_to_level", { map: -3 }));
  assert.equal(lo.warpTo.map, 1);

  const str = parsePayload(executeToolCall("warp_to_level", { map: "3" }));
  assert.equal(str.warpTo.map, 3);
});

test("warp_to_level requires a numeric map", () => {
  assert.throws(() => executeToolCall("warp_to_level", {}), /map/);
  assert.throws(() => executeToolCall("warp_to_level", { map: "nine" }), /map/);
});

test("unknown tools throw", () => {
  assert.throws(() => executeToolCall("launch_breakout", {}), /Tool not found/);
});
