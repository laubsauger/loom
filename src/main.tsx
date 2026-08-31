import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;
// T705 follow-up: one line, so "which tree is this page running" is never a guess.
console.info(`shaderloom @ ${__BUILD_COMMIT__} (server started ${__BUILD_TIME__})`);

// T3 — self-hosted variable fonts (woff2, shipped by @fontsource-variable).
// Archivo is loaded from the width-axis build so pane headers can use the
// expanded-ish display cut; JetBrains Mono carries every numeric and WGSL glyph.
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/jetbrains-mono/wght.css";

import "./ui/tokens.css";
import "./ui/base.css";
import { App } from "./app/app.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
