// Order ahead: choose a stop and pickup time, adjust drinks, enter contact details, then hand off
// to Square's hosted checkout. Prices and stock always come from Square on the server; the page
// only shows them.

import { DEFAULT_CUTOFF_MINUTES, startCheckout } from "./api.js";
import { formatDay, formatMoney, formatTime, formatTimeRange } from "./format.js";
import { drinkLimit, menuReady, stockText } from "./lineup.js";
import { isOrderable } from "./schedule.js";
import { MAX_BOTTLES } from "./store.js";
import { el, icon, keepFocus, stepper } from "./ui.js";

const SLOT_MINUTES = 15;
const MAX_STOP_CHOICES = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Accepts a US number (10 digits, optionally with a leading 1) or an international number
// written with a leading +, the same rule the server applies.
function phoneIsValid(value) {
  const digits = value.replace(/\D/g, "");
  if (value.trim().startsWith("+")) return /^[1-9]\d{7,14}$/.test(digits);
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
}

export function initOrder({ cart, state, announce }) {
  const form = document.querySelector("[data-order-form]");
  const stopChoices = form.querySelector("[data-stop-choices]");
  const timeSelect = form.querySelector("[data-pickup-time]");
  const itemsList = form.querySelector("[data-order-items]");
  const summaryStop = form.querySelector("[data-summary-stop]");
  const summaryLines = form.querySelector("[data-summary-lines]");
  const subtotalEl = form.querySelector("[data-subtotal]");
  const capNote = form.querySelector("[data-cap-note]");
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
  let stopsSignature = "";
  let timesSignature = "";

  const tz = () => state.schedule?.timezone;
  const cutoff = () => state.schedule?.orderCutoffMinutes ?? DEFAULT_CUTOFF_MINUTES;
  const allOrderable = () => (state.schedule?.events || []).filter((event) => isOrderable(event, new Date(), cutoff()));
  const stopById = (id) => allOrderable().find((event) => event.id === id) || null;
  // The next few stops, plus the chosen one if it is further out (chosen from the schedule).
  const stopList = () => {
    const list = allOrderable().slice(0, MAX_STOP_CHOICES);
    if (selectedStop && !list.includes(selectedStop) && isOrderable(selectedStop, new Date(), cutoff())) list.push(selectedStop);
    return list;
  };

  // Errors and status -------------------------------------------------------------------------

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
    add("order-stop", selectedStop ? "" : "Choose a stop for pickup.", null, stopChoices.querySelector("input"));
    add("order-items", cart.count() ? "" : "Add at least one drink.", null, itemsList.querySelector("button:not([disabled])"));
    add("order-name", fields.name.value.trim() ? "" : "Enter a name for pickup.", fields.name);

    const email = fields.email.value.trim();
    const phone = fields.phone.value.trim();
    let emailError = "";
    if (!email && !phone) emailError = "Enter an email address or a phone number.";
    else if (email && !EMAIL.test(email)) emailError = "Enter an email address like name@example.com.";
    add("order-email", emailError, fields.email);
    add("order-phone", phone && !phoneIsValid(phone) ? "Enter a 10-digit phone number, or start with + and the country code." : "", fields.phone);
    return problems;
  }

  // Rendering ---------------------------------------------------------------------------------

  function renderStops() {
    if (selectedStop && !isOrderable(selectedStop, new Date(), cutoff())) selectedStop = null;
    if (!state.schedule) return;
    const stops = stopList();
    const signature = `${state.schedule.mode}|${stops.map((event) => event.id).join(",")}|${selectedStop?.id || ""}`;
    if (signature === stopsSignature) return; // unchanged: keep the radios, and any focus on them
    stopsSignature = signature;
    if (state.schedule.mode === "unavailable") {
      stopChoices.replaceChildren(el("p", { class: "muted", text: state.schedule.error }));
      return;
    }
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
          onchange: () => selectStop(event.id, { scroll: false }),
        }),
        el("label", { for: id },
          el("span", { class: "when", text: `${formatDay(event.start, tz())} · ${formatTimeRange(event.start, event.end, tz())}` }),
          el("span", { class: "where", text: [event.title, event.venue].filter(Boolean).join(" · ") }),
          el("span", { class: "check" }, icon("i-check"))));
    }));
  }

  function timeOptions() {
    if (!selectedStop) return [{ value: "asap", text: "Choose a stop first" }];
    const now = Date.now();
    const start = selectedStop.start.getTime();
    const last = selectedStop.end.getTime() - cutoff() * 60_000;
    const slot = SLOT_MINUTES * 60_000;
    const soonest = Math.ceil((now + slot) / slot) * slot;
    const opensLater = start > now;
    const options = [{
      value: "asap",
      text: opensLater ? `When the stand opens (${formatTime(selectedStop.start, tz())})` : "As soon as possible",
    }];
    const times = [];
    for (let t = Math.max(start, soonest); t <= last; t += slot) {
      if (opensLater && t === start) continue;
      times.push(new Date(t));
    }
    // On the night clocks fall back, the same hour happens twice; name the zone to tell them apart.
    const plain = times.map((time) => formatTime(time, tz()));
    times.forEach((time, i) => {
      const repeated = plain.indexOf(plain[i]) !== plain.lastIndexOf(plain[i]);
      options.push({ value: time.toISOString(), text: repeated ? formatTime(time, tz(), { withZone: true }) : plain[i] });
    });
    return options;
  }

  function renderTimes() {
    const options = timeOptions();
    const signature = options.map((option) => option.value + option.text).join("|");
    if (signature === timesSignature) return;
    timesSignature = signature;
    const previous = timeSelect.value;
    timeSelect.replaceChildren(...options.map((option) => el("option", { value: option.value, text: option.text })));
    timeSelect.disabled = !selectedStop;
    if (options.some((option) => option.value === previous)) timeSelect.value = previous;
  }

  function renderItems() {
    keepFocus(itemsList, () => {
      if (!state.menu) {
        itemsList.replaceChildren(el("li", { class: "muted", text: "Loading prices and stock…" }));
        return;
      }
      if (!menuReady(state.menu)) {
        itemsList.replaceChildren(el("li", { class: "muted", text: state.menu.error }));
        return;
      }
      itemsList.replaceChildren(...cards.map((drink) => {
        const item = state.menu.byKey.get(drink.key);
        const qty = cart.get(drink.key);
        const limit = drinkLimit(item);
        const stock = stockText(item, state.menu);
        const price = item ? formatMoney(item.priceCents, state.menu.currency) : "";
        return el("li", { class: `order-item${limit === 0 ? " is-out" : ""}`, "data-drink-row": drink.key },
          el("img", { src: drink.image, alt: "", width: "56", height: "70", loading: "lazy" }),
          el("div", {},
            el("p", { class: "name", text: drink.name }),
            el("p", { class: "meta" }, [drink.flavor, price].filter(Boolean).join(" · "),
              stock && limit > 0 && el("span", { class: "warn" }, ` · ${stock.text}`))),
          limit === 0
            ? el("span", { class: "muted", text: item ? "Sold out" : "Unavailable" })
            : stepper({
              name: drink.name, qty, max: Math.min(limit, cart.room(drink.key)),
              onChange: (next) => {
                const set = cart.set(drink.key, next, limit);
                if (set < next) announce(set >= limit ? `Only ${limit} ${drink.name} left.` : `Orders are limited to ${MAX_BOTTLES} bottles.`);
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
    const ready = menuReady(state.menu);
    let subtotal = 0;
    summaryLines.replaceChildren(...(lines.length ? lines.map((drink) => {
      const qty = cart.get(drink.key);
      const item = ready ? state.menu.byKey.get(drink.key) : null;
      const amount = item ? item.priceCents * qty : 0;
      subtotal += amount;
      return el("li", {},
        el("span", { text: `${qty} × ${drink.name}` }),
        el("span", { class: "amount", text: item ? formatMoney(amount, state.menu.currency) : "—" }));
    }) : [el("li", { class: "muted", text: "No drinks yet" })]));
    subtotalEl.textContent = formatMoney(subtotal, state.menu?.currency || "USD");
    capNote.hidden = cart.count() < MAX_BOTTLES;
  }

  function renderNotice() {
    const mode = state.menu?.mode;
    notice.hidden = !mode || mode === "square";
    if (mode === "unavailable") notice.textContent = state.menu.error;
    else if (mode) notice.textContent = "Ordering opens soon. Prices and stock shown here are samples, and checkout isn’t connected yet.";
  }

  function render() {
    renderNotice();
    renderStops();
    renderTimes();
    renderItems();
    renderSummary();
  }

  function selectStop(id, { scroll = true } = {}) {
    const stop = stopById(id);
    if (!stop) {
      announce("Orders for this stop have closed.");
      return false;
    }
    selectedStop = stop;
    renderStops();
    renderTimes();
    renderSummary();
    setError("order-time", "", timeSelect);
    if (attempted) setError("order-stop", "");
    if (scroll) {
      confirmed.hidden = true;
      form.hidden = false;
      const radio = stopChoices.querySelector("input:checked");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("order").scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
      radio?.focus({ preventScroll: true });
    }
    return true;
  }

  // Checkout ----------------------------------------------------------------------------------

  // The button stays focusable while a request runs, so keyboard focus is never lost; `busy`
  // blocks a second submit.
  function setBusy(value) {
    busy = value;
    if (value) submit.setAttribute("aria-disabled", "true");
    else submit.removeAttribute("aria-disabled");
    submit.textContent = value ? "Opening checkout…" : "Continue to Payment";
  }

  function fail(message) {
    showStatus(message, "error");
    submit.focus();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    if (!menuReady(state.menu)) {
      fail(state.menu ? state.menu.error : "Prices are still loading. Try again in a moment.");
      return;
    }
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

    setBusy(true);
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
    setBusy(false);

    if (code === 400 && data?.field) {
      const field = String(data.field);
      const targets = {
        "customer.name": ["order-name", fields.name, fields.name],
        "customer.email": ["order-email", fields.email, fields.email],
        "customer.phone": ["order-phone", fields.phone, fields.phone],
        pickupTime: ["order-time", timeSelect, timeSelect],
        eventId: ["order-stop", null, stopChoices.querySelector("input")],
      };
      const target = targets[field] || (field.startsWith("items") ? ["order-items", null, itemsList.querySelector("button:not([disabled])")] : null);
      if (target) {
        if (field === "pickupTime") { timesSignature = ""; renderTimes(); }
        setError(target[0], data.error, target[1]);
        (target[2] || submit).focus();
        return;
      }
    }
    if (code === 409 && data?.code === "OUT_OF_STOCK") {
      const changes = [];
      for (const short of data.items || []) {
        const item = state.menu.items.find((entry) => entry.variationId === short.variationId);
        if (!item) continue;
        item.available = short.available;
        item.soldOut = short.available <= 0;
        cart.set(item.key, Math.min(cart.get(item.key), drinkLimit(item)), drinkLimit(item));
        changes.push(short.available > 0 ? `only ${short.available} ${item.name} left` : `${item.name} sold out`);
      }
      render();
      const what = changes.length ? `${changes.join(" and ")}, so your order was updated` : "Some drinks just sold out or ran low, so your order was updated";
      fail(`${what[0].toUpperCase()}${what.slice(1)}. Check it and try again.`);
      return;
    }
    if (code === 409 && data?.code === "EVENT_CLOSED") {
      if (selectedStop) selectedStop.closed = true;
      selectedStop = null;
      stopsSignature = "";
      render();
      setError("order-stop", data.error || "Orders for this stop have closed. Choose another stop.");
      (stopChoices.querySelector("input") || submit).focus();
      return;
    }
    if (code === 503 || code === 404 || (code === 0 && state.menu.mode !== "square")) {
      fail("Online ordering isn’t connected to Square yet, so no payment was taken.");
      return;
    }
    if (code === -1) {
      fail("Checkout is taking too long. Nothing was charged. Try again.");
      return;
    }
    if (code === 0) {
      fail("The ordering service can’t be reached. Check your connection and try again.");
      return;
    }
    fail(data?.error || "Checkout couldn’t start. Nothing was charged. Try again in a moment.");
  }

  // Wiring ------------------------------------------------------------------------------------

  form.addEventListener("submit", onSubmit);
  for (const control of Object.values(fields)) {
    control.addEventListener("input", () => { if (attempted) validate(); });
  }
  timeSelect.addEventListener("change", () => setError("order-time", "", timeSelect));
  cart.subscribe(() => {
    renderItems();
    renderSummary();
    if (attempted) setError("order-items", cart.count() ? "" : "Add at least one drink.");
  });

  // Coming back with the Back button (for example from Square) restores this page from the
  // browser's cache: re-read the saved order, which is empty after paying, and reset the button.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    cart.reload();
    setBusy(false);
    showStatus("");
    render();
  });

  document.querySelector("[data-new-order]")?.addEventListener("click", () => {
    confirmed.hidden = true;
    form.hidden = false;
    form.querySelector("input, button")?.focus();
  });

  // Returning from Square after paying. Square may add its own parameters to the address.
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

  return { render, selectStop, notify: (message) => showStatus(message) };
}
