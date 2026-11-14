const { copyFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const srcDir = join(__dirname, "..", "src", "renderer");
const destDir = join(__dirname, "..", "dist", "renderer");
mkdirSync(destDir, { recursive: true });
for (const file of ["index.html", "styles.css"]) copyFileSync(join(srcDir, file), join(destDir, file));
