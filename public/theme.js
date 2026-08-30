(() => {
  const STORAGE_KEY = "nightink_theme";
  const VALID = new Set(["dark", "light"]);

  function readTheme() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (VALID.has(saved)) return saved;
    } catch {}
    return "dark";
  }

  function updateControls(theme) {
    const nextLabel = theme === "dark" ? "Claro" : "Oscuro";
    const nextIcon = theme === "dark" ? "☀" : "☾";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.dataset.currentTheme = theme;
      button.setAttribute("aria-label", `Cambiar a modo ${nextLabel.toLowerCase()}`);
      button.setAttribute("title", `Cambiar a modo ${nextLabel.toLowerCase()}`);
      const icon = button.querySelector("[data-theme-icon]");
      const label = button.querySelector("[data-theme-label]");
      if (icon) icon.textContent = nextIcon;
      if (label) label.textContent = nextLabel;
    });
  }

  function applyTheme(theme, persist = false) {
    const safeTheme = VALID.has(theme) ? theme : "dark";
    document.documentElement.dataset.theme = safeTheme;
    document.documentElement.style.colorScheme = safeTheme;

    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) {
      themeColor.setAttribute("content", safeTheme === "light" ? "#f4f6fb" : "#0d0f18");
    }

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, safeTheme);
      } catch {}
    }

    updateControls(safeTheme);
  }

  applyTheme(readTheme());

  document.addEventListener("DOMContentLoaded", () => {
    updateControls(document.documentElement.dataset.theme || "dark");

    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
        applyTheme(current === "dark" ? "light" : "dark", true);
      });
    });
  });
})();
