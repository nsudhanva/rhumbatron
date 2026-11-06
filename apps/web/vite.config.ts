import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defaultServerConditions, defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [tailwindcss(), tanstackStart(), react()],
  ssr: {
    // The build is one self-contained server bundle: the runtime image needs no node_modules.
    // The dev server loads dependencies from node_modules.
    ...(command === "build" ? { noExternal: true } : {}),
    // The server runs on Bun (serve.ts, `bun --bun vite dev`): resolve each package's Bun build first.
    resolve: { conditions: ["bun", ...defaultServerConditions] },
  },
}));
