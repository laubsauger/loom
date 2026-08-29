import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// Shell replaced by track A (T4).
createRoot(root).render(
  <StrictMode>
    <div>shaderloom</div>
  </StrictMode>,
);
