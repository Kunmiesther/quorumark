// @vitest-environment node
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {expect,it} from "vitest";
it("enforces real database live mandate admission and atomic settings",()=>{
  expect(execFileSync(process.execPath,[resolve("scripts/test-live-mandate-settings.mjs"),resolve("node_modules/@electric-sql/pglite/dist/index.js")],{encoding:"utf8"})).toContain("PASS:");
},30000);
