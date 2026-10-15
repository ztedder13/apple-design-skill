// Entry point: loads the menu and schedule, then wires up each part of the page.

import { loadMenu, loadSchedule } from "./api.js";
import { initBooking } from "./booking.js";
import { drinkLimit, initLineup } from "./lineup.js";
import { initOrder } from "./order.js";
import { renderSchedule } from "./schedule.js";
import { initScenes } from "./scenes.js";
import { createCart } from "./store.js";

const MENU_RETRY_MS = 30_000;
const REFRESH_MS = 60_000;

const cart = createCart();
const state = { menu: null, schedule: null };

const announcer = document.querySelector("[data-cart-announcer]");
let announceTimer = 0;
function announce(message) {
  clearTimeout(announceTimer);
  announcer.textContent = "";
  announceTimer = setTimeout(() => { announcer.textContent = message; }, 50);
}

// Navigation: the phone menu closes after a choice, and Order Ahead shows how many drinks are in
// the order.
const menu = document.getElementById("site-menu");
menu?.addEventListener("click", (event) => {
  if (event.target.closest("a")) menu.hidePopover?.();
});
function renderCount() {
  const count = cart.count();
  document.querySelectorAll("[data-cart-count]").forEach((badge) => {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  });
  document.querySelectorAll(".nav-order").forEach((link) => {
    link.setAttribute("aria-label", count ? `Order Ahead, ${count} ${count === 1 ? "drink" : "drinks"} in your order` : "Order Ahead");
  });
}
cart.subscribe(renderCount);
renderCount();

// Another tab changed the saved order.
window.addEventListener("storage", (event) => {
  if (event.key === cart.storageKey) cart.reload();
});

initScenes();
initBooking();
const lineup = initLineup({ cart, state, announce });
const order = initOrder({ cart, state, announce });

function showSchedule() {
  renderSchedule({ schedule: state.schedule, onOrder: (id) => order.selectStop(id) });
}

async function refreshMenu() {
  const menuData = await loadMenu();
  state.menu = { ...menuData, byKey: new Map(menuData.items.map((item) => [item.key, item])) };
  const notice = document.querySelector("[data-menu-notice]");
  const mode = menuData.mode;
  notice.hidden = mode === "square";
  notice.textContent = mode === "unavailable" ? menuData.error : mode === "square" ? "" : "Prices and stock are samples until online ordering opens.";

  if (mode !== "unavailable") {
    // Trim anything in a saved order that is no longer on the menu or is short on stock, and say so.
    const changed = [];
    for (const [key, qty] of cart.entries()) {
      const item = state.menu.byKey.get(key);
      const limit = Math.min(qty, drinkLimit(item));
      if (limit === qty) continue;
      cart.set(key, limit);
      const name = item?.name || document.querySelector(`.drink[data-drink="${key}"]`)?.dataset.name || key;
      changed.push(limit ? `${name} cut to ${limit}` : `${name} removed (sold out)`);
    }
    if (changed.length) order.notify(`Your saved order changed: ${changed.join(", ")}.`);
  } else {
    setTimeout(refreshMenu, MENU_RETRY_MS);
  }
  lineup.render();
  order.render();
}

refreshMenu();

loadSchedule().then((schedule) => {
  state.schedule = schedule;
  showSchedule();
  order.render();
});

// Keep "Open now", closed stops, and pickup times current while the page stays open.
function refreshTimes() {
  if (!state.schedule) return;
  showSchedule();
  order.render();
}
setInterval(refreshTimes, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshTimes(); });
