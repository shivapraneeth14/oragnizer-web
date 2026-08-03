import "ui/src/globals.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { assertEnvConfigured } from "./config"
import App from "./App"

assertEnvConfigured()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
