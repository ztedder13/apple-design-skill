// Adds live prices, stock, and Add to Order controls to the drink cards in the lineup.

import { formatMoney } from "./format.js";
import { MAX_BOTTLES, MAX_PER_DRINK } from "./store.js";
import { el, keepFocus, stepper } from "./ui.js";

export const menuReady = (menu) => Boolean(menu) && menu.mode !== "unavailable";

// The most of this drink an order can hold, from stock alone.
export function drinkLimit(item) {
  if (!item || item.soldOut) return 0;
  return item.available == null ? MAX_PER_DRINK : Math.max(0, Math.min(MAX_PER_DRINK, item.available));
}

// A short stock note, or null when there is nothing to say (or the menu hasn't loaded yet).
export function stockText(item, menu) {
  if (!menuReady(menu)) return null;
  if (!item) return { text: "Not on today’s menu", out: true };
  if (item.soldOut || item.available === 0) return { text: "Sold out", out: true };
  if (item.available != null && item.available <= 5) return { text: `Only ${item.available} left`, out: false };
  return null;
}

export function initLineup({ cart, state, announce }) {
  const cards = [...document.querySelectorAll(".drink[data-drink]")];
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function renderCard(card) {
    const key = card.dataset.drink;
    const name = card.dataset.name;
    const ready = menuReady(state.menu);
    const item = ready ? state.menu.byKey.get(key) : null;
    const priceEl = card.querySelector("[data-price]");
    if (ready) priceEl.textContent = item ? formatMoney(item.priceCents, state.menu.currency) : "";
    else if (state.menu?.mode === "unavailable") priceEl.textContent = "";

    const action = card.querySelector("[data-action]");
    const qty = cart.get(key);
    const limit = drinkLimit(item);
    const max = Math.min(limit, cart.room(key));
    const stock = stockText(item, state.menu);

    keepFocus(action, () => {
      action.replaceChildren();
      if (!ready) {
        if (state.menu) action.append(el("button", { class: "btn btn-secondary btn-small", type: "button", disabled: true, text: "Unavailable" }));
        return;
      }
      if (limit === 0) {
        action.append(el("button", { class: "btn btn-secondary btn-small", type: "button", disabled: true, text: item ? "Sold Out" : "Unavailable" }));
        return;
      }
      if (stock) action.append(el("p", { class: "stock-note", text: stock.text }));
      if (qty === 0) {
        const full = max <= 0;
        action.append(el("button", {
          class: "btn btn-secondary btn-small",
          type: "button",
          disabled: full,
          "aria-label": full ? `Order full: ${MAX_BOTTLES} bottles` : `Add ${name} to order`,
          onclick: () => {
            const set = cart.set(key, 1, limit);
            announce(set ? `${name} added. ${cart.count()} in your order.` : `Orders are limited to ${MAX_BOTTLES} bottles.`);
            if (set) (action.querySelector('[aria-label^="Add one"]:not([disabled])') || action.querySelector("button:not([disabled])"))?.focus();
          },
        }, full ? "Order Full" : "Add to Order"));
      } else {
        action.append(stepper({
          name, qty, max,
          onChange: (next) => {
            const set = cart.set(key, next, limit);
            if (set < next) announce(set >= limit ? `Only ${limit} ${name} left.` : `Orders are limited to ${MAX_BOTTLES} bottles.`);
            else announce(set === 0 ? `${name} removed.` : `${name}: ${set} in your order.`);
          },
        }));
      }
    });
  }

  // On phones the shelf scrolls sideways: bring a focused card fully into view, and make the
  // shelf itself a tab stop only when there is something to scroll.
  for (const shelf of document.querySelectorAll(".shelf")) {
    shelf.addEventListener("focusin", (event) => {
      const card = event.target.closest(".drink");
      if (card && shelf.scrollWidth > shelf.clientWidth + 1) {
        card.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
      }
    });
    const syncTabStop = () => {
      if (shelf.scrollWidth > shelf.clientWidth + 1) shelf.tabIndex = 0;
      else shelf.removeAttribute("tabindex");
    };
    new ResizeObserver(syncTabStop).observe(shelf);
    syncTabStop();
  }

  // The bottle limit affects every card, so redraw them all on any change.
  const renderAll = () => cards.forEach(renderCard);
  cart.subscribe(renderAll);
  return { render: renderAll };
}
