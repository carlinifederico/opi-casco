// xr_install.js: install an APK on a Meta Quest plugged into this computer by USB,
// straight from the browser (WebUSB + ADB, no software installed).
//
//   const X = await import("./xr_install.js");
//   if (!X.supported()) alert(X.supported(true).reason);
//   await X.installApk({ file, pkg: "com.threedar.opiseraphine", onStatus: s => console.log(s) });
//
// Libraries: Tango ADB (ya-webadb) from esm.sh, every package pinned, including the
// transitive ones, so the four packages share ONE copy of each dependency
// (stream-extra's Consumable is checked with instanceof across packages).

const ESM = "https://esm.sh/";
const V = {
  adb: "@yume-chan/adb@2.6.4",
  webusb: "@yume-chan/adb-daemon-webusb@2.3.2",
  cred: "@yume-chan/adb-credential-web@2.1.0",
  streams: "@yume-chan/stream-extra@2.6.1",
  struct: "@yume-chan/struct@2.3.2",
  event: "@yume-chan/event@2.0.0",
  async: "@yume-chan/async@4.1.3",
  ndv: "@yume-chan/no-data-view@2.0.0",
};
const q = (...deps) => "?deps=" + deps.join(",") + "&target=es2022";
const ALL = [V.adb, V.streams, V.struct, V.event, V.async, V.ndv];
const URLS = {
  adb: ESM + V.adb + q(V.streams, V.struct, V.event, V.async, V.ndv),
  webusb: ESM + V.webusb + q(...ALL),
  cred: ESM + V.cred + q(...ALL),
  streams: ESM + V.streams + q(V.struct, V.async, V.ndv),
};
export const LIB_VERSIONS = V;

// The ADB interface as defined by Google (Quest uses the same).
const ADB_IFACE = { classCode: 0xff, subclassCode: 0x42, protocolCode: 1 };
const META_VENDOR_ID = 0x2833;
const REMOTE_DIR = "/data/local/tmp/";
const AUTH_PROMPT_MS = 120000; // time to put on the headset and accept the dialog
const HANDSHAKE_MS = 20000; // a silent handshake that takes longer than this is stuck

let libsP = null;
function loadLibs() {
  if (!libsP) {
    libsP = Promise.all([import(URLS.adb), import(URLS.webusb), import(URLS.cred), import(URLS.streams)])
      .then(([adb, webusb, cred, streams]) => ({ adb, webusb, cred, streams }))
      .catch((e) => {
        libsP = null;
        throw xerr("cdn",
          "Could not load the ADB library from esm.sh (offline or blocked?): " + msgOf(e),
          "No se pudo cargar la librería ADB desde esm.sh (¿sin conexión o bloqueado?): " + msgOf(e), e);
      });
  }
  return libsP;
}

// ---------- errors ----------
function msgOf(e) { return (e && (e.message || e.name)) || String(e); }
function xerr(code, en, es, cause) {
  const e = new Error(en);
  e.code = code; e.msg_en = en; e.msg_es = es;
  if (cause) e.cause = cause;
  return e;
}
const isName = (e, n) => !!e && (e.name === n || (e.cause && e.cause.name === n));

const BUSY_EN = "The headset is busy: another program on this computer has claimed its USB/ADB connection. Close adb, Unity, SideQuest and Meta Quest Developer Hub (or run `adb kill-server` in a terminal), then try again.";
const BUSY_ES = "El visor está ocupado: otro programa de esta computadora tomó su conexión USB/ADB. Cerrá adb, Unity, SideQuest y Meta Quest Developer Hub (o corré `adb kill-server` en una terminal) y probá de nuevo.";
const GONE_EN = "The headset disconnected during the transfer. Check the USB cable and try again.";
const GONE_ES = "El visor se desconectó durante la transferencia. Revisá el cable USB y probá de nuevo.";

