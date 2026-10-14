// Adds live prices, stock, and Add to Order controls to the drink cards in the lineup.

import { formatMoney } from "./format.js";
import { MAX_PER_DRINK } from "./store.js";
import { el, keepFocus, stepper } from "./ui.js";

export function drinkLimit(item) {
  if (!item || item.soldOut) return 0;
  return item.available == null ? MAX_PER_DRINK : Math.max(0, Math.min(MAX_PER_DRINK, item.available));
}

export function stockText(item) {
  if (!item) return { text: "Not available today", out: true };
  if (item.soldOut || item.available === 0) return { text: "Sold out", out: true };
  if (item.available != null && item.available <= 5) return { text: `Only ${item.available} left`, out: false };
  return null;
}

export function initLineup({ cart, state, announce }) {
  const cards = [...document.querySelectorAll(".drink[data-drink]")];

  function renderCard(card) {
    const key = card.dataset.drink;
    const name = card.dataset.name;
    const item = state.menu?.byKey.get(key);
    const priceEl = card.querySelector("[data-price]");
    if (item) priceEl.textContent = formatMoney(item.priceCents, state.menu.currency);

    const action = card.querySelector("[data-action]");
    const qty = cart.get(key);
    const limit = drinkLimit(item);
    const stock = stockText(item);

    keepFocus(action, () => {
      action.replaceChildren();
      if (stock) action.append(el("p", { class: `stock-note${stock.out ? " is-out" : ""}`, text: stock.text }));
      if (!state.menu) return;
      if (limit === 0) {
        action.append(el("button", { class: "btn btn-secondary btn-small", type: "button", disabled: true, text: stock?.out ? "Sold Out" : "Unavailable" }));
      } else if (qty === 0) {
        action.append(el("button", {
          class: "btn btn-secondary btn-small",
          type: "button",
          "aria-label": `Add ${name} to order`,
          onclick: () => {
            cart.set(key, 1, limit);
            announce(`${name} added. ${cart.count()} in your order.`);
            action.querySelector('[aria-label^="Add one"]')?.focus();
          },
        }, "Add to Order"));
      } else {
        action.append(stepper({
          name, qty, max: limit,
          onChange: (next) => {
            const set = cart.set(key, next, limit);
            announce(set === 0 ? `${name} removed.` : `${name}: ${set} in your order.`);
          },
        }));
      }
    });
  }

  const renderAll = () => cards.forEach(renderCard);
  cart.subscribe(({ key }) => {
    if (key == null) return renderAll();
    const card = cards.find((c) => c.dataset.drink === key);
    if (card) renderCard(card);
  });
  return { render: renderAll };
}
