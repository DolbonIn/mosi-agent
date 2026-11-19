// QA-only build: the app's vite config plus a stub for screen modules that other builders have not written yet
// (an unresolved relative import under src/screens/** becomes a module exporting placeholder components, so the
// foundation QA can build while screens are in progress). Output: dist-qa (never the real dist).
//   bunx vite build -c qa/vite.qa.config.mjs && QA_DIST=dist-qa node qa/foundation.spec.mjs
import fs from "node:fs";
import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config.ts";

const PREFIX = "\0qa-stub:";

function missingScreenStub() {
  return {
    name: "qa-missing-screen-stub",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || !source.startsWith(".") || !importer.includes("/src/screens/")) return null;
      const hit = await this.resolve(source, importer, { skipSelf: true });
      if (hit) return hit;
      let names = [];
      try {
        const code = fs.readFileSync(importer.split("?")[0], "utf8");
        const esc = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`import\\s*(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${esc}["']`, "g");
        for (const m of code.matchAll(re)) {
          for (const part of m[1].split(",")) {
            const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
            if (name) names.push(name);
          }
        }
      } catch {
        /* no names */
      }
      this.warn(`stubbed missing screen module ${source} (from ${importer.split("/src/")[1]})`);
      return PREFIX + JSON.stringify([...new Set(names)]);
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const names = JSON.parse(id.slice(PREFIX.length));
      const lines = ["const Placeholder = () => null;", "export default Placeholder;"];
      for (const n of names) lines.push(`export const ${n} = Placeholder;`);
      return lines.join("\n");
    },
  };
}

export default mergeConfig(base, defineConfig({ plugins: [missingScreenStub()], build: { outDir: "dist-qa", emptyOutDir: true } }));
