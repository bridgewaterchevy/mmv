import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installErrorLog } from "./lib/errorlog";

// Capture window errors / rejections / failed API calls from the very first tick so "Report a problem" has context.
installErrorLog();

if (!window.location.hash) {
  window.location.hash = "#/";
}

createRoot(document.getElementById("root")!).render(<App />);
