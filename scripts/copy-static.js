const { copyFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const src = join(__dirname, "..", "src", "renderer", "index.html");
const destDir = join(__dirname, "..", "dist", "renderer");
mkdirSync(destDir, { recursive: true });
copyFileSync(src, join(destDir, "index.html"));
