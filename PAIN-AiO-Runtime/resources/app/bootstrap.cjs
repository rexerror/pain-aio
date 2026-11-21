"use strict";
const path = require("node:path");
const rootDir = path.resolve(__dirname, "..", "..", "..");
if (!module.paths.includes(path.join(rootDir, "node_modules"))) {
  module.paths.unshift(path.join(rootDir, "node_modules"));
}
require(path.join(rootDir, "electron", "main.cjs"));
