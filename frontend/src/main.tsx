import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/500.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/public-sans/700.css";
import "@fontsource/source-serif-4/500.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import { StepUpProvider } from "./components/auth/StepUp";
import { ToastProvider } from "./components/ui/Toast";
import "./index.css";
import { SessionProvider } from "./lib/session";
import { ThemeProvider } from "./lib/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <SessionProvider>
        <ToastProvider>
          <StepUpProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </StepUpProvider>
        </ToastProvider>
      </SessionProvider>
    </ThemeProvider>
  </StrictMode>,
);
