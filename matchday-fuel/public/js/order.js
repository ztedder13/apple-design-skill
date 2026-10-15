// Order ahead: choose a stop and pickup time, adjust drinks, enter contact details, then hand off
// to Square's hosted checkout. Prices and stock always come from Square on the server; the page
// only shows them.

import { startCheckout } from "./api.js";
import { formatDay, formatMoney, formatTime, formatTimeRange } from "./format.js";
import { drinkLimit, stockText } from "./lineup.js";
import { isOrderable, ORDER_CUTOFF_MINUTES } from "./schedule.js";
import { MAX_BOTTLES } from "./store.js";
import { el, icon, keepFocus, stepper } from "./ui.js";

const SLOT_MINUTES = 15;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function phoneDigits(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export function initOrder({ cart, state, announce }) {
  const form = document.querySelector("[data-order-form]");
  const stopChoices = form.querySelector("[data-stop-choices]");
  const timeSelect = form.querySelector("[data-pickup-time]");
  const itemsList = form.querySelector("[data-order-items]");
  const summaryStop = form.querySelector("[data-summary-stop]");
  const summaryLines = form.querySelector("[data-summary-lines]");
  const subtotalEl = form.querySelector("[data-subtotal]");
  const status = form.querySelector("[data-order-status]");
  const submit = form.querySelector("[data-checkout]");
  const notice = document.querySelector("[data-order-notice]");
  const confirmed = document.querySelector("[data-order-confirmed]");
  const fields = {
    name: form.querySelector("#order-name"),
    email: form.querySelector("#order-email"),
    phone: form.querySelector("#order-phone"),
  };
  const cards = [...document.querySelectorAll(".drink[data-drink]")].map((card) => ({
    key: card.dataset.drink,
    name: card.dataset.name,
    flavor: card.dataset.flavor,
    image: card.querySelector(".drink-photo")?.getAttribute("src"),
  }));

  let selectedStop = null;
  let attempted = false;
  let busy = false;

  const tz = () => state.schedule?.timezone;
  const orderableStops = () => (state.schedule?.events || []).filter((event) => isOrderable(event)).slice(0, 8);
  const stopById = (id) => orderableStops().find((event) => event.id === id) || null;

  // Errors ------------------------------------------------------------------------------------

  function setError(id, message, control) {
    const errorEl = document.getElementById(`${id}-error`);
    if (errorEl) {
      errorEl.textContent = message || "";
      errorEl.hidden = !message;
    }
    if (control) {
      if (message) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    }
  }

  function showStatus(message, tone = "") {
    status.textContent = message;
    status.className = `form-status${tone ? ` is-${tone}` : ""}`;
    status.hidden = !message;
  }

  function validate() {
    const problems = [];
    const add = (id, message, control, focusTarget) => {
      setError(id, message, control);
      if (message) problems.push(focusTarget || control);
    };
    const firstRadio = stopChoices.querySelector("input");
    add("order-stop", selectedStop ? "" : "Choose a stop for pickup.", null, firstRadio);
    add("order-items", cart.count() ? "" : "Add at least one drink.", null, itemsList.querySelector("button:not([disabled])"));
    add("order-name", fields.name.value.trim() ? "" : "Enter a name for pickup.", fields.name);

    const email = fields.email.value.trim();
    const phone = fields.phone.value.trim();
    let emailError = "";
    let phoneError = "";
    if (!email && !phone) emailError = "Enter an email address or a phone number.";
    else if (email && !EMAIL.test(email)) emailError = "Enter an email address like name@example.com.";
    if (phone && phoneDigits(phone).length !== 10) phoneError = "Enter a 10-digit phone number.";
    add("order-email", emailError, fields.email);
    add("order-phone", phoneError, fields.phone);
    return problems;
  }

  // Rendering ---------------------------------------------------------------------------------

  function renderStops() {
    const stops = orderableStops();
    if (selectedStop && !stops.some((event) => event.id === selectedStop.id)) selectedStop = null;
    if (!state.schedule) return;
    if (!stops.length) {
      stopChoices.replaceChildren(el("p", { class: "muted", text: "No stops are open for orders right now. Check the schedule for upcoming dates." }));
      return;
    }
    stopChoices.replaceChildren(...stops.map((event, index) => {
      const id = `order-stop-${index}`;
      return el("div", { class: "stop-choice" },
        el("input", {
          type: "radio", name: "stop", id, value: event.id,
          checked: selectedStop?.id === event.id,
          "aria-describedby": "order-stop-error",
          onchange: () => selectStop(event.id, { scroll: false }),
        }),
        el("label", { for: id },
          el("span", { class: "when", text: `${formatDay(event.start, tz())} · ${formatTimeRange(event.start, event.end, tz())}` }),
          el("span", { class: "where", text: [event.title, event.venue].filter(Boolean).join(" · ") }),
          el("span", { class: "check" }, icon("i-check"))));
    }));
  }

  function renderTimes() {
    const previous = timeSelect.value;
    timeSelect.replaceChildren();
    if (!selectedStop) {
      timeSelect.append(el("option", { value: "asap", text: "Choose a stop first" }));
      timeSelect.disabled = true;
      return;
    }
    const now = Date.now();
    const start = selectedStop.start.getTime();
    const last = selectedStop.end.getTime() - ORDER_CUTOFF_MINUTES * 60_000;
    const soonest = Math.ceil((now + SLOT_MINUTES * 60_000) / (SLOT_MINUTES * 60_000)) * SLOT_MINUTES * 60_000;
    const opensLater = start > now;
    timeSelect.append(el("option", {
      value: "asap",
      text: opensLater ? `When the stand opens (${formatTime(selectedStop.start, tz())})` : "As soon as possible",
    }));
    for (let t = Math.max(start, soonest); t <= last; t += SLOT_MINUTES * 60_000) {
      if (opensLater && t === start) continue;
      const iso = new Date(t).toISOString();
      timeSelect.append(el("option", { value: iso, text: formatTime(new Date(t), tz()) }));
    }
    timeSelect.disabled = false;
    if ([...timeSelect.options].some((option) => option.value === previous)) timeSelect.value = previous;
  }

  function renderItems() {
    keepFocus(itemsList, () => {
      itemsList.replaceChildren(...cards.map((drink) => {
        const item = state.menu?.byKey.get(drink.key);
        const qty = cart.get(drink.key);
        const limit = drinkLimit(item);
        const stock = stockText(item);
        const price = item ? formatMoney(item.priceCents, state.menu.currency) : "";
        return el("li", { class: `order-item${limit === 0 ? " is-out" : ""}` },
          el("img", { src: drink.image, alt: "", width: "56", height: "70", loading: "lazy" }),
          el("div", {},
            el("p", { class: "name", text: drink.name }),
            el("p", { class: "meta" }, [drink.flavor, price].filter(Boolean).join(" · "),
              stock && el("span", { class: stock.out ? "" : "warn" }, ` · ${stock.text}`))),
          limit === 0
            ? el("span", { class: "muted", text: "Sold out" })
            : stepper({
              name: drink.name, qty, max: limit,
              onChange: (next) => {
                const set = cart.set(drink.key, next, limit);
                if (next > set && cart.count() >= MAX_BOTTLES) announce(`Orders are limited to ${MAX_BOTTLES} bottles.`);
                else announce(set === 0 ? `${drink.name} removed.` : `${drink.name}: ${set} in your order.`);
              },
            }));
      }));
    });
  }

  function renderSummary() {
    summaryStop.textContent = selectedStop
      ? `${selectedStop.venue || selectedStop.title}, ${formatDay(selectedStop.start, tz())}`
      : "No stop selected";
    const lines = cards.filter((drink) => cart.get(drink.key) > 0);
    let subtotal = 0;
    summaryLines.replaceChildren(...(lines.length ? lines.map((drink) => {
      const qty = cart.get(drink.key);
      const item = state.menu?.byKey.get(drink.key);
      const amount = item ? item.priceCents * qty : 0;
      subtotal += amount;
      return el("li", {},
        el("span", { text: `${qty} × ${drink.name}` }),
        el("span", { class: "amount", text: item ? formatMoney(amount, state.menu.currency) : "—" }));
    }) : [el("li", { class: "muted", text: "No drinks yet" })]));
    subtotalEl.textContent = formatMoney(subtotal, state.menu?.currency || "USD");
  }

  function renderNotice() {
    const live = state.menu?.mode === "square";
    notice.hidden = live || !state.menu;
    notice.textContent = live ? "" : "Ordering opens soon. Prices and stock shown here are samples, and checkout isn’t connected yet.";
  }

  function render() {
    renderNotice();
    renderStops();
    renderTimes();
    renderItems();
    renderSummary();
  }

  function selectStop(id, { scroll = true } = {}) {
    selectedStop = stopById(id);
    renderStops();
    renderTimes();
    renderSummary();
    if (attempted) setError("order-stop", selectedStop ? "" : "Choose a stop for pickup.");
    if (scroll && selectedStop) {
      confirmed.hidden = true;
      form.hidden = false;
      const radio = stopChoices.querySelector("input:checked");
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("order").scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
      radio?.focus({ preventScroll: true });
    }
  }

  // Checkout ----------------------------------------------------------------------------------

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    attempted = true;
    const problems = validate();
    if (problems.length) {
      showStatus("");
      problems[0]?.focus();
      return;
    }

    const items = cards
      .filter((drink) => cart.get(drink.key) > 0)
      .map((drink) => ({ variationId: state.menu.byKey.get(drink.key)?.variationId, quantity: cart.get(drink.key) }))
      .filter((line) => line.variationId);

    busy = true;
    submit.disabled = true;
    submit.textContent = "Opening checkout…";
    showStatus("");
    const { status: code, data } = await startCheckout({
      eventId: selectedStop.id,
      pickupTime: timeSelect.value || "asap",
      items,
      customer: { name: fields.name.value.trim(), email: fields.email.value.trim(), phone: fields.phone.value.trim() },
    });

    if (code === 200 && /^https:\/\//.test(data?.checkoutUrl || "")) {
      showStatus("Opening Square checkout…");
      window.location.assign(data.checkoutUrl);
      return;
    }

    busy = false;
    submit.disabled = false;
    submit.textContent = "Continue to Payment";

    if (code === 400 && data?.field) {
      const map = { "customer.name": fields.name, "customer.email": fields.email, "customer.phone": fields.phone };
      const control = map[data.field];
      if (control) {
        setError(control.id, data.error, control);
        control.focus();
        return;
      }
    }
    if (code === 409 && data?.code === "OUT_OF_STOCK") {
      for (const short of data.items || []) {
        const item = state.menu.items.find((entry) => entry.variationId === short.variationId);
        if (!item) continue;
        item.available = short.available;
        item.soldOut = short.available <= 0;
        cart.set(item.key, Math.min(cart.get(item.key), drinkLimit(item)), drinkLimit(item));
      }
      render();
      showStatus("Some drinks just sold out or ran low, so your order was updated. Check it and try again.", "error");
      return;
    }
    if (code === 409 && data?.code === "EVENT_CLOSED") {
      showStatus("Orders for this stop have closed. Choose another stop.", "error");
      return;
    }
    if (code === 503 || code === 404 || (code === 0 && state.menu?.mode !== "square")) {
      showStatus("Online ordering isn’t connected to Square yet, so no payment was taken.", "error");
      return;
    }
    if (code === 0) {
      showStatus("The ordering service can’t be reached. Check your connection and try again.", "error");
      return;
    }
    showStatus(data?.error || "Checkout couldn’t start. Try again in a moment.", "error");
  }

  // Wiring ------------------------------------------------------------------------------------

  form.addEventListener("submit", onSubmit);
  // Coming back from Square with the Back button can restore this page from the browser's
  // cache mid-submit; reset the button so the order can be sent again.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    busy = false;
    submit.disabled = false;
    submit.textContent = "Continue to Payment";
    showStatus("");
  });
  for (const control of Object.values(fields)) {
    control.addEventListener("input", () => { if (attempted) validate(); });
  }
  cart.subscribe(() => {
    renderItems();
    renderSummary();
    if (attempted) setError("order-items", cart.count() ? "" : "Add at least one drink.");
  });

  document.querySelector("[data-new-order]")?.addEventListener("click", () => {
    confirmed.hidden = true;
    form.hidden = false;
    form.querySelector("input, button")?.focus();
  });

  // Returning from Square after paying.
  const params = new URLSearchParams(window.location.search);
  if (params.get("order") === "placed") {
    cart.clear();
    confirmed.hidden = false;
    form.hidden = true;
    history.replaceState(null, "", `${window.location.pathname}#order`);
    requestAnimationFrame(() => {
      document.getElementById("order").scrollIntoView();
      confirmed.focus();
    });
  }

  return { render, selectStop };
}
