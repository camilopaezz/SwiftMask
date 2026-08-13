import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import { applyTheme, readStoredTheme } from "./lib/theme";
import { settingsStore } from "./stores/settingsStore";

// Apply the persisted theme before React renders so the first paint matches
// the user's override (no light→dark flash on a dark-system/light-override).
const stored = readStoredTheme();
if (stored) settingsStore.setState({ theme: stored });
applyTheme(settingsStore.getState().theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
