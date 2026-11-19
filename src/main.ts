import "./styles.css";
import { App } from "./ui/app";

new App(document.getElementById("app")!).start();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("Service worker registration failed", e));
  });
}