// ---------- supported() ----------
// supported()      -> boolean
// supported(true)  -> {ok, reason, reason_es}
export function supported(withReason = false) {
  const r = (ok, reason = "", reason_es = "") => (withReason ? { ok, reason, reason_es } : ok);
  if (typeof window === "undefined" || typeof navigator === "undefined")
    return r(false, "Not running in a browser.", "No está corriendo en un navegador.");
  if (/OculusBrowser|Quest/i.test(navigator.userAgent || ""))
    return r(false, "Open this page on the computer the Quest is plugged into, not inside the headset.",
      "Abrí esta página en la computadora donde está enchufado el Quest, no dentro del visor.");
  if (!window.isSecureContext)
    return r(false, "WebUSB needs a secure page (https:// or localhost).",
      "WebUSB necesita una página segura (https:// o localhost).");
  if (!("usb" in navigator) || !navigator.usb)
    return r(false, "This browser has no WebUSB. Use Chrome or Edge on a computer (or Chrome on Android).",
      "Este navegador no tiene WebUSB. Usá Chrome o Edge en una computadora (o Chrome en Android).");
  const pol = document.permissionsPolicy || document.featurePolicy;
  if (pol && typeof pol.allowsFeature === "function" && !pol.allowsFeature("usb"))
    return r(false, "USB is blocked for this frame (embedded page without allow=\"usb\"). Open the hub in its own tab.",
      "El USB está bloqueado en este marco (página embebida sin allow=\"usb\"). Abrí el hub en su propia pestaña.");
  return r(true);
}

// ---------- device selection ----------
function hasAdbInterface(dev) {
  for (const cfg of dev.configurations || [])
    for (const itf of cfg.interfaces || [])
      for (const alt of itf.alternates || [])
        if (alt.interfaceClass === ADB_IFACE.classCode && alt.interfaceSubclass === ADB_IFACE.subclassCode &&
            alt.interfaceProtocol === ADB_IFACE.protocolCode) return true;
  return false;
}

// Must run first in installApk (before any slow await) so requestDevice still has the click's user activation.
async function pickRawDevice() {
  const paired = (await navigator.usb.getDevices()).filter(hasAdbInterface);
  if (paired.length) return paired.find((d) => d.vendorId === META_VENDOR_ID) || paired[0];
  try {
    return await navigator.usb.requestDevice({ filters: [ADB_IFACE] });
  } catch (e) {
    if (isName(e, "NotFoundError"))
      throw xerr("cancelled",
        "No headset selected. If the Quest is not in the list: plug it in with a data USB cable, enable Developer Mode (Meta Horizon app) and put the headset on once to wake it.",
        "No se eligió ningún visor. Si el Quest no aparece en la lista: enchufalo con un cable USB de datos, activá el Modo desarrollador (app Meta Horizon) y ponete el visor una vez para despertarlo.", e);
    if (isName(e, "SecurityError"))
      throw xerr("blocked",
        "The browser blocked the USB chooser. Click the Install button again (it must come from a click).",
        "El navegador bloqueó el selector USB. Volvé a hacer clic en Instalar (tiene que salir de un clic).", e);
    throw e;
  }
}

async function wrapDevice(L, raw) {
  const mgr = L.webusb.AdbDaemonWebUsbDeviceManager.BROWSER;
  const list = await mgr.getDevices();
  const dev = list.find((d) => d.raw === raw) ||
    list.find((d) => raw.serialNumber && d.raw.serialNumber === raw.serialNumber);
  if (!dev) throw xerr("nodevice", "The headset disappeared. Replug the USB cable and try again.",
    "El visor desapareció. Volvé a enchufar el cable USB y probá de nuevo.");
  return dev;
}

