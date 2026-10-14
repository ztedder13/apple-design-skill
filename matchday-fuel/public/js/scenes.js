// Apple-style scroll scenes. Each scene is a tall track with a sticky stage; scroll position
// inside the track drives what the stage shows. With Reduce Motion on, or without script, the
// same content appears as an ordinary static section (accessibility.md › Cognitive,
// motion.md › Best practices: make motion optional).

const FRAME_COUNT = 72;
const framePath = (i) => `assets/sequence/golden-boot/${String(i).padStart(3, "0")}.webp`;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Calls onProgress(0..1) for the track while it is near the viewport, at most once a frame.
function trackProgress(track, onProgress) {
  let frame = 0;
  let active = false;
  const update = () => {
    frame = 0;
    const rect = track.getBoundingClientRect();
    const distance = track.offsetHeight - window.innerHeight;
    onProgress(distance > 0 ? clamp(-rect.top / distance, 0, 1) : 0);
  };
  const schedule = () => { if (active && !frame) frame = requestAnimationFrame(update); };
  const observer = new IntersectionObserver(([entry]) => {
    active = entry.isIntersecting;
    if (active) schedule();
  }, { rootMargin: "50% 0px" });
  observer.observe(track);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  active = true;
  update();
  return () => {
    observer.disconnect();
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}

function scrollToProgress(track, progress) {
  const top = window.scrollY + track.getBoundingClientRect().top;
  const distance = track.offsetHeight - window.innerHeight;
  window.scrollTo({ top: top + distance * progress, behavior: "smooth" });
}

// Every sport gets its own ball ----------------------------------------------------------------

function sportsScene(section) {
  const track = section.querySelector(".sports-track");
  const steps = [...section.querySelectorAll(".sport-step")];
  const links = [...section.querySelectorAll("[data-step-link]")];
  const bar = section.querySelector(".scene-progress");
  let stop = null;
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
    enable() {
      if (stop) return;
      section.classList.add("is-scrub");
      section.querySelectorAll("img[loading=lazy]").forEach((img) => { img.loading = "eager"; });
      links.forEach((link) => link.addEventListener("click", onLink));
      stop = trackProgress(track, (p) => {
        bar.style.setProperty("--p", p.toFixed(4));
        show(Math.min(steps.length - 1, Math.floor(p * steps.length)));
      });
    },
    disable() {
      if (!stop) return;
      stop();
      stop = null;
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
  let stop = null;
  let loading = false;
  let resizeObserver = null;

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

  // Load a coarse set of angles first so scrubbing works early, then fill in the rest.
  function preload() {
    if (loading) return;
    loading = true;
    const order = [];
    for (const step of [18, 6, 3, 1]) {
      for (let i = 0; i < FRAME_COUNT; i += step) if (!order.includes(i)) order.push(i);
    }
    let next = 0;
    const pump = () => {
      if (next >= order.length) return;
      const i = order[next++];
      const image = new Image();
      image.decoding = "async";
      image.onload = image.onerror = () => { draw(); pump(); };
      image.src = framePath(i);
      frames[i] = image;
    };
    for (let lane = 0; lane < 4; lane += 1) pump();
  }

  const nearObserver = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && stop) preload();
  }, { rootMargin: "150% 0px" });

  return {
    enable() {
      if (stop) return;
      section.classList.add("is-scrub");
      resizeObserver = new ResizeObserver(sizeCanvas);
      resizeObserver.observe(figure);
      nearObserver.observe(section);
      stop = trackProgress(track, (p) => {
        wanted = Math.round(p * (FRAME_COUNT - 1));
        draw();
        const active = Math.min(notes.length - 1, Math.floor(p * notes.length));
        notes.forEach((note, i) => note.classList.toggle("is-active", i === active));
      });
    },
    disable() {
      if (!stop) return;
      stop();
      stop = null;
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

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const apply = () => scenes.forEach((scene) => (reduce.matches ? scene.disable() : scene.enable()));
  reduce.addEventListener?.("change", apply);
  apply();
}
