// Applies the saved (or system) colour theme before first paint, so there is no flash of the wrong theme.
// Kept as an external file (not an inline <script>) so the production Content-Security-Policy can be `script-src 'self'`.
(function () {
  try {
    var stored = localStorage.getItem("nfsu-portal-theme");
    var theme =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();
