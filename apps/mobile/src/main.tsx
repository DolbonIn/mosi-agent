import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initTier } from "./motion/tier";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/glass.css";
import { App } from "./App";

// resolve theme / motion / transparency / contrast onto <html> before the first paint
initTier();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
