// FlightList web app: screens, speech, persistence. Logic lives in core.js.
(function () {
  "use strict";
  const { buildLibrary, Runner, spoken, announcementText, parseChecklist } = window.FlightCore;

  // MARK: - Storage (every access guarded: private windows or blocked storage must not break the app)

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  const settings = Object.assign(
    { speak: true, voiceURI: "", rate: 1.0, readResponse: true, keepAwake: true },
    store.get("settings", {}),
  );
  const saveSettings = () => store.set("settings", settings);

  // MARK: - Speech

  /// Reads checklist text aloud with the browser's speech engine (Google TTS on Android Chrome).
  const speaker = {
    synth: window.speechSynthesis || null,
    queue: [],
    timer: null,
    cancelledAt: 0,

    /// English voices, most natural first.
    voices() {
      if (!this.synth) return [];
      const score = (v) => {
        let s = 0;
        if (/natural|neural|premium|enhanced|online/i.test(v.name)) s += 300;
        if (/google/i.test(v.name)) s += 100;
        if (v.lang === "en-US" || v.lang === "en_US") s += 20;
        else if (/en[-_]GB/.test(v.lang)) s += 15;
        if (v.localService) s += 5; // works offline
        return s;
      };
      return this.synth.getVoices().filter((v) => /^en/i.test(v.lang)).sort((a, b) => score(b) - score(a));
    },

    pickVoice() {
      const all = this.voices();
      return all.find((v) => v.voiceURI === settings.voiceURI) || all[0] || null;
    },

    say(text) {
      if (!this.synth || !settings.speak || !text) return;
      const u = new SpeechSynthesisUtterance(spoken(text));
      const voice = this.pickVoice();
      if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = "en-US"; }
      u.rate = settings.rate;
      this.queue.push(u);
      // Chrome can drop an utterance spoken right after cancel(); give it a moment.
      if (!this.timer) {
        const delay = Date.now() - this.cancelledAt < 150 ? 120 : 0;
        this.timer = setTimeout(() => {
          this.timer = null;
          const q = this.queue;
          this.queue = [];
          q.forEach((x) => this.synth.speak(x));
        }, delay);
      }
    },

    stop() {
      this.queue = [];
      clearTimeout(this.timer);
      this.timer = null;
      if (this.synth && (this.synth.speaking || this.synth.pending)) {
        this.synth.cancel();
        this.cancelledAt = Date.now();
      }
    },
  };
  if (speaker.synth) speaker.synth.addEventListener?.("voiceschanged", () => { if (modal?.type === "settings") render(); });

  // MARK: - Keep the screen awake

  let wakeLock = null;
  async function updateWakeLock() {
    const want = settings.keepAwake && document.visibilityState === "visible" && route.name === "run";
    try {
      if (want && !wakeLock && "wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch { wakeLock = null; /* not allowed right now (e.g. not HTTPS); retried on the next tap */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveProgress();
    updateWakeLock();
  });

  // MARK: - Library

  let library;
  function loadLibrary() {
    library = buildLibrary(window.BUNDLED_CHECKLISTS || [], store.get("imported", []));
  }
  const variantByID = (id) => library.variants.find((v) => v.id === id);
  const groupFor = (variant) => library.groups.find((g) => g.name === variant.aircraft);

  function lastVariant(group) {
    const id = store.get(`lastVariant.${group.name}`, null);
    return group.variants.find((v) => v.id === id) || group.variants[0];
  }

  // MARK: - Runner wiring

  let runner = null;

  function makeRunner(variant) {
    speaker.stop();
    const snap = store.get("progress", null);
    runner = new Runner(variant, snap && snap.variantID === variant.id ? snap : null);
    runner.onAnnounce = (a) => speaker.say(announcementText(a, settings.readResponse));
  }

  function saveProgress() {
    if (runner) store.set("progress", runner.snapshot);
  }

  function select(variant, { replace = false } = {}) {
    store.set("lastVariant", variant.id);
    store.set(`lastVariant.${variant.aircraft}`, variant.id);
    if (!runner || runner.variant.id !== variant.id) makeRunner(variant);
    navigate(`#/phases/${encodeURIComponent(variant.id)}`, replace);
  }

  function startRunner(phaseID) {
    speaker.stop();
    runner.start(phaseID);
    saveProgress();
    navigate("#/run");
  }

  function startEmergency(phaseID) {
    speaker.stop();
    modal = null;
    runner.startEmergency(phaseID);
    saveProgress();
    if (route.name !== "run") navigate("#/run"); else render();
  }

  function command(name) {
    if (!runner || route.name !== "run") return;
    speaker.stop();
    switch (name) {
      case "check": runner.check(); break;
      case "skip": runner.skip(); break;
      case "back": runner.back(); break;
      case "repeat": runner.repeatCurrent(); break;
      case "exitEmergency": runner.resumeFromEmergency(); break;
      case "emergency":
        if (!runner.variant.emergencyPhases.length) return;
        modal = { type: "emergency" };
        speaker.say("Select emergency procedure");
        break;
    }
    saveProgress();
    render();
  }

  // MARK: - Routing (hash based, so Android's back gesture works)

  let route = { name: "home" };
  let modal = null;

  function parseRoute() {
    const h = location.hash;
    if (h.startsWith("#/phases/")) {
      const v = variantByID(decodeURIComponent(h.slice("#/phases/".length)));
      if (v) {
        if (!runner || runner.variant.id !== v.id) {
          makeRunner(v);
          store.set("lastVariant", v.id);
        }
        return { name: "phases", variant: v };
      }
    } else if (h === "#/run" && runner) {
      return { name: "run" };
    }
    return { name: "home" };
  }

  function navigate(hash, replace = false) {
    if (location.hash === hash) { onRoute(); return; }
    if (replace) { location.replace(hash); } else { location.hash = hash; }
  }

  function onRoute() {
    const prev = route.name;
    route = parseRoute();
    modal = null;
    if (prev === "run" && route.name !== "run") speaker.stop();
    if (route.name === "home" && location.hash && location.hash !== "#/") history.replaceState(null, "", "#/");
    render();
    window.scrollTo(0, 0);
    updateWakeLock();
  }
  window.addEventListener("hashchange", onRoute);

  // MARK: - Rendering helpers

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const ICONS = {
    plane: '<path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z" fill="currentColor" stroke="none"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    checkCircle: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M7 12.5l3.2 3.2L17 9" stroke="#000"/>',
    half: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    chev: '<path d="M9 5l7 7-7 7"/>',
    updown: '<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>',
    speaker: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    skip: '<path d="M5 5l8 7-8 7zM13 5l8 7-8 7z" fill="currentColor"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/>',
    warn: '<path d="M12 3L1.8 20.5h20.4z" fill="currentColor" stroke="none"/><path d="M12 10v4.5M12 17.3v.2" stroke="#000"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
    play: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M10 8l6 4-6 4z" fill="#000" stroke="none"/>',
    uturn: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 3.5v5h5"/>',
    info: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 11v6M12 7.3v.2" stroke="#000"/>',
    skipped: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l4 3.5-4 3.5"/>',
    book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3"/>',
  };
  const icon = (name, cls = "") =>
    `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  /// "CHALLENGE ........ RESPONSE" with a dot leader filling the gap.
  const cr = (item) =>
    `<div class="cr" lang="en"><span class="c">${esc(item.challenge)}</span><span class="leader"></span><span class="r">${esc(item.response)}</span></div>`;

  const statusIcon = (status) =>
    `<span class="status st-${status}">${icon(status === "done" ? "checkCircle" : status === "partial" ? "half" : "circle")}</span>`;

  // MARK: - Screens

  function homeScreen() {
    const r = runner;
    const resume = r && r.hasProgress ? `
      <button class="resume" data-action="resume">
        <span class="big">${icon("play")}</span>
        <span class="grow">
          <div class="label">UÇUŞA DEVAM ET</div>
          <div class="what">${esc(r.variant.aircraft)} · ${esc(r.phase.title)}</div>
          ${r.currentItem ? `<div class="item">${esc(r.currentItem.challenge)}</div>` : ""}
        </span>
        <span class="chev">${icon("chev")}</span>
      </button>` : "";

    const cards = library.groups.map((g, gi) => {
      const v = lastVariant(g);
      const items = v.normalPhases.reduce((n, p) => n + p.items.length, 0);
      return `
        <button class="card" data-action="group" data-index="${gi}">
          <span class="plane">${icon("plane")}</span>
          <h2>${esc(g.name)}</h2>
          <div class="variants">${g.variants.map((x) => esc(x.variant)).join(" · ")}</div>
          <div class="stats">
            <span class="stat"><b>${v.normalPhases.length}</b><span>aşama</span></span>
            <span class="stat"><b>${items}</b><span>madde</span></span>
            ${v.emergencyPhases.length ? `<span class="stat red"><b>${v.emergencyPhases.length}</b><span>acil durum</span></span>` : ""}
          </div>
        </button>`;
    }).join("");

    const errors = library.errors.length ? `
      <div class="errors">
        <h3>Bazı kontrol listesi dosyaları okunamadı</h3>
        ${library.errors.map((e) => `<div>${esc(e)}</div>`).join("")}
      </div>` : "";

    return `
      <div class="screen">
        <div class="header">
          <div class="grow">
            <h1 class="title">FlightList</h1>
            <div class="subtitle">MSFS 2024 için sesli kontrol listesi yardımcısı</div>
          </div>
          <button class="icon-btn" data-action="glossary">${icon("book")}Sözlük</button>
          <button class="icon-btn" data-action="import">${icon("download")}İçe aktar</button>
          <button class="icon-btn only-icon" data-action="settings" aria-label="Ayarlar">${icon("gear")}</button>
        </div>
        ${resume}
        <div class="eyebrow">Uçak seçin</div>
        <div class="grid">${cards}</div>
        ${errors}
      </div>`;
  }

  function phasesScreen(variant) {
    const group = groupFor(variant);
    const switcher = group && group.variants.length > 1
      ? `<button class="variant-switch" data-action="variants">${esc(variant.variant)} ${icon("updown")}</button>`
      : `<div class="variant-name">${esc(variant.variant)}</div>`;

    const rows = variant.normalPhases.map((p, i) => {
      const status = runner.phaseStatus(p);
      const isCurrent = runner.position.phaseID === p.id;
      return `
        <button class="phase-row ${isCurrent ? "is-current" : ""}" data-action="phase" data-id="${esc(p.id)}">
          <span class="num">${String(i + 1).padStart(2, "0")}</span>
          ${statusIcon(status)}
          <span class="name">${esc(p.title)}</span>
          ${isCurrent && status !== "done" ? '<span class="pill">ŞU AN</span>' : ""}
          <span class="grow"></span>
          <span class="count">${p.items.length} madde</span>
          <span class="chev">${icon("chev")}</span>
        </button>`;
    }).join("");

    const emergencies = variant.emergencyPhases.length ? `
      <div class="eyebrow red">Acil durum prosedürleri</div>
      <div class="emg-grid">
        ${variant.emergencyPhases.map((p) => `
          <button class="emg-btn" data-action="emergencyPhase" data-id="${esc(p.id)}">${icon("warn")}${esc(p.title)}</button>`).join("")}
      </div>` : "";

    return `
      <div class="screen">
        <button class="back-link" data-action="home">${icon("back")}Uçaklar</button>
        <div class="header">
          <div class="grow">
            <h1 class="title">${esc(variant.aircraft)}</h1>
            ${switcher}
          </div>
          <button class="icon-btn" data-action="newFlight">${icon("reset")}Yeni uçuş</button>
        </div>
        <div class="eyebrow">Nereden başlamak istersiniz?</div>
        <div class="phase-list">${rows}</div>
        ${emergencies}
      </div>`;
  }

  function runnerScreen() {
    const r = runner;
    const emg = r.isInEmergency;
    const topButton = emg
      ? `<button class="emg-top exit" data-action="exitEmergency">${icon("uturn")}Acil durumdan çık</button>`
      : r.variant.emergencyPhases.length
        ? `<button class="emg-top" data-action="emergency">${icon("warn")}ACİL DURUM</button>` : "";

    let main;
    if (r.mode.kind === "running") {
      const steps = r.phase.steps;
      const idx = r.position.stepIndex;
      const previous = steps.slice(0, idx).reverse().find((s) => s.type === "item");
      const upcoming = steps.slice(idx + 1, idx + 5);
      const item = r.currentItem;
      const n = item ? r.phase.items.indexOf(item) + 1 : 0;
      main = `
        ${previous ? `<div class="row-dim prev">
          <span class="mark ${r.checked.has(previous.id) ? "checked" : "skipped"}">${icon(r.checked.has(previous.id) ? "checkCircle" : "skipped")}</span>
          ${cr(previous)}</div>` : ""}
        ${r.currentNote ? `<div class="note-banner">${icon("info")}<span>${esc(r.currentNote)}</span></div>` : ""}
        ${item ? `<div class="current" data-key="${esc(item.id)}">
          <div class="count">MADDE ${n} / ${r.phase.items.length}</div>
          ${cr(item)}
          <div class="hint">Onaylamak için ekranda herhangi bir yere dokunun</div>
        </div>` : ""}
        <div class="upcoming">
          ${upcoming.map((s, i) => `<div style="opacity:${1 - i * 0.2}">${s.type === "item" ? cr(s) : `<div class="note">${esc(s.text)}</div>`}</div>`).join("")}
        </div>`;
    } else if (r.mode.kind === "phaseComplete") {
      const next = r.mode.next ? r.phaseByID(r.mode.next) : null;
      main = completeCard(r.phase.title, next ? `Sıradaki: ${next.title}` : "Tüm kontrol listeleri tamamlandı",
                          next ? "Devam etmek için dokunun" : null, "var(--green)");
    } else {
      main = completeCard(r.phase.title, "Acil durum prosedürü bitti",
                          "Normal kontrol listesine dönmek için dokunun", "var(--red)");
    }

    return `
      <div class="runner ${emg ? "emergency" : ""}">
        <div class="topbar">
          ${emg ? "" : `<button class="icon-btn only-icon" data-action="toPhases" aria-label="Aşamalar">${icon("back")}</button>`}
          <div class="grow">
            <div class="kicker">${emg ? "ACİL DURUM PROSEDÜRÜ" : "KONTROL LİSTESİ"} <span class="aircraft">· ${esc(r.variant.aircraft)}</span></div>
            <h1 lang="en">${esc(r.phase.title)}</h1>
          </div>
          <button class="icon-btn" data-action="glossary">${icon("book")}Sözlük</button>
          ${topButton}
        </div>
        <div class="progress"><div style="width:${(r.progress * 100).toFixed(1)}%"></div></div>
        <div class="main-area" data-action="check" role="button" aria-label="Onayla">${main}</div>
        <div class="controls">
          <button class="big-btn" data-action="back">${icon("back")}Geri</button>
          <button class="big-btn" data-action="repeat">${icon("speaker")}Tekrarla</button>
          <button class="big-btn" data-action="skip">${icon("skip")}Atla</button>
          <button class="big-btn" data-action="phaseMenu">${icon("list")}Aşamalar</button>
          <button class="big-btn check" data-action="check">${icon("check")}Onayla</button>
        </div>
      </div>`;
  }

  function completeCard(title, subtitle, hint, color) {
    return `
      <div class="complete">
        <div class="big" style="color:${color}">${icon("checkCircle")}</div>
        <h2><span lang="en">${esc(title)}</span> tamamlandı</h2>
        <div class="sub" style="color:${color}">${esc(subtitle)}</div>
        ${hint ? `<div class="hint">${esc(hint)}</div>` : ""}
      </div>`;
  }

  // MARK: - Modals

  function modalHTML() {
    if (!modal) return "";
    let body = "";
    switch (modal.type) {
      case "variants": {
        const g = modal.group;
        body = `<h2>Kontrol listesi seçin</h2><div class="list">
          ${g.variants.map((v, i) => `<button class="opt" data-action="pickVariant" data-index="${i}">
            <span class="grow">${esc(v.variant)}</span>${runner && runner.variant.id === v.id ? icon("check") : ""}</button>`).join("")}
          </div>`;
        break;
      }
      case "emergency":
        body = `<h2>Acil durum prosedürleri</h2><div class="list">
          ${runner.variant.emergencyPhases.map((p) => `<button class="opt red" data-action="emergencyPhase" data-id="${esc(p.id)}">${icon("warn")}${esc(p.title)}</button>`).join("")}
          </div>`;
        break;
      case "phaseMenu":
        body = `<h2>Aşamaya git</h2><div class="list">
          ${runner.variant.normalPhases.map((p) => `<button class="opt" data-action="jumpPhase" data-id="${esc(p.id)}">
            ${statusIcon(runner.phaseStatus(p))}<span class="grow">${esc(p.title)}</span></button>`).join("")}
          </div>`;
        break;
      case "confirmNewFlight":
        body = `<h2>Yeni uçuşa başlansın mı?</h2><p>${esc(runner.variant.aircraft)} için işaretlenen tüm maddeler silinecek.</p>
          <div class="actions"><button class="btn" data-action="close">Vazgeç</button>
          <button class="btn danger" data-action="confirmNewFlight">Yeni uçuş</button></div>`;
        break;
      case "message":
        body = `<h2>${esc(modal.title)}</h2><p>${esc(modal.text)}</p>
          <div class="actions"><button class="btn primary" data-action="close">Tamam</button></div>`;
        break;
      case "glossary":
        body = glossaryHTML();
        break;
      case "settings":
        body = settingsHTML();
        break;
    }
    return `<div class="backdrop" data-action="backdrop"><div class="sheet" role="dialog" aria-modal="true">${body}</div></div>`;
  }

  /// Glossary entries whose terms appear as whole words in `text`.
  function glossaryMatches(text) {
    const up = ` ${text.toUpperCase()} `;
    return (window.GLOSSARY || []).filter((e) => e.t.split(" / ").some((term) => {
      const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^A-Z0-9])${pattern}([^A-Z0-9]|$)`).test(up);
    }));
  }

  function glossaryHTML() {
    const row = (e) => `<div class="gl-row" data-search="${esc((e.t + " " + e.m).toLocaleLowerCase("tr"))}">
      <div class="gl-term" lang="en">${esc(e.t)}</div><div class="gl-mean">${esc(e.m)}</div></div>`;
    let here = "";
    if (route.name === "run" && runner) {
      const item = runner.currentItem;
      const text = [item?.challenge, item?.response, runner.currentNote].filter(Boolean).join(" ");
      const found = text ? glossaryMatches(text) : [];
      if (found.length) {
        here = `<div class="section-h">Bu maddede</div><div class="gl-here">${found.map(row).join("")}</div>`;
      }
    }
    const groups = [...new Set((window.GLOSSARY || []).map((e) => e.g))];
    return `
      <h2>Havacılık sözlüğü</h2>
      <p class="small">Kontrol listeleri, gerçek kokpitte olduğu gibi İngilizce kalır. Burada anlamlarını bulabilirsiniz.</p>
      ${here}
      <input class="gl-search" type="search" placeholder="Ara (ör. flaps, park freni)" aria-label="Sözlükte ara">
      <div class="gl-all">
        ${groups.map((g) => `<div class="section-h">${esc(g)}</div>${window.GLOSSARY.filter((e) => e.g === g).map(row).join("")}`).join("")}
      </div>
      <div class="actions"><button class="btn primary" data-action="close">Kapat</button></div>`;
  }

  function settingsHTML() {
    const voices = speaker.voices();
    const imported = store.get("imported", []);
    const wakeSupported = "wakeLock" in navigator && window.isSecureContext;
    return `
      <h2>Ayarlar</h2>
      <div class="section-h">Ses</div>
      <div class="field"><label class="toggle">Kontrol listesini sesli oku
        <input type="checkbox" data-setting="speak" ${settings.speak ? "checked" : ""}></label></div>
      <div class="field">
        <label for="voice">Okuyucu ses (İngilizce)</label>
        <select id="voice" data-setting="voiceURI">
          <option value="">Otomatik (en iyi ses)</option>
          ${voices.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === settings.voiceURI ? "selected" : ""}>${esc(v.name)} · ${esc(v.lang)}${v.localService ? "" : " · internet gerekir"}</option>`).join("")}
        </select>
        ${speaker.synth ? "" : '<div class="small">Bu tarayıcıda konuşma motoru yok.</div>'}
        <div class="small">Daha doğal sesler için Android Ayarlar’da “Metin okuma” (Text-to-speech) bölümünü açın, Google Konuşma Hizmetleri’nde İngilizce ses verisini yükleyin ve burada seçin.</div>
      </div>
      <div class="field">
        <label for="rate">Konuşma hızı · ${settings.rate.toFixed(2)}×</label>
        <input id="rate" type="range" min="0.7" max="1.5" step="0.05" value="${settings.rate}" data-setting="rate">
      </div>
      <div class="field"><label class="toggle">Cevabı da oku (ör. “Flaps — up”)
        <input type="checkbox" data-setting="readResponse" ${settings.readResponse ? "checked" : ""}></label></div>
      <div class="field"><button class="btn" data-action="testVoice">Sesi dene</button></div>

      <div class="section-h">Ekran</div>
      <div class="field"><label class="toggle">Kontrol listesi açıkken ekranı açık tut
        <input type="checkbox" data-setting="keepAwake" ${settings.keepAwake ? "checked" : ""}></label>
        ${wakeSupported ? "" : '<div class="small">Uygulamanın HTTPS adresinden açılması (veya yüklenmesi) gerekir.</div>'}
      </div>

      <div class="section-h">İçe aktarılan kontrol listeleri</div>
      ${imported.length ? imported.map((f, i) => `
        <div class="imported"><div class="grow"><div class="file">${esc(f.name)}</div></div>
          <button class="btn" data-action="deleteImported" data-index="${i}">Sil</button></div>`).join("")
        : '<div class="small">Henüz yok.</div>'}
      <div class="small">.checklist dosyası eklemek için başlangıç ekranındaki “İçe aktar” düğmesini kullanın. Aynı uçak ve @variant adına sahip bir dosya, yerleşik listenin yerine geçer.</div>
      <div class="actions"><button class="btn primary" data-action="close">Bitti</button></div>`;
  }

  // MARK: - Render + events

  const appEl = document.getElementById("app");
  const modalEl = document.getElementById("modal-root");

  function render() {
    if (route.name === "phases") appEl.innerHTML = phasesScreen(route.variant);
    else if (route.name === "run") appEl.innerHTML = runnerScreen();
    else appEl.innerHTML = homeScreen();
    modalEl.innerHTML = modalHTML();
  }

  function openModal(m) { modal = m; render(); }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    if (action === "backdrop" && e.target !== el) return; // clicks inside the sheet
    updateWakeLock();

    switch (action) {
      case "home": navigate("#/"); break;
      case "group": {
        const g = library.groups[+el.dataset.index];
        if (g.variants.length > 1) openModal({ type: "variants", group: g });
        else select(g.variants[0]);
        break;
      }
      case "pickVariant": {
        const v = modal.group.variants[+el.dataset.index];
        modal = null;
        select(v, { replace: route.name === "phases" });
        break;
      }
      case "variants": openModal({ type: "variants", group: groupFor(route.variant) }); break;
      case "resume":
        navigate(`#/phases/${encodeURIComponent(runner.variant.id)}`);
        navigate("#/run");
        runner.announceCurrent();
        break;
      case "phase": startRunner(el.dataset.id); break;
      case "emergencyPhase": startEmergency(el.dataset.id); break;
      case "newFlight": openModal({ type: "confirmNewFlight" }); break;
      case "confirmNewFlight":
        speaker.stop();
        runner.resetFlight();
        saveProgress();
        modal = null;
        render();
        break;
      case "toPhases": navigate(`#/phases/${encodeURIComponent(runner.variant.id)}`); break;
      case "phaseMenu": openModal({ type: "phaseMenu" }); break;
      case "jumpPhase":
        modal = null;
        speaker.stop();
        runner.start(el.dataset.id);
        saveProgress();
        render();
        break;
      case "check": case "skip": case "back": case "repeat": case "emergency": case "exitEmergency":
        command(action);
        break;
      case "settings": openModal({ type: "settings" }); break;
      case "glossary": openModal({ type: "glossary" }); break;
      case "testVoice": speaker.stop(); speaker.say("Landing gear. Down, three green."); break;
      case "deleteImported": {
        const list = store.get("imported", []);
        list.splice(+el.dataset.index, 1);
        store.set("imported", list);
        reloadLibrary();
        render();
        break;
      }
      case "import": document.getElementById("import-input").click(); break;
      case "close": case "backdrop": modal = null; render(); break;
    }
  });

  modalEl.addEventListener("change", (e) => {
    const key = e.target.dataset.setting;
    if (!key) return;
    if (e.target.type === "checkbox") settings[key] = e.target.checked;
    else if (key === "rate") settings.rate = parseFloat(e.target.value);
    else settings[key] = e.target.value;
    saveSettings();
    if (key === "speak" && !settings.speak) speaker.stop();
    updateWakeLock();
    render();
  });
  modalEl.addEventListener("input", (e) => {
    if (e.target.classList.contains("gl-search")) {
      const q = e.target.value.trim().toLocaleLowerCase("tr");
      const all = modalEl.querySelector(".gl-all");
      all.querySelectorAll(".gl-row").forEach((r) => { r.hidden = q && !r.dataset.search.includes(q); });
      all.querySelectorAll(".section-h").forEach((h) => { h.hidden = !!q; });
      return;
    }
    if (e.target.dataset.setting === "rate") {
      e.target.previousElementSibling.textContent = `Konuşma hızı · ${parseFloat(e.target.value).toFixed(2)}×`;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal) { modal = null; render(); return; }
    if (route.name !== "run" || modal || e.target.closest("input, select, textarea")) return;
    const map = { " ": "check", Enter: "check", ArrowRight: "skip", ArrowLeft: "back", Backspace: "back", r: "repeat", e: "emergency" };
    const cmd = map[e.key];
    if (cmd) { e.preventDefault(); command(cmd); }
  });

  // MARK: - Import

  function reloadLibrary() {
    loadLibrary();
    if (runner) {
      const v = variantByID(runner.variant.id);
      if (!v) { runner = null; }
      else if (v !== runner.variant) { saveProgress(); makeRunner(v); }
    }
    if (route.name === "phases") route = parseRoute();
  }

  document.getElementById("import-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const v = parseChecklist(text, file.name);
      const list = store.get("imported", []).filter((f) => {
        if (f.name === file.name) return false;
        try { return parseChecklist(f.text).id !== v.id; } catch { return true; }
      });
      list.push({ name: file.name, text });
      store.set("imported", list);
      reloadLibrary();
      openModal({ type: "message", title: "İçe aktarıldı", text: `${v.aircraft} — ${v.variant} (${v.phases.length} aşama)` });
    } catch (err) {
      openModal({ type: "message", title: "İçe aktarılamadı", text: err.message });
    }
  });

  // MARK: - Start

  loadLibrary();
  const lastID = store.get("lastVariant", null);
  const last = lastID && variantByID(lastID);
  if (last) makeRunner(last);
  onRoute();

  if ("serviceWorker" in navigator && window.isSecureContext && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