// ---------- connect + auth ----------
async function connectAdb(L, dev, status) {
  let connection;
  try {
    connection = await dev.connect();
  } catch (e) {
    if (e instanceof L.webusb.AdbDaemonWebUsbDevice.DeviceBusyError || isName(e, "NetworkError") ||
        isName(e, "SecurityError") || isName(e, "InvalidStateError") || /access denied|claim/i.test(msgOf(e)))
      throw xerr("busy", BUSY_EN, BUSY_ES, e);
    throw e;
  }

  const A = L.adb;
  // Timer that starts short and gets extended when the headset shows the "Allow USB debugging" dialog.
  let timer, rejectT;
  const timeout = new Promise((_, rej) => { rejectT = rej; });
  const arm = (ms, err) => { clearTimeout(timer); timer = setTimeout(() => rejectT(err), ms); };
  const STUCK = xerr("stuck",
    "The headset did not answer. Put it on (so it wakes up), unplug and replug the cable, and try again.",
    "El visor no respondió. Ponételo (para que se despierte), desenchufá y volvé a enchufar el cable, y probá de nuevo.");
  const REFUSED = xerr("auth",
    "USB debugging was not allowed. Put on the headset, accept 'Allow USB debugging' (tick 'Always allow from this computer') and try again.",
    "No se permitió la depuración USB. Ponete el visor, aceptá 'Permitir depuración USB' (marcá 'Permitir siempre desde esta computadora') y probá de nuevo.");
  arm(HANDSHAKE_MS, STUCK);

  // The public-key authenticator only runs when the stored key is not yet trusted:
  // that is exactly when the headset shows its dialog.
  const promptAuth = async function* (store, getNext) {
    for await (const pkt of A.AdbPublicKeyAuthenticator(store, getNext)) {
      arm(AUTH_PROMPT_MS, REFUSED);
      status("auth", null,
        "Put on the headset and accept 'Allow USB debugging' (tick 'Always allow from this computer').",
        "Ponete el visor y aceptá 'Permitir depuración USB' (marcá 'Permitir siempre desde esta computadora').");
      yield pkt;
    }
  };

  try {
    const transport = await Promise.race([
      A.AdbDaemonTransport.authenticate({
        serial: dev.serial,
        connection,
        credentialStore: new L.cred.default("OPI Hub"),
        authenticators: [A.AdbSignatureAuthenticator, promptAuth],
      }),
      timeout,
    ]);
    return new A.Adb(transport);
  } catch (e) {
    try { await dev.raw.close(); } catch {}
    if (e && e.msg_es) throw e;
    if (isName(e, "NetworkError")) throw xerr("gone", GONE_EN, GONE_ES, e);
    throw xerr("auth", REFUSED.msg_en + " (" + msgOf(e) + ")", REFUSED.msg_es + " (" + msgOf(e) + ")", e);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- shell helpers ----------
const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

async function shell(adb, cmd) {
  const sp = adb.subprocess.shellProtocol;
  if (sp) {
    const r = await sp.spawnWaitText(cmd);
    return { out: (r.stdout + r.stderr).trim(), code: r.exitCode };
  }
  const out = await adb.subprocess.noneProtocol.spawnWaitText(cmd);
  return { out: out.trim(), code: null };
}

const PM_HINTS = {
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: ["The installed app was signed with a different key. Uninstall it from the headset first.", "La app instalada está firmada con otra clave. Desinstalala del visor primero."],
  INSTALL_FAILED_VERSION_DOWNGRADE: ["The headset has a newer version of this app. Uninstall it first, or build with a higher versionCode.", "El visor tiene una versión más nueva de esta app. Desinstalala primero o compilá con un versionCode mayor."],
  INSTALL_FAILED_INSUFFICIENT_STORAGE: ["Not enough free space on the headset.", "No hay espacio libre suficiente en el visor."],
  INSTALL_FAILED_OLDER_SDK: ["This APK needs a newer headset OS. Update the Quest.", "Este APK necesita un sistema más nuevo. Actualizá el Quest."],
  INSTALL_FAILED_NO_MATCHING_ABIS: ["This APK was not built for the Quest (wrong CPU architecture, needs arm64).", "Este APK no está compilado para el Quest (arquitectura incorrecta, necesita arm64)."],
  INSTALL_PARSE_FAILED: ["The file is not a valid APK (corrupt or incomplete download).", "El archivo no es un APK válido (corrupto o descarga incompleta)."],
  INSTALL_FAILED_INVALID_APK: ["The file is not a valid APK (corrupt or incomplete download).", "El archivo no es un APK válido (corrupto o descarga incompleta)."],
};

// ---------- installApk ----------
let busy = false;

export async function installApk({ file, url, pkg, activity, onStatus, grant = false } = {}) {
  const status = (stage, pct, msg_en, msg_es, extra) => {
    try { onStatus && onStatus({ stage, pct, msg_en, msg_es, ...extra }); } catch (e) { console.warn("onStatus threw", e); }
  };
  const s = supported(true);
  if (!s.ok) throw xerr("unsupported", s.reason, s.reason_es);
  if (!file && !url) throw xerr("args", "Choose an APK file first.", "Elegí primero un archivo APK.");
  if (!pkg || !/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(pkg))
    throw xerr("args", "Missing or invalid package name (e.g. com.threedar.opiseraphine).",
      "Falta el nombre de paquete o no es válido (p. ej. com.threedar.opiseraphine).");
  if (file) {
    if (!(file instanceof Blob)) throw xerr("args", "`file` must be a File or Blob.", "`file` tiene que ser un File o Blob.");
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer()); // instant; keeps the click's user activation
    if (head[0] !== 0x50 || head[1] !== 0x4b) throw xerr("notapk", "That file is not an APK.", "Ese archivo no es un APK.");
  }
  if (busy) throw xerr("busy_self", "An install is already running.", "Ya hay una instalación en curso.");
  busy = true;

  const libs = loadLibs(); // start downloading the library while the chooser is open
  libs.catch(() => {});
  let adb = null, raw = null, remote = null, pushed = false;
  try {
    // 1-2. Device first: requestDevice needs the click's user activation, which expires after a few seconds.
    status("device", null, "Choose the Quest in the browser's USB list…", "Elegí el Quest en la lista USB del navegador…");
    raw = await pickRawDevice();
    const L = await libs;

    // APK bytes as a stream (never fully in memory).
    let source, total;
    if (file) {
      source = () => file.stream();
      total = file.size;
    } else {
      status("download", null, "Fetching the APK…", "Descargando el APK…");
      let res;
      try { res = await fetch(url, { mode: "cors" }); } catch (e) {
        throw xerr("fetch", "Could not download the APK (network or CORS): " + url, "No se pudo descargar el APK (red o CORS): " + url, e);
      }
      if (!res.ok || !res.body)
        throw xerr("fetch", `Could not download the APK (HTTP ${res.status}): ${url}`, `No se pudo descargar el APK (HTTP ${res.status}): ${url}`);
      const len = Number(res.headers.get("content-length"));
      total = len > 0 && !res.headers.get("content-encoding") ? len : 0;
      let used = false;
      source = () => { if (used) throw new Error("stream already used"); used = true; return res.body; };
    }

    // 3. Connect + authenticate.
    status("connect", null, "Connecting to the headset…", "Conectando con el visor…");
    const dev = await wrapDevice(L, raw);
    adb = await connectAdb(L, dev, status);
    let model = "Quest";
    try { model = (await adb.getProp("ro.product.model")).trim() || model; } catch {}
    status("connected", null, `Connected to ${model}.`, `Conectado a ${model}.`, { device: model });

    // 4. Push, streaming, with progress.
    remote = REMOTE_DIR + "opi_" + pkg.replace(/[^\w.]/g, "_") + ".apk";
    const MB = (n) => (n / 1048576).toFixed(1);
    let sent = 0, lastPct = -1, lastT = 0;
    const report = (force) => {
      const pct = total ? Math.min(100, Math.floor((sent / total) * 100)) : null;
      const now = performance.now();
      if (!force && pct === lastPct && now - lastT < 250) return;
      lastPct = pct; lastT = now;
      const of = total ? ` / ${MB(total)} MB` : " MB";
      status("push", pct, `Copying to the headset: ${MB(sent)}${of}${pct != null ? ` (${pct}%)` : ""}`,
        `Copiando al visor: ${MB(sent)}${of}${pct != null ? ` (${pct}%)` : ""}`, { sent, total });
    };
    const counter = new TransformStream({
      transform(chunk, ctl) { sent += chunk.byteLength; report(false); ctl.enqueue(chunk); },
    });
    report(true);
    const sync = await adb.sync();
    try {
      pushed = true;
      await sync.write({ filename: remote, file: source().pipeThrough(counter), permission: 0o644 });
    } finally {
      try { await sync.dispose(); } catch {}
    }
    report(true);
    if (total && sent !== total)
      throw xerr("fetch", `The APK transfer was incomplete (${sent} of ${total} bytes).`,
        `La transferencia del APK quedó incompleta (${sent} de ${total} bytes).`);

    // 5. Install.
    status("install", null, "Installing on the headset (this can take a minute)…", "Instalando en el visor (puede tardar un minuto)…");
    const inst = await shell(adb, `pm install -r${grant ? " -g" : ""} ${shQuote(remote)}`); // grant: also grant runtime permissions (casco.html)
    if (!/\bSuccess\b/.test(inst.out)) {
      const code = (inst.out.match(/(INSTALL_[A-Z_]+)/) || [])[1] || "";
      const hk = Object.keys(PM_HINTS).find((k) => code.startsWith(k));
      const [hen, hes] = hk ? PM_HINTS[hk] : ["", ""];
      const e = xerr("install",
        `Install failed${hen ? ": " + hen : "."}\npm output: ${inst.out || "(empty)"}`,
        `Falló la instalación${hes ? ": " + hes : "."}\nSalida de pm: ${inst.out || "(vacía)"}`);
      e.pm_output = inst.out;
      throw e;
    }

    // 6. Launch (a launch failure does not undo a good install).
    status("launch", null, "Launching the app…", "Abriendo la app…");
    let launched = true, launchOut = "";
    try {
      const cmd = activity
        ? `am start -n ${shQuote(activity.includes("/") ? activity : pkg + "/" + activity)}`
        : `monkey -p ${shQuote(pkg)} -c android.intent.category.LAUNCHER 1`;
      const r = await shell(adb, cmd);
      launchOut = r.out;
      if (/Error|No activities found|aborted|Exception/i.test(r.out) || (r.code != null && r.code !== 0)) launched = false;
    } catch (e) { launched = false; launchOut = msgOf(e); }

    status("done", 100,
      launched ? `Installed and launched on ${model}. Put on the headset.` : `Installed on ${model}, but it could not be launched automatically: open it from Library > Unknown sources.`,
      launched ? `Instalado y abierto en ${model}. Ponete el visor.` : `Instalado en ${model}, pero no se pudo abrir solo: abrilo desde Biblioteca > Fuentes desconocidas.`,
      { device: model });
    return { ok: true, device: model, launched, launch_output: launchOut };
  } catch (e) {
    if (e && e.msg_es) throw e;
    if (isName(e, "NetworkError") || /disconnected|transfer/i.test(msgOf(e))) throw xerr("gone", GONE_EN, GONE_ES, e);
    throw xerr("unknown", "Install error: " + msgOf(e), "Error de instalación: " + msgOf(e), e);
  } finally {
    if (adb) {
      if (pushed && remote) { try { await shell(adb, `rm -f ${shQuote(remote)}`); } catch {} }
      try { await adb.close(); } catch {}
    }
    if (raw && raw.opened) { try { await raw.close(); } catch {} }
    busy = false;
  }
}

// ---------- notifyReady ----------
let notifPerm = null;
export async function notifyReady(title, body) {
  chime();
  speak(title);
  try {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "default" && notifPerm === null) {
      notifPerm = Notification.requestPermission().catch(() => "denied");
    }
    const p = Notification.permission === "default" && notifPerm ? await notifPerm : Notification.permission;
    if (p !== "granted") return false;
    const n = new Notification(title || "OPI", { body: body || "", tag: "opi-xr-install" });
    n.onclick = () => { try { window.focus(); n.close(); } catch {} };
    return true;
  } catch {
    return false;
  }
}

let actx = null;
function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = actx || new AC();
    if (actx.state === "suspended") actx.resume().catch(() => {});
    const t0 = actx.currentTime + 0.02;
    // Rising three-note chime, played twice and loud enough to hear from across the room with the headset on.
    [[784, 0], [1046.5, 0.15], [1568, 0.3], [784, 1.1], [1046.5, 1.25], [1568, 1.4]].forEach(([f, dt]) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = "triangle"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.45, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.6);
      o.connect(g).connect(actx.destination);
      o.start(t0 + dt); o.stop(t0 + dt + 0.65);
    });
  } catch {}
}

// Says the ready message out loud after the chime, in Spanish or English depending on the text.
function speak(text) {
  try {
    if (!text || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = /[áéíóúñ¿¡]|(listo|lista|casco|ponete)/i.test(text) ? "es-AR" : "en-US";
    u.volume = 1;
    setTimeout(() => { try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch {} }, 2100);
  } catch {}
}

// Optional: warm the CDN cache (e.g. on hover over the Install button).
export function preload() { return loadLibs(); }
