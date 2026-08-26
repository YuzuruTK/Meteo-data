import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import LanguageSelector from "./LanguageSelector";
import { I18nProvider } from "./i18n";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
      <LanguageSelector />
    </I18nProvider>
  </React.StrictMode>,
);
