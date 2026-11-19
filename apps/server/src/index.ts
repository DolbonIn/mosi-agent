/** Entry point: `bun run apps/server/src/index.ts` (see package.json scripts). */
import { main } from "./main.ts";

export { createApp } from "./app.ts";
export { openDatabase } from "./db/index.ts";

if (import.meta.main) await main();
