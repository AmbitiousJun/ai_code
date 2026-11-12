const systemDark = matchMedia("(prefers-color-scheme: dark)");
let preferredTheme = "light";
function applyTheme(value) {
  preferredTheme = value;
  document.documentElement.dataset.theme = value === "system"
    ? (systemDark.matches ? "dark" : "light") : value;
}
systemDark.addEventListener("change", () => applyTheme(preferredTheme));
window.addEventListener("storage", e => {
  if (e.key === "gametrail-theme" && e.newValue) {
    applyTheme(e.newValue);
    const picker = document.getElementById("theme");
    if (picker && picker.value !== e.newValue) {
      picker.value = e.newValue;
      picker.dispatchEvent(new Event("input"));
    }
  }
});
