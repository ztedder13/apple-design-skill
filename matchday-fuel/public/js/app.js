// Entry point: loads the menu and schedule, then wires up each part of the page.

import { loadMenu, loadSchedule } from "./api.js";
import { initBooking } from "./booking.js";
import { initLineup } from "./lineup.js";
import { initOrder } from "./order.js";
import { renderSchedule } from "./schedule.js";
import { initScenes } from "./scenes.js";
import { createCart } from "./store.js";

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

initScenes();
initBooking();
const lineup = initLineup({ cart, state, announce });
const order = initOrder({ cart, state, announce });

loadMenu().then((menuData) => {
  state.menu = { ...menuData, byKey: new Map(menuData.items.map((item) => [item.key, item])) };
  const notice = document.querySelector("[data-menu-notice]");
  const live = menuData.mode === "square";
  notice.hidden = live;
  notice.textContent = live ? "" : "Prices and stock are samples until online ordering opens.";
  // Drop anything in a saved order that is no longer on the menu or is now sold out.
  for (const [key, qty] of cart.entries()) {
    const item = state.menu.byKey.get(key);
    const limit = !item || item.soldOut ? 0 : item.available == null ? qty : Math.min(qty, item.available);
    if (limit !== qty) cart.set(key, limit);
  }
  lineup.render();
  order.render();
});

loadSchedule().then((schedule) => {
  state.schedule = schedule;
  renderSchedule({ schedule, onOrder: (id) => order.selectStop(id) });
  order.render();
});
