// FlightList core: checklist parser, runner state machine and spoken-text rewriting.
// No DOM access here, so it also runs under Node for the tests (tools/test_web_core.js).
(function (global) {
  "use strict";

  class ChecklistParseError extends Error {
    constructor(line, message) {
      super(`Line ${line}: ${message}`);
      this.line = line;
    }
  }

  function slug(s) {
    return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  }

  /// Parses the plain-text `.checklist` format:
  ///
  ///     # Aircraft name
  ///     @variant Airline or style        (optional, default "Standard")
  ///     @match A320, Airbus A32          (accepted for compatibility, unused on the web)
  ///     ## Phase title                   ("## ! Title" marks an emergency procedure)
  ///     CHALLENGE | RESPONSE             (a third "| sim: …" column is accepted and ignored)
  ///     > Note shown as a header, read aloud, no check needed
  ///     // comment
  function parseChecklist(text, sourceName = "") {
    let aircraft = null;
    let variant = "Standard";
    const phases = [];

    let phaseTitle = null;
    let phaseEmergency = false;
    let phaseLine = 0;
    let steps = [];

    function closePhase() {
      if (phaseTitle === null) return;
      if (!steps.some((s) => s.type === "item")) {
        throw new ChecklistParseError(phaseLine, `Phase "${phaseTitle}" has no items`);
      }
      const base = (phaseEmergency ? "emg-" : "") + slug(phaseTitle);
      let id = base;
      for (let n = 2; phases.some((p) => p.id === id); n++) id = `${base}-${n}`;
      steps.forEach((s, idx) => { if (s.type === "item") s.id = `${id}#${idx}`; });
      phases.push({ id, title: phaseTitle, isEmergency: phaseEmergency, steps,
                    items: steps.filter((s) => s.type === "item") });
      phaseTitle = null;
      steps = [];
    }

    text.split(/\r\n|\r|\n/).forEach((rawLine, offset) => {
      const lineNo = offset + 1;
      let line = rawLine;
      const comment = line.indexOf("//");
      if (comment >= 0) line = line.slice(0, comment);
      line = line.trim();
      if (!line) return;

      if (line.startsWith("## ") || line === "##") {
        closePhase();
        let title = line.slice(2).trim();
        phaseEmergency = title.startsWith("!");
        if (phaseEmergency) title = title.slice(1).trim();
        if (!title) throw new ChecklistParseError(lineNo, "Phase title is empty");
        if (aircraft === null) throw new ChecklistParseError(lineNo, 'Phase before the "# Aircraft" line');
        phaseTitle = title;
        phaseLine = lineNo;
      } else if (line.startsWith("# ")) {
        if (aircraft !== null) throw new ChecklistParseError(lineNo, "Second aircraft name");
        aircraft = line.slice(2).trim();
      } else if (line.startsWith("@variant")) {
        variant = line.slice("@variant".length).trim();
      } else if (line.startsWith("@match")) {
        // Sim aircraft detection isn't part of the web app.
      } else if (line.startsWith("@")) {
        throw new ChecklistParseError(lineNo, `Unknown directive ${line.split(" ")[0]}`);
      } else if (line.startsWith(">")) {
        if (phaseTitle === null) throw new ChecklistParseError(lineNo, "Note outside a phase");
        steps.push({ type: "note", text: line.slice(1).trim() });
      } else {
        if (phaseTitle === null) throw new ChecklistParseError(lineNo, "Item outside a phase");
        // Split into at most 3 columns so "||" inside a sim: condition stays intact.
        const first = line.indexOf("|");
        const second = first < 0 ? -1 : line.indexOf("|", first + 1);
        const cols = first < 0 ? [line]
          : second < 0 ? [line.slice(0, first), line.slice(first + 1)]
          : [line.slice(0, first), line.slice(first + 1, second), line.slice(second + 1)];
        const [challenge, response, extra] = cols.map((c) => c.trim());
        if (cols.length < 2 || !challenge || !response) {
          throw new ChecklistParseError(lineNo, 'Expected "CHALLENGE | RESPONSE"');
        }
        if (extra !== undefined && !extra.toLowerCase().startsWith("sim:")) {
          throw new ChecklistParseError(lineNo, 'Third column must start with "sim:"');
        }
        steps.push({ type: "item", id: "", challenge, response });
      }
    });
    closePhase();

    if (aircraft === null) throw new ChecklistParseError(1, 'Missing "# Aircraft name" line');
    if (!phases.length) throw new ChecklistParseError(1, 'No phases ("## Phase") found');
    return {
      id: `${aircraft}|${variant}`,
      aircraft,
      variant,
      phases,
      normalPhases: phases.filter((p) => !p.isEmergency),
      emergencyPhases: phases.filter((p) => p.isEmergency),
      sourceName,
      isBundled: true,
    };
  }

  /// Groups bundled + imported files into aircraft. An imported file with the same aircraft + variant replaces
  /// the bundled one.
  function buildLibrary(bundledFiles, importedFiles) {
    const byID = new Map();
    const errors = [];
    const load = (file, bundled) => {
      try {
        const v = parseChecklist(file.text, file.name);
        v.isBundled = bundled;
        byID.delete(v.id); // re-insert so replacement keeps the newest order
        byID.set(v.id, v);
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`);
      }
    };
    bundledFiles.forEach((f) => load(f, true));
    importedFiles.forEach((f) => load(f, false));

    const groupsByName = new Map();
    for (const v of byID.values()) {
      if (!groupsByName.has(v.aircraft)) groupsByName.set(v.aircraft, []);
      groupsByName.get(v.aircraft).push(v);
    }
    const groups = [...groupsByName.entries()]
      .map(([name, variants]) => ({ name, variants }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { groups, variants: [...byID.values()], errors };
  }

  // MARK: - Runner

  /// The checklist state machine. Knows nothing about speech or the DOM: the app calls its commands and it
  /// reports what to say via `onAnnounce`.
  ///
  /// mode: { kind: "running" } | { kind: "phaseComplete", next: phaseID|null } | { kind: "emergencyComplete" }
  class Runner {
    constructor(variant, snapshot = null) {
      this.variant = variant;
      this.onAnnounce = null;
      this.resetFlight();
      if (snapshot) this.restore(snapshot);
    }

    restore(s) {
      const phase = this.variant.phases.find((p) => p.id === s.position?.phaseID);
      if (s.variantID !== this.variant.id || !phase || !(s.position.stepIndex in phase.steps)) return false;
      this.position = { ...s.position };
      this.mode = s.mode || { kind: "running" };
      this.checked = new Set(s.checked || []);
      this.completedPhases = new Set(s.completedPhases || []);
      this.returnPoint = s.returnPoint || null;
      this.returnMode = s.returnMode || null;
      return true;
    }

    get snapshot() {
      return {
        variantID: this.variant.id,
        position: this.position,
        mode: this.mode,
        checked: [...this.checked],
        completedPhases: [...this.completedPhases],
        returnPoint: this.returnPoint,
        returnMode: this.returnMode,
      };
    }

    // Derived state

    phaseByID(id) { return this.variant.phases.find((p) => p.id === id); }
    get phase() { return this.phaseByID(this.position.phaseID) || this.variant.phases[0]; }
    get isInEmergency() { return this.phase.isEmergency; }
    get hasProgress() { return this.checked.size > 0 || this.completedPhases.size > 0; }

    get currentItem() {
      if (this.mode.kind !== "running") return null;
      const step = this.phase.steps[this.position.stepIndex];
      return step && step.type === "item" ? step : null;
    }

    /// The closest note above the current item within the same phase (shown as a banner).
    get currentNote() {
      if (this.mode.kind !== "running") return null;
      for (let i = this.position.stepIndex - 1; i >= 0; i--) {
        const s = this.phase.steps[i];
        if (s.type === "note") return s.text;
      }
      return null;
    }

    get progress() {
      const items = this.phase.items;
      if (!items.length) return 0;
      if (this.mode.kind !== "running") return 1;
      const done = this.phase.steps.slice(0, this.position.stepIndex).filter((s) => s.type === "item").length;
      return done / items.length;
    }

    get nextNormalPhase() {
      const normals = this.variant.normalPhases;
      const idx = normals.findIndex((p) => p.id === this.position.phaseID);
      return idx >= 0 && idx + 1 < normals.length ? normals[idx + 1] : null;
    }

    get previousNormalPhase() {
      const normals = this.variant.normalPhases;
      const idx = normals.findIndex((p) => p.id === this.position.phaseID);
      return idx > 0 ? normals[idx - 1] : null;
    }

    /// "done" | "partial" | "notStarted"
    phaseStatus(phase) {
      if (this.completedPhases.has(phase.id)) return "done";
      if (phase.items.some((i) => this.checked.has(i.id))) return "partial";
      return "notStarted";
    }

    // Commands

    /// Begin (or re-begin) at the start of `phaseID`.
    start(phaseID) {
      const p = this.phaseByID(phaseID);
      if (!p) return;
      if (p.isEmergency) return this.startEmergency(phaseID);
      this.returnPoint = null;
      this.returnMode = null;
      this.position = { phaseID, stepIndex: 0 };
      this.mode = { kind: "running" };
      this.announce({ type: "phaseStart", title: p.title });
      this.enter(0);
    }

    /// Announce whatever the user is currently on (used when the runner screen appears, and for "repeat").
    announceCurrent() {
      switch (this.mode.kind) {
        case "running": {
          const prev = this.phase.steps[this.position.stepIndex - 1];
          if (prev && prev.type === "note") this.announce({ type: "note", text: prev.text });
          if (this.currentItem) this.announce({ type: "item", item: this.currentItem });
          break;
        }
        case "phaseComplete":
          this.announce({ type: "phaseComplete", title: this.phase.title,
                          next: this.mode.next ? this.phaseByID(this.mode.next)?.title : null });
          break;
        case "emergencyComplete":
          this.announce({ type: "emergencyComplete", title: this.phase.title });
          break;
      }
    }

    check() { this.advance(true); }
    skip() { this.advance(false); }
    repeatCurrent() { this.announceCurrent(); }

    back() {
      if (this.mode.kind !== "running") {
        this.mode = { kind: "running" };
        const last = this.lastItemIndex(this.phase, this.phase.steps.length);
        if (last !== null) this.setCurrent(last);
        return;
      }
      const prev = this.lastItemIndex(this.phase, this.position.stepIndex);
      if (prev !== null) {
        this.setCurrent(prev);
        return;
      }
      const prevPhase = this.isInEmergency ? null : this.previousNormalPhase;
      const last = prevPhase && this.lastItemIndex(prevPhase, prevPhase.steps.length);
      if (prevPhase && last !== null) {
        this.position = { phaseID: prevPhase.id, stepIndex: last };
        this.completedPhases.delete(prevPhase.id);
        this.announce({ type: "phaseStart", title: prevPhase.title });
        this.setCurrent(last);
      }
    }

    startEmergency(phaseID) {
      const p = this.phaseByID(phaseID);
      if (!p || !p.isEmergency) return;
      if (!this.isInEmergency) {
        this.returnPoint = { ...this.position };
        this.returnMode = this.mode;
      }
      // Emergency procedures are always run fresh.
      p.items.forEach((i) => this.checked.delete(i.id));
      this.completedPhases.delete(p.id);
      this.position = { phaseID: p.id, stepIndex: 0 };
      this.mode = { kind: "running" };
      this.announce({ type: "emergencyStart", title: p.title });
      this.enter(0);
    }

    /// Leave the emergency procedure (finished or not) and return to the saved point.
    resumeFromEmergency() {
      const rp = this.returnPoint;
      const p = rp && this.phaseByID(rp.phaseID);
      this.returnPoint = null;
      if (!p) {
        const first = this.variant.normalPhases[0];
        if (this.isInEmergency && first) this.start(first.id);
        return;
      }
      this.position = { ...rp };
      this.mode = this.returnMode || { kind: "running" };
      this.returnMode = null;
      this.announce({ type: "resumed", title: p.title });
      if (this.mode.kind === "running" && this.currentItem) {
        this.announce({ type: "item", item: this.currentItem });
      } else {
        this.announceCurrent();
      }
    }

    /// Clears all progress for a new flight and goes back to the first phase (silently).
    resetFlight() {
      this.checked = new Set();
      this.completedPhases = new Set();
      this.returnPoint = null;
      this.returnMode = null;
      this.mode = { kind: "running" };
      const first = this.variant.normalPhases[0] || this.variant.phases[0];
      const firstItem = first.steps.findIndex((s) => s.type === "item");
      this.position = { phaseID: first.id, stepIndex: Math.max(0, firstItem) };
    }

    // Internals

    announce(a) { if (this.onAnnounce) this.onAnnounce(a); }

    lastItemIndex(phase, end) {
      for (let i = end - 1; i >= 0; i--) if (phase.steps[i].type === "item") return i;
      return null;
    }

    advance(markChecked) {
      switch (this.mode.kind) {
        case "running": {
          const item = this.currentItem;
          if (!item) return;
          if (markChecked) this.checked.add(item.id);
          this.enter(this.position.stepIndex + 1);
          break;
        }
        case "phaseComplete":
          if (this.mode.next) this.start(this.mode.next);
          break;
        case "emergencyComplete":
          this.resumeFromEmergency();
          break;
      }
    }

    /// Move to the first item at or after `index`, announcing notes on the way. Completes the phase at the end.
    enter(index) {
      const steps = this.phase.steps;
      for (let i = index; i < steps.length; i++) {
        if (steps[i].type === "note") {
          this.announce({ type: "note", text: steps[i].text });
        } else {
          this.setCurrent(i);
          return;
        }
      }
      this.completeCurrentPhase();
    }

    setCurrent(index) {
      this.position = { ...this.position, stepIndex: index };
      this.mode = { kind: "running" };
      const step = this.phase.steps[index];
      if (step.type === "item") this.announce({ type: "item", item: step });
    }

    completeCurrentPhase() {
      const phase = this.phase;
      this.completedPhases.add(phase.id);
      this.position = { ...this.position, stepIndex: Math.max(0, phase.steps.length - 1) };
      if (phase.isEmergency) {
        this.mode = { kind: "emergencyComplete" };
        this.announce({ type: "emergencyComplete", title: phase.title });
      } else {
        const next = this.nextNormalPhase;
        this.mode = { kind: "phaseComplete", next: next ? next.id : null };
        this.announce({ type: "phaseComplete", title: phase.title, next: next ? next.title : null });
      }
    }
  }

  // MARK: - Spoken form

  const wordReplacements = [
    ["T/O", "takeoff"], ["TO/GA", "toga"], ["TA/RA", "T A, R A"], ["KIAS", "knots"], ["KTS", "knots"],
    ["CHK", "check"], ["ADJ", "adjust"], ["REQ'D", "required"], ["PAX", "passengers"],
    ["NOTAMS", "notams"], ["ATIS", "atis"], ["ADIRS", "A-DIRS"], ["FCU", "F C U"], ["MCDU", "M C D U"],
    ["FMC", "F M C"], ["ECAM", "ecam"], ["STS", "status"], ["TOD", "top of descent"],
    ["DME", "D M E"], ["ILS", "I L S"], ["LS", "L S"], ["HDG", "heading"],
    ["RWY", "runway"], ["DU", "display unit"], ["STD", "standard"], ["MAX", "max"],
    ["TFC", "traffic"], ["CMD", "command"], ["ATC", "A T C"], ["ELT", "E L T"], ["APU", "A P U"],
    ["GPU", "G P U"], ["IRS", "I R S"], ["MCP", "M C P"], ["LNAV", "L nav"], ["VNAV", "V nav"],
    ["PIREP", "pilot report"], ["CLB", "climb"], ["ASAP", "as soon as possible"], ["QTS", "quarts"],
    ["RPM", "R P M"], ["HPA", "hectopascals"], ["V1", "V one"], ["VR", "V R"], ["V2", "V two"],
    ["AP1", "autopilot one"], ["N1", "N one"], ["N2", "N two"], ["ENG", "engine"], ["&", "and"],
  ].map(([word, spoken]) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const b0 = /[A-Za-z0-9]/.test(word[0]) ? "\\b" : "";
    const b1 = /[A-Za-z0-9]/.test(word[word.length - 1]) ? "\\b" : "";
    return [new RegExp(b0 + escaped + b1, "g"), spoken];
  });

  const digitWords = { 0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
                       6: "six", 7: "seven", 8: "eight", 9: "niner" };

  /// Text shown on screen stays as written; only the spoken form is rewritten.
  function spoken(text) {
    let s = text;
    s = s.replace(/FL(\d{2,3})/g, (_, d) => "flight level " + [...d].map((c) => digitWords[c]).join(" "));
    s = s.replace(/(\d)\s*[–-]\s*(\d)/g, "$1 to $2");
    s = s.replace(/(\d)\s*°/g, "$1 degrees");
    s = s.replace(/(\d+)%/g, "$1 percent");
    for (const [re, sp] of wordReplacements) s = s.replace(re, sp);
    s = s.replace(/\//g, ", ");
    // All-caps text is read letter-by-letter by some voices; lower case reads naturally.
    return s.toLowerCase();
  }

  /// What to say for each runner announcement.
  function announcementText(a, readResponse) {
    switch (a.type) {
      case "note": return a.text;
      case "item": return readResponse ? `${a.item.challenge}. ${a.item.response}.` : `${a.item.challenge}.`;
      case "phaseStart": return `${a.title} checklist.`;
      case "phaseComplete":
        return a.next ? `${a.title} checklist complete. Next, ${a.next} checklist. Tap check to begin.`
                      : `${a.title} checklist complete. All checklists complete.`;
      case "emergencyStart": return `Emergency. ${a.title}.`;
      case "emergencyComplete": return `${a.title} complete. Tap check to resume the normal checklist.`;
      case "resumed": return `Resuming ${a.title}.`;
    }
    return "";
  }

  const api = { parseChecklist, buildLibrary, Runner, spoken, announcementText, ChecklistParseError };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.FlightCore = api;
})(typeof window !== "undefined" ? window : globalThis);
