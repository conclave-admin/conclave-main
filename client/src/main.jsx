import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import ScrollToTop from "./components/routing/ScrollToTop";
import "./index.css";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const cacheLoadedAssets = (
    worker,
    entries = performance.getEntriesByType("resource"),
  ) => {
    const urls = entries
      .map((entry) => entry.name)
      .filter((value) => {
        const url = new URL(value);
        return (
          url.origin === location.origin && url.pathname.startsWith("/assets/")
        );
      });
    worker?.postMessage({ type: "CACHE_ASSETS", urls: [...new Set(urls)] });
  };
  // Lazy routes may finish loading after window.load or while a new Worker is
  // taking control. Capture those completed resources as well as the initial set.
  if (typeof PerformanceObserver === "function") {
    const observer = new PerformanceObserver((list) =>
      cacheLoadedAssets(navigator.serviceWorker.controller, list.getEntries()),
    );
    observer.observe({ type: "resource", buffered: true });
  }
  navigator.serviceWorker.addEventListener("controllerchange", () =>
    cacheLoadedAssets(navigator.serviceWorker.controller),
  );
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .then(() => navigator.serviceWorker.ready)
      .then((registration) =>
        cacheLoadedAssets(
          navigator.serviceWorker.controller || registration.active,
        ),
      )
      .catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <ScrollToTop />
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
