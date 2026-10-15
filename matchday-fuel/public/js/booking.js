// Venue booking requests.

// Paste a form service endpoint here (Formspree, Basin, Getform, or your own) to receive
// booking requests. While it is empty, the form says plainly that nothing was sent.
const FORM_ENDPOINT = "";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const rules = {
  "book-name": (value) => (value ? "" : "Enter your name."),
  "book-email": (value) => {
    if (!value) return "Enter your email address.";
    return EMAIL_PATTERN.test(value) ? "" : "Enter an email address like name@example.com.";
  },
  "book-venue": (value) => (value ? "" : "Enter your venue or organization."),
  "book-type": (value) => (value ? "" : "Choose a venue type."),
};

export function initBooking() {
  const form = document.getElementById("book");
  if (!form) return;
  const statusEl = document.getElementById("book-status");
  const notice = form.querySelector("[data-booking-notice]");
  // Say up front that requests can't be sent yet, not after someone has filled in the form.
  if (!FORM_ENDPOINT && notice) {
    notice.textContent = "Booking requests open soon. Until then, this form can’t send anything.";
    notice.hidden = false;
  }
  const submitButton = form.querySelector('button[type="submit"]');
  let attempted = false;

  const validateField = (id) => {
    const field = document.getElementById(id);
    const errorEl = document.getElementById(`${id}-error`);
    const message = rules[id](field.value.trim());
    errorEl.textContent = message;
    errorEl.hidden = !message;
    if (message) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
    return !message;
  };

  const showStatus = (message, tone) => {
    statusEl.textContent = message;
    statusEl.className = `form-status${tone ? ` is-${tone}` : ""}`;
    statusEl.hidden = false;
  };

  for (const id of Object.keys(rules)) {
    const field = document.getElementById(id);
    const recheck = () => { if (attempted) validateField(id); };
    field.addEventListener("input", recheck);
    field.addEventListener("change", recheck);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    attempted = true;
    const invalid = Object.keys(rules).filter((id) => !validateField(id));
    if (invalid.length) {
      statusEl.hidden = true;
      document.getElementById(invalid[0]).focus();
      return;
    }
    if (!FORM_ENDPOINT) {
      showStatus("Booking requests aren’t connected yet, so this request wasn’t sent. Your details are still in the form.", "");
      return;
    }
    const email = document.getElementById("book-email").value.trim();
    submitButton.disabled = true;
    submitButton.textContent = "Sending…";
    try {
      const response = await fetch(FORM_ENDPOINT, { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      form.reset();
      attempted = false;
      showStatus(`Request sent. Matchday Fuel will reply to ${email}.`, "success");
    } catch {
      showStatus("The request didn’t go through. Check your connection and try again.", "error");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Send Request";
    }
  });
}
