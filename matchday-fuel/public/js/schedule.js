// Renders the list of upcoming stops.

import { DEFAULT_CUTOFF_MINUTES } from "./api.js";
import { dateTile, dayKey, formatTimeRange, mapsUrl } from "./format.js";
import { el, icon } from "./ui.js";

export function isOrderable(event, now = new Date(), cutoffMinutes = DEFAULT_CUTOFF_MINUTES) {
  return !event.closed && event.end.getTime() - cutoffMinutes * 60_000 > now.getTime();
}

function statusChips(event, timeZone, now) {
  const chips = [];
  const today = dayKey(now, timeZone);
  const tomorrow = dayKey(new Date(now.getTime() + 86_400_000), timeZone);
  const day = dayKey(event.start, timeZone);
  if (event.start <= now && now < event.end) chips.push(el("span", { class: "chip is-live", text: "Open now" }));
  else if (day === today) chips.push(el("span", { class: "chip", text: "Today" }));
  else if (day === tomorrow) chips.push(el("span", { class: "chip", text: "Tomorrow" }));
  if (event.sample) chips.push(el("span", { class: "chip", text: "Example" }));
  return chips;
}

export function renderSchedule({ schedule, onOrder, now = new Date() }) {
  const list = document.querySelector("[data-stops]");
  const notice = document.querySelector("[data-schedule-notice]");
  const timeZone = schedule.timezone;
  const cutoff = schedule.orderCutoffMinutes ?? DEFAULT_CUTOFF_MINUTES;
  list.setAttribute("aria-busy", "false");

  const hasSamples = schedule.events.some((event) => event.sample);
  notice.hidden = !hasSamples;
  notice.textContent = hasSamples ? "These stops are examples. The real schedule appears here once it’s set up." : "";

  if (schedule.mode === "unavailable") {
    delete list.dataset.signature;
    list.replaceChildren(el("li", { class: "stops-empty", text: schedule.error }));
    return;
  }
  const events = schedule.events.filter((event) => event.end > now);
  if (!events.length) {
    delete list.dataset.signature;
    list.replaceChildren(el("li", { class: "stops-empty" },
      "No stops are scheduled right now. Check back soon, or ",
      el("a", { href: "#venues", text: "book Matchday Fuel for your venue" }), "."));
    return;
  }

  // Skip the redraw when nothing visible changed, so a focused button keeps its focus.
  const signature = events.map((event) => [
    event.id, event.title, event.start.getTime(), event.end.getTime(),
    statusChips(event, timeZone, now).map((chip) => chip.textContent).join("+"), isOrderable(event, now, cutoff),
  ].join("|")).join("\n");
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;

  list.replaceChildren(...events.map((event) => {
    const tile = dateTile(event.start, timeZone);
    const place = [event.venue, event.address].filter(Boolean).join(", ");
    const titleId = `stop-${event.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const orderable = isOrderable(event, now, cutoff);
    return el("li", { class: "stop", "aria-labelledby": titleId },
      el("p", { class: "stop-date", "aria-hidden": "true" },
        el("span", { class: "month", text: tile.month }),
        el("span", { class: "day", text: tile.day }),
        el("span", { class: "weekday", text: tile.weekday })),
      el("div", { class: "stop-body" },
        el("div", { class: "chips" }, statusChips(event, timeZone, now)),
        el("h3", { class: "stop-title", id: titleId, text: event.title }),
        el("p", { class: "stop-meta" }, icon("i-clock"),
          el("span", {}, `${tile.weekday}, ${tile.month} ${tile.day} · ${formatTimeRange(event.start, event.end, timeZone)}`)),
        place && el("p", { class: "stop-meta" }, icon("i-pin"),
          el("a", { href: mapsUrl(place), target: "_blank", rel: "noopener", text: place })),
        event.notes && el("p", { class: "stop-notes", text: event.notes })),
      el("div", { class: "stop-action" },
        orderable
          ? el("button", { class: "btn btn-secondary btn-small", type: "button", onclick: () => onOrder(event.id) }, "Order for This Stop")
          : el("p", { class: "closed", text: "Orders closed" })),
    );
  }));
}
