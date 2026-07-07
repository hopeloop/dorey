import path from "node:path";

import { writeDemoTaskArtifacts } from "../src/demo/demo-task.js";

const outputDir = path.join(process.cwd(), "generated/demo-task");
const result = writeDemoTaskArtifacts(outputDir);

console.log(`Generated ${result.artifacts.length} workflow artifacts.`);
console.log(`Output: ${outputDir}`);
