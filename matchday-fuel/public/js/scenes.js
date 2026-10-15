// Apple-style scroll scenes. Each scene is a tall track with a sticky stage; scroll position
// inside the track drives what the stage shows. With Reduce Motion on, on very short screens, or
// without script, the same content appears as an ordinary static section
// (accessibility.md › Cognitive, motion.md › Best practices: make motion optional).

const FRAME_COUNT = 72;
const SEQUENCE = "assets/sequence/golden-boot";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function progressOf(track) {
  const distance = track.offsetHeight - window.innerHeight;
  return distance > 0 ? clamp(-track.getBoundingClientRect().top / distance, 0, 1) : 0;
}

function scrollToProgress(track, progress, behavior = "smooth") {
  const top = window.scrollY + track.getBoundingClientRect().top;
  const distance = track.offsetHeight - window.innerHeight;
  window.scrollTo({ top: top + distance * progress, behavior });
}

// Calls onProgress(0..1) for the track while it is near the viewport, at most once a frame.
// When the window width changes (a phone rotated), the track's height changes too, so the
// reader is put back at the same point in the scene instead of a different step.
function trackProgress(track, onProgress) {
  let frame = 0;
  let active = false;
  let last = progressOf(track);
  let width = window.innerWidth;
  const update = () => {
    frame = 0;
    last = progressOf(track);
    onProgress(last);
  };
  const schedule = () => { if (active && !frame) frame = requestAnimationFrame(update); };
  const onResize = () => {
    if (window.innerWidth !== width && last > 0 && last < 1) {
      const keep = last;
      requestAnimationFrame(() => scrollToProgress(track, keep, "auto"));
    }
    width = window.innerWidth;
    schedule();
  };
  const observer = new IntersectionObserver(([entry]) => {
    active = entry.isIntersecting;
    if (active) schedule();
  }, { rootMargin: "50% 0px" });
  observer.observe(track);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", onResize);
  active = true;
  update();
  return {
    progress: () => last,
    stop() {
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", onResize);
      if (frame) cancelAnimationFrame(frame);
    },
  };
}

// Every sport gets its own ball ----------------------------------------------------------------

function sportsScene(section) {
  const track = section.querySelector(".sports-track");
  const steps = [...section.querySelectorAll(".sport-step")];
  const links = [...section.querySelectorAll("[data-step-link]")];
  const bar = section.querySelector(".scene-progress");
  let tracker = null;
  let current = -1;

  const show = (index) => {
    if (index === current) return;
    current = index;
    // Inactive steps are only faded, not hidden, so a screen reader still reads all five sports.
    steps.forEach((step, i) => step.classList.toggle("is-active", i === index));
    links.forEach((link, i) => {
      if (i === index) link.setAttribute("aria-current", "step");
      else link.removeAttribute("aria-current");
    });
  };

  const onLink = (event) => {
    if (!section.classList.contains("is-scrub")) return;
    event.preventDefault();
    const index = Number(event.currentTarget.dataset.stepLink);
    scrollToProgress(track, (index + 0.5) / steps.length);
  };

  return {
    // Where the reader is, so switching modes can keep them on the same sport.
    position: () => (tracker && tracker.progress() > 0 && tracker.progress() < 1 ? { step: current } : null),
    restore({ step }) {
      if (tracker) scrollToProgress(track, (step + 0.5) / steps.length, "auto");
      else steps[step]?.scrollIntoView({ block: "start" });
    },
    enable() {
      if (tracker) return;
      section.classList.add("is-scrub");
      section.querySelectorAll("img[loading=lazy]").forEach((img) => { img.loading = "eager"; });
      links.forEach((link) => link.addEventListener("click", onLink));
      tracker = trackProgress(track, (p) => {
        bar.style.setProperty("--p", p.toFixed(4));
        show(Math.min(steps.length - 1, Math.floor(p * steps.length)));
      });
    },
    disable() {
      if (!tracker) return;
      tracker.stop();
      tracker = null;
      current = -1;
      section.classList.remove("is-scrub");
      steps.forEach((step) => step.classList.remove("is-active"));
      links.forEach((link) => { link.removeAttribute("aria-current"); link.removeEventListener("click", onLink); });
    },
  };
}

// The bottle turning 360 degrees --------------------------------------------------------------

