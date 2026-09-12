import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("../web/h3_media_board.js", import.meta.url), "utf8");
const specs = source.match(/const H3MB_VARIABLE_SPECS = Object.freeze\([\s\S]*?\n\}\);/)[0];
const compatible = source.match(/function h3mbTypesCompatible\(sourceType, targetType\) \{[\s\S]*?\n\}/)[0];
const ctx = vm.createContext({});
vm.runInContext(`${specs}\n${compatible}\nglobalThis.specs = H3MB_VARIABLE_SPECS;`, ctx);
for (const name of ["H3mb_重叠帧数", "H3_ConLength"]) {
  assert.equal(ctx.specs[name].type, "COMBO");
  assert.equal(ctx.specs[name].slot, 9);
  assert.equal(ctx.h3mbTypesCompatible(ctx.specs[name].type, "COMBO"), true);
  assert.equal(ctx.h3mbTypesCompatible(ctx.specs[name].type, ["22", "5", "39", "56"]), true);
  assert.equal(ctx.h3mbTypesCompatible(ctx.specs[name].type, "INT"), false);
}
assert.equal(ctx.specs.H3mb_裁剪帧数.type, "INT");
assert.equal(ctx.h3mbTypesCompatible("INT", "COMBO"), false);
console.log("PASS: overlap connects to combo sockets; trim retains integer socket");
