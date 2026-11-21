// Sets the light or dark class before the first paint, from the saved choice, else the device.
try {
  var saved = localStorage.getItem("maipai.stack.admin.theme");
  var dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.add(dark ? "dark" : "light");
} catch (e) {
  document.documentElement.classList.add("light");
}