function bottleScene(section) {
  const track = section.querySelector(".bottle-track");
  const figure = section.querySelector(".bottle-figure");
  const canvas = section.querySelector(".bottle-canvas");
  const notes = [...section.querySelectorAll(".bottle-note")];
  const context = canvas.getContext("2d");
  const frames = new Array(FRAME_COUNT);
  let wanted = 0;
  let drawn = -1;
  let tracker = null;
  let loading = false;
  let near = false;
  let nearTimer = 0;
  let resizeObserver = null;
  let pump = null;

  // Phones get 720 px frames: a capped 2x canvas can't use more, and they decode faster.
  let framePath = null;
  const chooseFrames = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const small = figure.clientWidth * ratio <= 760;
    framePath = (i) => `${SEQUENCE}/${small ? "720/" : ""}${String(i).padStart(3, "0")}.webp`;
  };

  const sizeCanvas = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(figure.clientWidth * ratio);
    canvas.height = Math.round(figure.clientHeight * ratio);
    drawn = -1;
    draw();
  };

  const nearestLoaded = (index) => {
    for (let d = 0; d < FRAME_COUNT; d += 1) {
      for (const i of [index - d, index + d]) {
        const image = frames[(i + FRAME_COUNT) % FRAME_COUNT];
        if (image?.complete && image.naturalWidth) return [(i + FRAME_COUNT) % FRAME_COUNT, image];
      }
    }
    return [-1, null];
  };

  function draw() {
    const [index, image] = nearestLoaded(wanted);
    if (!image || index === drawn || !canvas.width) return;
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;
    context.fillStyle = "#FFFFFF";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    drawn = index;
    figure.classList.add("has-frames");
  }

  // Load a coarse set of angles first, at high priority, so scrubbing works early; then fill in
  // the rest. Loading pauses while the section is far away and resumes when it comes back.
  function preload() {
    if (!loading) {
      loading = true;
      if (!framePath) chooseFrames();
      const order = [];
      for (const step of [18, 6, 3, 1]) {
        for (let i = 0; i < FRAME_COUNT; i += step) if (!order.includes(i)) order.push(i);
      }
      let next = 0;
      let inFlight = 0;
      pump = () => {
        while (near && inFlight < 4 && next < order.length) {
          const i = order[next];
          const image = new Image();
          image.decoding = "async";
          image.fetchPriority = next < 4 ? "high" : "low";
          inFlight += 1;
          next += 1;
          image.onload = image.onerror = () => { inFlight -= 1; draw(); pump(); };
          image.src = framePath(i);
          frames[i] = image;
        }
      };
    }
    pump();
  }

  // Ignore fly-bys (for example tapping Order Ahead at the top of the page): start loading only
  // when the section has stayed near the viewport for a moment.
  const nearObserver = new IntersectionObserver(([entry]) => {
    clearTimeout(nearTimer);
    near = entry.isIntersecting;
    if (near && tracker) nearTimer = setTimeout(preload, 400);
  }, { rootMargin: "150% 0px" });

  return {
    position: () => (tracker && tracker.progress() > 0 && tracker.progress() < 1 ? { progress: tracker.progress() } : null),
    restore({ progress }) {
      if (tracker) scrollToProgress(track, progress, "auto");
      else section.scrollIntoView({ block: "start" });
    },
    enable() {
      if (tracker) return;
      section.classList.add("is-scrub");
      resizeObserver = new ResizeObserver(sizeCanvas);
      resizeObserver.observe(figure);
      nearObserver.observe(section);
      tracker = trackProgress(track, (p) => {
        wanted = Math.round(p * (FRAME_COUNT - 1));
        draw();
        const active = Math.min(notes.length - 1, Math.floor(p * notes.length));
        notes.forEach((note, i) => note.classList.toggle("is-active", i === active));
      });
    },
    disable() {
      if (!tracker) return;
      tracker.stop();
      tracker = null;
      near = false;
      clearTimeout(nearTimer);
      resizeObserver?.disconnect();
      nearObserver.disconnect();
      section.classList.remove("is-scrub");
      figure.classList.remove("has-frames");
      notes.forEach((note) => note.classList.remove("is-active"));
    },
  };
}

export function initScenes() {
  const scenes = [];
  const sports = document.querySelector('[data-scene="sports"]');
  const bottle = document.querySelector('[data-scene="bottle"]');
  if (sports) scenes.push(sportsScene(sports));
  if (bottle) scenes.push(bottleScene(bottle));

  // Static sections for Reduce Motion and for screens too short to pin anything.
  const staticMode = window.matchMedia("(prefers-reduced-motion: reduce), (max-height: 359px)");
  let first = true;
  const apply = () => {
    const pinned = first ? null : scenes.map((scene) => [scene, scene.position()]).find(([, at]) => at);
    scenes.forEach((scene) => (staticMode.matches ? scene.disable() : scene.enable()));
    if (pinned) requestAnimationFrame(() => pinned[0].restore(pinned[1]));
    first = false;
  };
  staticMode.addEventListener?.("change", apply);
  apply();
}
