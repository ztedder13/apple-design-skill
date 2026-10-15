// Small shared pieces of interface.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

export function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
}

// A stepper with minus and plus buttons around the current quantity. The buttons name the
// drink so a screen reader hears "Add one Golden Boot", not just "plus".
export function stepper({ name, qty, max, onChange }) {
  return el("div", { class: "stepper", role: "group", "aria-label": `${name} quantity` },
    el("button", {
      type: "button",
      "aria-label": qty === 1 ? `Remove ${name}` : `Remove one ${name}`,
      disabled: qty <= 0,
      onclick: () => onChange(qty - 1),
    }, icon("i-minus")),
    el("output", { "aria-live": "off", text: String(qty) }),
    el("button", {
      type: "button",
      "aria-label": `Add one ${name}`,
      disabled: qty >= max,
      onclick: () => onChange(qty + 1),
    }, icon("i-plus")),
  );
}

// After a stepper re-renders, keep keyboard focus on the same button instead of losing it.
export function keepFocus(container, render) {
  const active = document.activeElement;
  const label = container.contains(active) ? active.getAttribute("aria-label") : null;
  render();
  if (!label) return;
  const buttons = [...container.querySelectorAll("button:not([disabled])")];
  (buttons.find((button) => button.getAttribute("aria-label") === label) || buttons[0])?.focus();
}
