import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, getDocs, setDoc, addDoc, updateDoc, deleteDoc, query, orderBy, serverTimestamp, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";
import * as cfg from "./firebase-config.js";

const firebaseConfig = cfg.firebaseConfig;
const GEMINI_API_KEY = (cfg.geminiApiKey || "").trim();
const VAPID_KEY = (cfg.vapidKey || "").trim();

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Guarda una copia en el dispositivo: funciona sin internet y sincroniza al volver la conexión
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const ESTADOS = ["En diagnóstico", "En reparación", "Esperando pieza", "Listo", "Entregado"];
const DIAS_RETENCION = 30;
const MS_DIA = 24 * 60 * 60 * 1000;
const root = document.getElementById("app");
let user = null;
let unsubs = [];
const borrandoIds = new Set();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

const hoy = () => new Date().toLocaleDateString("sv-SE"); // AAAA-MM-DD en hora local
const horaActual = () => new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
function fechaLarga(f) {
  if (!f) return "";
  const d = new Date(f + "T12:00:00");
  const diaSem = d.toLocaleDateString("es-MX", { weekday: "short" }).replace(".", "");
  const diaNum = d.getDate();
  const mes = d.toLocaleDateString("es-MX", { month: "short" }).replace(".", "");
  return `${diaSem[0].toUpperCase() + diaSem.slice(1)} ${diaNum} ${mes}`;
}
function tituloDia(f) {
  if (!f) return "Sin fecha";
  const d = new Date(f + "T12:00:00");
  if (Number.isNaN(d.getTime())) return f;
  const diaNum = d.getDate();
  const mes = d.toLocaleDateString("es-MX", { month: "long" });
  return `${diaNum} ${mes[0].toUpperCase() + mes.slice(1)}`;
}
const nombreDe = (u) => u.email.split("@")[0];
const normalizar = (txt) => (txt || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const esMovil = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 900);
const contarPalabras = (txt) => (txt || "").trim().split(/\s+/).filter(Boolean).length;

function ajustarAltura(ta) {
  if (!ta) return;
  ta.style.height = "auto";
  if (ta.scrollHeight) ta.style.height = `${ta.scrollHeight}px`;
}

function tituloEquipo(e) {
  const partes = [e.orden ? `#${e.orden}` : "", e.modelo].filter(Boolean);
  if (partes.length) return partes.join(" · ");
  return e.cliente || e.nombre || "Equipo sin datos";
}

function obtenerRezago(e) {
  if (!e || e.estado === "Listo" || e.estado === "Entregado") return null;
  let inicio = null;
  if (e.actualizado && typeof e.actualizado.toMillis === "function") {
    inicio = e.actualizado.toMillis();
  } else if (e.ultimaFecha) {
    const t = new Date(e.ultimaFecha + "T12:00:00").getTime();
    if (!Number.isNaN(t)) inicio = t;
  }
  if (!inicio) return null;

  const dias = Math.floor((Date.now() - inicio) / MS_DIA);
  if (dias < 7) return null;
  if (dias < 14) {
    return { dias, texto: "Sin cambios: 1 semana", bg: "rgba(249,115,22,0.18)", color: "#fb923c", border: "rgba(249,115,22,0.45)" };
  }
  if (dias < 21) {
    return { dias, texto: "Sin cambios: 2 semanas", bg: "rgba(239,68,68,0.18)", color: "#f87171", border: "rgba(239,68,68,0.45)" };
  }
  if (dias < 30) {
    return { dias, texto: "Sin cambios: 3 semanas", bg: "rgba(239,68,68,0.24)", color: "#fca5a5", border: "rgba(239,68,68,0.55)" };
  }
  return { dias, texto: "Sin cambios: 1 mes o más", bg: "rgba(185,28,28,0.32)", color: "#fecaca", border: "rgba(239,68,68,0.7)" };
}

async function registrarTokenFCM() {
  if (!VAPID_KEY || !user || !("Notification" in window) || Notification.permission !== "granted") return;
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (token) {
      await updateDoc(doc(db, "usuarios", user.email.toLowerCase()), {
        fcmTokens: arrayUnion(token),
      });
    }
  } catch {}
}

function notificarRezagadosCada2Dias(rezagados) {
  if (!rezagados.length || !("Notification" in window) || Notification.permission !== "granted") return;
  const ahora = Date.now();
  try {
    const ultimo = Number(localStorage.getItem("bitacora_notif_rezago_ts") || 0);
    if (ultimo && ahora - ultimo < 2 * MS_DIA) return;
    localStorage.setItem("bitacora_notif_rezago_ts", String(ahora));
  } catch {}

  const titulo = rezagados.length === 1
    ? "1 equipo lleva 1 semana o más sin cambios"
    : `${rezagados.length} equipos llevan 1 semana o más sin cambios`;
  const ejemplos = rezagados
    .slice(0, 3)
    .map((x) => `${tituloEquipo(x.equipo)} (${x.rezago.texto.replace("Sin cambios: ", "")})`)
    .join(", ");
  const extra = rezagados.length > 3 ? ` y ${rezagados.length - 3} más.` : ".";
  const cuerpo = `${ejemplos}${extra}`;

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(titulo, { body: cuerpo, icon: "./icon.svg", tag: "bitacora-rezago" }))
      .catch(() => { try { new Notification(titulo, { body: cuerpo, icon: "./icon.svg" }); } catch {} });
  } else {
    try { new Notification(titulo, { body: cuerpo, icon: "./icon.svg" }); } catch {}
  }
}

function obtenerListaPendientes(e) {
  if (!e) return [];
  if (Array.isArray(e.pendientes)) return e.pendientes;
  if (e.pendiente && e.pendiente.trim()) {
    return [{
      id: "legacy",
      texto: e.pendiente.trim(),
      subrayado: Boolean(e.pendienteSubrayado),
      autor: e.pendientePor || "",
    }];
  }
  return [];
}

const SIGLAS_VALIDAS = new Set([
  "ssd", "hdd", "ram", "gpu", "cpu", "pc", "usb", "hdmi", "vga", "dvi",
  "bios", "uefi", "lcd", "led", "ips", "oled", "nvme", "m2", "sata",
  "wifi", "lan", "dc", "ac", "so", "os", "w10", "w11", "hp", "dell",
  "asus", "acer", "msi", "lenovo", "mac", "imac", "rgb", "psu", "pcb",
  "ic", "smd", "bga", "dvd", "cd", "sd", "sim", "jack", "flex", "pin", "cmos",
]);

function esTextoValido(frase) {
  const norm = normalizar(frase).replace(/[^a-z0-9\s]/g, " ").trim();
  if (!norm || norm.length < 4) return false;
  if (/^(hola|test|prueba|ok|listo|nada|ninguno|reingreso al taller)$/.test(norm)) return false;

  const palabras = norm.split(/\s+/).filter(Boolean);
  let validas = 0;

  for (const w of palabras) {
    if (SIGLAS_VALIDAS.has(w) || /^\d+$/.test(w)) {
      validas++;
      continue;
    }
    if (/(.)\1{2,}/.test(w)) return false;
    if (/(asd|sdf|dfg|fgh|ghj|hjk|jkl|qwe|rty|zxc|xcv|cvb|vbn|bnm|lsd|sdl)/.test(w)) return false;
    if (/[bcdfghjklmnpqrstvwxyz]{5,}/.test(w)) return false;
    if (w.length >= 4 && !/[aeiou]/.test(w)) return false;
    if (w.length >= 2) validas++;
  }

  return validas > 0;
}

function normalizarTerminosTecnicos(txt) {
  const mapaSiglas = {
    ssd: "SSD", sata: "SATA", nvme: "NVMe", "m.2": "M.2", m2: "M.2",
    hdd: "HDD", ram: "RAM", bios: "BIOS", uefi: "UEFI", cmos: "CMOS",
    usb: "USB", hdmi: "HDMI", vga: "VGA", gpu: "GPU", cpu: "CPU",
    wifi: "Wi-Fi", "wi-fi": "Wi-Fi", pc: "PC", lcd: "LCD", led: "LED", ips: "IPS",
  };
  let out = txt
    .replace(/\b(ssd|sata|nvme|m\.2|m2|hdd|ram|bios|uefi|cmos|usb|hdmi|vga|gpu|cpu|wi-fi|wifi|pc|lcd|led|ips)\b/gi,
      (m) => mapaSiglas[m.toLowerCase()] || m.toUpperCase())
    .replace(/\btermica\b/gi, "térmica")
    .replace(/\bbateria\b/gi, "batería")
    .replace(/\bdisipacion\b/gi, "disipación")
    .replace(/\binstalacion\b/gi, "instalación")
    .replace(/\breparacion\b/gi, "reparación")
    .replace(/\bactualizacion\b/gi, "actualización")
    .replace(/\bconfiguracion\b/gi, "configuración")
    .replace(/\boptimizacion\b/gi, "optimización")
    .replace(/\bpor\s+que\b/gi, "porque")
    .replace(/\bservia\b/gi, "servía")
    .replace(/\bde el\b/gi, "del")
    .replace(/\ba el\b/gi, "al")
    .replace(/\s+/g, " ")
    .trim();
  return out ? out[0].toUpperCase() + out.slice(1) : "";
}

function recortarSinColgar(oracion, maxPalabras = 20) {
  const palabras = oracion.replace(/[.]+$/, "").trim().split(/\s+/).filter(Boolean);
  if (palabras.length <= maxPalabras) return `${palabras.join(" ")}.`;

  const recorte = palabras.slice(0, maxPalabras);
  const stopFinal = /^(y|e|o|u|ni|de|del|al|a|en|con|sin|por|para|que|porque|como|el|la|los|las|un|una|unos|unas|se|su|sus|ya|no|muy|mas|más)$/i;

  while (recorte.length > 2 && stopFinal.test(normalizar(recorte[recorte.length - 1]))) {
    recorte.pop();
  }
  return `${recorte.join(" ")}.`;
}

function interpretarClausula(raw, contextoBios = false) {
  if (!esTextoValido(raw)) return null;

  let limpio = raw
    .replace(/^(hola[,.\s]+|buen[oa]s\s+(d[ií]as|tardes|noches)[,.\s]+|ya\s+qued[oó]\s+|ya\s+se\s+(realiz[oó]|hizo)\s+|se\s+le\s+(realiz[oó]|hizo)\s+|le\s+(hice|hicimos)\s+|se\s+procedi[oó]\s+a\s+|hoy\s+)/i, "")
    .trim();

  if (!esTextoValido(limpio)) return null;
  const norm = normalizar(limpio);

  // Descarta narraciones de síntomas, causas o notas pendientes de revisión ("checar", "no entra a BIOS", etc.)
  if (/(?:^|\b)(?:porque|por\s+que|ya\s+que|debido\s+a|no\s+funcionaba|no\s+servia|estaba\s+da[nñ]ad|estaba\s+muert|tenia\s+falla|checar|por\s+revisar)/i.test(norm)) {
    return null;
  }
  if (/^(?:y\s+)?(?:el\s+equipo\s+|la\s+laptop\s+|la\s+pc\s+)?(?:no\s+(?:da|daba)\s+(?:video|imagen)|sin\s+(?:video|imagen)|no\s+entra\s+a\s+(?:bios|sistema|windows)|no\s+(?:prende|enciende|prendia|encendia))$/i.test(norm)) {
    return null;
  }

  if (/(?:ya\s+da\s+video|ya\s+da\s+imagen|dio\s+video|restablec\w*\s+(?:de\s+)?video)/i.test(norm)) {
    return {
      tecnico: "Restablecimiento de salida de video",
      cliente: "restablecimiento de imagen",
      tipo: "sustantivo",
    };
  }
  if (/(?:ya\s+(?:enciende|prende)|encendio\s+correctamente|prendio\s+sin\s+problema)/i.test(norm)) {
    return {
      tecnico: "Restablecimiento de encendido del equipo",
      cliente: "reparación de encendido",
      tipo: "sustantivo",
    };
  }

  const reglas = [
    {
      re: /(?:instal\w*|puso|coloc\w*|cambi\w*|actualiz\w*)\s+(?:de\s+|una?\s+)?(?:memoria\s+|disco\s+|unidad\s+)?ssd(?:\s+(sata|nvme|m\.?2))?/i,
      fn: (m) => {
        const tipo = m[1] ? ` ${m[1].toUpperCase().replace("M2", "M.2")}` : "";
        return {
          tecnico: `Instalación de SSD${tipo}`,
          cliente: "instalación de disco sólido",
          tipo: "sustantivo",
        };
      },
    },
    {
      re: /formate\w*\s+(?:de\s+|del?\s+|el\s+|la\s+)?(?:disco(?:\s+duro)?|unidad|ssd|hdd|equipo|pc|laptop|sistema)/i,
      fn: (m) => ({
        tecnico: /disco\s+duro/i.test(m[0]) ? "Formateo de disco duro" : "Formateo de unidad de almacenamiento",
        cliente: "reinstalación de sistema",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:mantenimiento|mtto|servicio)(?:\s+(?:preventivo|correctivo|general|interno))?(?:\s+(?:al\s+equipo|a\s+la\s+laptop|a\s+la\s+pc|completo))?$/i,
      fn: () => ({
        tecnico: "Se realizó mantenimiento preventivo al equipo",
        cliente: "limpieza y mantenimiento",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:pasta\s+termica|cambio\s+de\s+pasta|renovo\s+pasta|puso\s+pasta)/i,
      fn: () => ({
        tecnico: "Cambio de pasta térmica y limpieza interna",
        cliente: "mantenimiento interno",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:reemplaz\w*|remplaz\w*|cambi\w*|sustitu\w*)\s+(?:de\s+|del?\s+|el\s+)?(?:ventilador|cooler|abanico|disipador)(?:\s+por\s+(?:uno\s+)?nuevo)?/i,
      fn: () => ({
        tecnico: "Reemplazo de ventilador de sistema de enfriamiento",
        cliente: "cambio de ventilador",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:reemplaz\w*|remplaz\w*|cambi\w*|sustitu\w*)\s+(?:de\s+|del?\s+|la\s+)?(?:pantalla|display|panel)/i,
      fn: () => ({
        tecnico: "Sustitución de pantalla",
        cliente: "cambio de pantalla",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:reemplaz\w*|remplaz\w*|cambi\w*|sustitu\w*)\s+(?:de\s+|de\s+los\s+|de\s+las\s+|los\s+|las\s+)?(?:altavoces|bocinas|parlantes)/i,
      fn: () => ({
        tecnico: "Reemplazo de módulo de altavoces",
        cliente: "cambio de bocinas",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:reemplaz\w*|remplaz\w*|cambi\w*|sustitu\w*)\s+(?:de\s+|de\s+la\s+|la\s+)?(?:bateria|pila)(?:\s+(?:de\s+(?:la\s+)?)?(?:bios|cmos))?/i,
      fn: (m) => {
        const esBios = contextoBios || /bios|cmos|pila/i.test(m[0]);
        return esBios
          ? {
              tecnico: "Reemplazo de pila del BIOS (CMOS)",
              cliente: "cambio de pila interna",
              tipo: "sustantivo",
            }
          : {
              tecnico: "Reemplazo de batería",
              cliente: "cambio de batería",
              tipo: "sustantivo",
            };
      },
    },
    {
      re: /(?:reemplaz\w*|remplaz\w*|cambi\w*|sustitu\w*)\s+(?:de\s+|del?\s+|el\s+)?teclado/i,
      fn: () => ({
        tecnico: "Sustitución de teclado",
        cliente: "cambio de teclado",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:instal\w*|ampli\w*|aument\w*|puso|cambi\w*)\s+(?:de\s+|la\s+)?(?:memoria\s+)?ram/i,
      fn: () => ({
        tecnico: "Ampliación de memoria RAM",
        cliente: "aumento de memoria",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:repar\w*|reforz\w*|arregl\w*|reconstru\w*)\s+(?:de\s+|de\s+las\s+|las\s+)?bisagras?/i,
      fn: () => ({
        tecnico: "Reparación y refuerzo de bisagras",
        cliente: "reparación de bisagras",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:repar\w*|cambi\w*|reemplaz\w*|remplaz\w*|sold\w*)\s+(?:de\s+|del?\s+|el\s+)?(?:centro\s+de\s+carga|pin\s+de\s+carga|puerto\s+de\s+carga|jack)/i,
      fn: () => ({
        tecnico: "Reparación de puerto de carga",
        cliente: "reparación de centro de carga",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:instal\w*|actualiz\w*)\s+(?:de\s+|los\s+)?(?:drivers|controladores)/i,
      fn: () => ({
        tecnico: "Actualización de controladores",
        cliente: "actualización de sistema",
        tipo: "sustantivo",
      }),
    },
    {
      re: /(?:respald\w*|copia\s+de\s+seguridad)\s+(?:de\s+)?(?:informacion|datos|archivos)?/i,
      fn: () => ({
        tecnico: "Respaldo de información",
        cliente: "respaldo de archivos",
        tipo: "sustantivo",
      }),
    },
  ];

  for (const r of reglas) {
    const m = norm.match(r.re);
    if (m) return r.fn(m);
  }

  const verbos = [
    [/^(?:se\s+)?instal[oó]\s+(?:de\s+)?(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?/i, "Instalación de ", "instalación de "],
    [/^instalar\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?/i, "Instalación de ", "instalación de "],
    [/^(?:se\s+)?(?:reemplaz[oó]|remplaz[oó])\s+(?:de\s+)?(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?/i, "Reemplazo de ", "cambio de "],
    [/^(?:reemplazar|remplazar)\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?/i, "Reemplazo de ", "cambio de "],
    [/^(?:se\s+)?cambi[oó]\s+(?:de\s+)?(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?/i, "Sustitución de ", "cambio de "],
    [/^cambiar\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?/i, "Sustitución de ", "cambio de "],
    [/^(?:se\s+)?(?:repar[oó]|arregl[oó])\s+(?:de\s+)?(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?/i, "Reparación de ", "reparación de "],
    [/^(?:reparar|arreglar)\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?/i, "Reparación de ", "reparación de "],
    [/^(?:se\s+)?formate[oó]\s+(?:el\s+|la\s+|los\s+|las\s+)?/i, "Formateo de ", "reinstalación de "],
    [/^formatear\s+(?:el\s+|la\s+|los\s+|las\s+)?/i, "Formateo de ", "reinstalación de "],
    [/^(?:se\s+)?limpi[oó]\s+(?:el\s+|la\s+|los\s+|las\s+)?/i, "Limpieza de ", "limpieza de "],
    [/^limpiar\s+(?:el\s+|la\s+|los\s+|las\s+)?/i, "Limpieza de ", "limpieza de "],
    [/^(?:se\s+)?actualiz[oó]\s+(?:de\s+)?(?:el\s+|la\s+|los\s+|las\s+)?/i, "Actualización de ", "actualización de "],
    [/^actualizar\s+(?:el\s+|la\s+|los\s+|las\s+)?/i, "Actualización de ", "actualización de "],
    [/^(?:se\s+)?configur[oó]\s+(?:el\s+|la\s+|los\s+|las\s+)?/i, "Configuración de ", "configuración de "],
    [/^configurar\s+(?:el\s+|la\s+|los\s+|las\s+)?/i, "Configuración de ", "configuración de "],
    [/^(?:se\s+)?(?:revis[oó]|chec[oó])\s+(?:el\s+|la\s+|los\s+|las\s+)?/i, "Revisión de ", "revisión de "],
    [/^(?:revisar|checar)\s+(?:el\s+|la\s+|los\s+|las\s+)?/i, "Revisión de ", "revisión de "],
    [/^(?:el\s+|la\s+|los\s+|las\s+)?cambio\s+de\s+(?:el\s+|la\s+|los\s+|las\s+)?/i, "Sustitución de ", "cambio de "],
  ];

  for (const [re, prefTec, prefCli] of verbos) {
    if (re.test(limpio)) {
      const tec = normalizarTerminosTecnicos(limpio.replace(re, prefTec));
      const cli = limpio.replace(re, prefCli).toLowerCase().trim();
      return { tecnico: tec, cliente: cli, tipo: "sustantivo" };
    }
  }

  const tec = normalizarTerminosTecnicos(limpio);
  return { tecnico: tec, cliente: tec, tipo: "oracion" };
}

function unirEnEspanol(lista) {
  if (!lista.length) return "";
  if (lista.length === 1) return lista[0];
  const ult = lista[lista.length - 1];
  const conj = /^i/i.test(ult) ? " e " : " y ";
  return `${lista.slice(0, -1).join(", ")}${conj}${ult}`;
}

function construirResumenCliente(itemsCli) {
  if (!itemsCli.length) return "Sin trabajos registrados todavía.";

  const sustantivos = itemsCli.filter((x) => x.tipo === "sustantivo").map((x) => x.texto);
  const oraciones = itemsCli.filter((x) => x.tipo === "oracion").map((x) => x.texto);

  const otros = [];
  const cambios = [];
  for (const f of sustantivos) {
    if (/^cambio de /i.test(f)) {
      cambios.push(f.replace(/^cambio de /i, "").trim());
    } else {
      otros.push(f);
    }
  }

  const partes = [...otros];
  if (cambios.length) {
    partes.push(`cambio de ${unirEnEspanol(cambios)}`);
  }

  if (partes.length) {
    const armarOracion = (items, extraFinal = "") => {
      const lista = extraFinal ? [...items, extraFinal] : items;
      return `Se realizó ${unirEnEspanol(lista)}.`;
    };

    let oracion = armarOracion(partes);
    if (contarPalabras(oracion) <= 20) return oracion;

    const recorte = [...partes];
    while (recorte.length > 1) {
      recorte.pop();
      const candidata = armarOracion(recorte, "ajustes generales");
      if (contarPalabras(candidata) <= 20) return candidata;
    }
    return recortarSinColgar(oracion, 20);
  }

  const unido = oraciones.map((o) => (/[.!?]$/.test(o) ? o : `${o}.`)).join(" ");
  return recortarSinColgar(unido, 20);
}

function generarResumenesLocal(notas) {
  const ordenadas = [...notas].sort((a, b) => {
    const cmpFecha = (a.fecha || "").localeCompare(b.fecha || "");
    if (cmpFecha !== 0) return cmpFecha;
    return (a.creada || 0) - (b.creada || 0);
  });

  const todoTextoNorm = normalizar(ordenadas.map((n) => n.texto || "").join(" "));
  const contextoBios = /\b(bios|cmos)\b/.test(todoTextoNorm);

  const itemsTec = [];
  const itemsCli = [];

  for (const n of ordenadas) {
    if (n.tipo === "pendiente" || !n.texto) continue;
    const texto = n.texto.trim();
    if (!texto) continue;

    const partes = texto
      .split(/\r?\n+|(?<=[a-záéíóúñ0-9])\.\s+|\s+(?:al\s+igual\s+que|al\s+igual|as[ií]\s+como|adem[aá]s\s+de|adem[aá]s|tambi[eé]n\s+se)\s+|,\s+(?=(?:y\s+|se\s+|ya\s+|el\s+equipo|la\s+bios|falta\s+|falt[oó]\s+|pendiente|cambio\s+|el\s+cambio|limpieza\s+|instalaci[oó]n\s+|formateo\s+|reparaci[oó]n\s+|mantenimiento\s+|revisi[oó]n\s+|diagn[oó]stico\s+|actualizaci[oó]n\s+|respaldo\s+))/i)
      .map((p) => p.replace(/^[-•*]\s*/, "").replace(/[.]+$/, "").trim())
      .filter(Boolean);

    for (const p of partes) {
      if (/^(falta|falt[oó]|pendiente|por\s+hacer|en\s+espera|esperando)\b/i.test(p)) continue;
      const interp = interpretarClausula(p, contextoBios);
      if (!interp) continue;

      const normTec = normalizar(interp.tecnico);
      if (normTec && !itemsTec.some((u) => normalizar(u).includes(normTec))) {
        const idxMenor = itemsTec.findIndex((u) => normTec.includes(normalizar(u)));
        if (idxMenor !== -1) itemsTec[idxMenor] = interp.tecnico;
        else itemsTec.push(interp.tecnico);
      }

      const normCli = normalizar(interp.cliente);
      if (normCli && !itemsCli.some((u) => normalizar(u.texto) === normCli)) {
        itemsCli.push({ texto: interp.cliente, tipo: interp.tipo });
      }
    }
  }

  if (!itemsTec.length) {
    return {
      cliente: "Sin trabajos registrados todavía.",
      tecnico: "Sin trabajos técnicos registrados todavía.",
    };
  }

  return {
    cliente: construirResumenCliente(itemsCli),
    tecnico: itemsTec.map((u) => (/[.!?]$/.test(u) ? u : `${u}.`)).join(" "),
  };
}

function construirPrompt(notasOrdenadas, modeloEquipo) {
  const notas = notasOrdenadas.map((n, i) => `${i + 1}. ${n}`).join("\n");

  return `Eres un asistente de un taller de reparación de computadoras. Con las notas de trabajo de un equipo, genera dos textos en español.
${modeloEquipo ? `\nCONTEXTO (solo para que entiendas el tipo de equipo; NO lo menciones en ningún texto): ${modeloEquipo}\n` : ""}
NOTAS (orden cronológico):
${notas}

REGLAS GENERALES
- Cada equipo llega con problemas distintos. Basa los textos ÚNICAMENTE en lo que dicen las notas; no asumas reparaciones típicas ni agregues trabajos que no aparezcan.
- Redacta en tercera persona, refiriéndote al equipo. Nunca uses primera persona.
- Nunca menciones el nombre, la marca ni el modelo del equipo, ni frases como "en su equipo" o "en su computadora".
- Varía el inicio de cada frase y evita repetir "se" o "se le" en cada acción. Agrupa acciones relacionadas en una sola frase.
- Respeta los términos que aparezcan en las notas.
- Ortografía correcta, con todas las tildes.
- Incluye solo trabajos realizados. Ignora pruebas, ruido, pendientes y notas de revisión o síntomas ("checar", "falta", "no da video", "no entra a BIOS").
- Si hay pocos trabajos, el texto debe ser corto; no lo rellenes.
- No inventes marcas, capacidades, versiones ni modelos que no estén en las notas.

TEXTO "cliente"
- Una sola oración, lenguaje sencillo y claro, sin tecnicismos innecesarios.
- Máximo 20 palabras. Debe terminar en oración completa, sin cortarse.
- Objetivo: que el cliente entienda qué se hizo, sin nombrar el equipo.
- Si hay muchos trabajos, resume los más importantes y agrupa el resto con expresiones como "y mantenimiento general".

TEXTO "tecnico"
- Es para el técnico que reciba el equipo si regresa con una falla, así que debe incluir TODO lo realizado según las notas, con los detalles que aparezcan (qué pieza o programa, tipo, capacidad, si fue instalación limpia, etc.).
- Tono natural y directo, como un técnico que le explica a otro técnico lo que hizo. Ni tan seco como una lista de inventario, ni tan formal como un informe.
- Usa palabras sencillas y solo los tecnicismos necesarios. Evita expresiones como "se efectuó", "se procedió a", "el proceso inició con", "posteriormente", "finalmente" y "se llevó a cabo".
- Frases cortas o medianas, completas, que no empiecen todas igual. No narres el orden cronológico a menos que importe para entender el trabajo.
- Referencia de tono (solo el tono, no copies su contenido): "Se reinstaló Windows desde cero y se actualizaron los controladores. También se limpió el equipo por dentro y se cambió la pasta térmica."

FORMATO DE SALIDA
Responde ÚNICAMENTE con JSON válido, sin markdown ni texto extra:
{"cliente": "...", "tecnico": "..."}`;
}

let permitirThinkingCero = true;
const cacheResumenesIA = new Map();

// Consulta en ListModels qué modelos activos de generateContent tiene habilitados la clave
async function obtenerModelosDisponibles() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = await resp.json();
    const lista = Array.isArray(data.models) ? data.models : [];
    return lista
      .filter((m) =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent") &&
        /gemini/i.test(m.name || "") &&
        !/embedding|imagen|veo|tts|audio|robotics|computer-use|deep-research/i.test(m.name || "")
      )
      .map((m) => m.name.replace(/^models\//, ""))
      .sort((a, b) => {
        const score = (id) => {
          let s = 0;
          if (/lite/i.test(id)) s += 25;
          if (/flash/i.test(id)) s += 20;
          const ver = id.match(/gemini-(\d+(?:\.\d+)?)/i);
          if (ver) s += parseFloat(ver[1]) * 10;
          if (/preview|exp/i.test(id)) s -= 2;
          return s;
        };
        return score(b) - score(a);
      });
  } catch {
    clearTimeout(timer);
    return [];
  }
}

// Genera los resúmenes usando Gemini con construirPrompt y respuesta rápida
async function generarResumenesGemini(notas, equipo, forzar = false) {
  if (!GEMINI_API_KEY || !navigator.onLine) return { ok: false, error: "Sin conexión" };

  const ordenadas = [...notas]
    .filter((n) => n.tipo !== "pendiente" && n.texto && n.texto.trim())
    .sort((a, b) => {
      const cmpFecha = (a.fecha || "").localeCompare(b.fecha || "");
      if (cmpFecha !== 0) return cmpFecha;
      return (a.creada || 0) - (b.creada || 0);
    });

  if (!ordenadas.length) return { ok: false, error: "Sin notas" };

  const notasLimpias = ordenadas.map((n) => n.texto.trim());
  const modeloEquipo = equipo && equipo.modelo ? equipo.modelo.trim() : "";
  const huella = `${modeloEquipo}|${notasLimpias.join("\n")}`;

  if (!forzar && cacheResumenesIA.has(huella)) {
    return { ok: true, cached: true, data: cacheResumenesIA.get(huella) };
  }

  const prompt = construirPrompt(notasLimpias, modeloEquipo);

  const probarModelo = async (modelo) => {
    const genConfig = {
      temperature: 0.35,
      maxOutputTokens: 650,
      responseMimeType: "application/json",
    };
    if (permitirThinkingCero) {
      genConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: genConfig,
        }),
      });
      clearTimeout(timer);

      if (!resp.ok) {
        let detalle = `HTTP ${resp.status}`;
        try {
          const errJson = await resp.json();
          if (errJson?.error?.message) detalle = `${resp.status}: ${errJson.error.message}`;
        } catch {}

        if (resp.status === 400 && permitirThinkingCero && /thinking/i.test(detalle)) {
          permitirThinkingCero = false;
          return probarModelo(modelo);
        }
        return { ok: false, status: resp.status, error: detalle };
      }

      const data = await resp.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) return { ok: false, status: 500, error: "Respuesta vacía de Gemini" };

      const limpioJson = rawText.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
      const parsed = JSON.parse(limpioJson);

      const cliente = recortarSinColgar(String(parsed.cliente || "").trim(), 20);
      const rawTec = parsed.tecnico;
      const textoTec = Array.isArray(rawTec)
        ? rawTec.map((s) => String(s).replace(/^[-•*]\s*/, "").trim()).filter(Boolean).join(" ")
        : String(rawTec || "").trim();

      if (!cliente || !textoTec) return { ok: false, status: 500, error: "Formato incompleto" };

      const parrafoConPunto = /[.!?]$/.test(textoTec) ? textoTec : `${textoTec}.`;

      const resultado = {
        cliente,
        tecnico: parrafoConPunto,
      };

      cacheResumenesIA.set(huella, resultado);
      try { localStorage.setItem("bitacora_gemini_modelo", modelo); } catch {}
      return { ok: true, data: resultado };
    } catch (err) {
      clearTimeout(timer);
      return {
        ok: false,
        status: 0,
        error: err?.name === "AbortError" ? "Tiempo de espera agotado" : "Error de red",
      };
    }
  };

  let modeloInicial = "gemini-3.8-flash";
  try {
    const guardado = localStorage.getItem("bitacora_gemini_modelo");
    if (guardado) modeloInicial = guardado;
  } catch {}

  const primero = await probarModelo(modeloInicial);
  if (primero.ok) return primero;
  if (primero.status !== 503 && primero.status !== 429 && primero.status !== 404 && primero.status !== 0) {
    return { ok: false, error: primero.error };
  }

  let ultimoError = primero.error;

  const disponibles = await obtenerModelosDisponibles();
  const cola = disponibles.filter((m) => m !== modeloInicial).slice(0, 2);
  if (primero.status === 503) cola.push(modeloInicial);

  for (const modelo of cola) {
    const res = await probarModelo(modelo);
    if (res.ok) return res;
    ultimoError = res.error;
  }

  return { ok: false, error: ultimoError };
}

function diasParaBorrar(e) {
  if (e.estado !== "Entregado") return null;
  const inicio = e.entregadoEn || (e.actualizado && e.actualizado.toMillis ? e.actualizado.toMillis() : null);
  if (!inicio) return DIAS_RETENCION;
  const transcurridos = Math.floor((Date.now() - inicio) / MS_DIA);
  return Math.max(0, DIAS_RETENCION - transcurridos);
}

async function eliminarEquipoCompleto(id) {
  if (borrandoIds.has(id)) return;
  borrandoIds.add(id);
  try {
    const snapNotas = await getDocs(collection(db, "equipos", id, "notas"));
    await Promise.all(snapNotas.docs.map((n) => deleteDoc(n.ref)));
    await deleteDoc(doc(db, "equipos", id));
  } finally {
    borrandoIds.delete(id);
  }
}

function limpiarVencidos(equipos) {
  if (!perfil || perfil.rol !== "admin" || !navigator.onLine) return;
  for (const e of equipos) {
    if (e.estado !== "Entregado") continue;
    const inicio = e.entregadoEn || (e.actualizado && e.actualizado.toMillis ? e.actualizado.toMillis() : null);
    if (inicio && Date.now() - inicio >= DIAS_RETENCION * MS_DIA) {
      eliminarEquipoCompleto(e.id).catch(() => {});
    }
  }
}

function el(tag, props = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n[k] = v;
  }
  if (tag === "textarea") {
    n.style.resize = "none";
    n.style.overflow = "hidden";
    n.addEventListener("input", () => ajustarAltura(n));
    requestAnimationFrame(() => ajustarAltura(n));
  }
  n.append(...hijos.flat().filter((h) => h != null));
  return n;
}
function pintar(...nodos) { unsubs.forEach((f) => f()); unsubs = []; root.className = ""; root.replaceChildren(...nodos); }

let perfil = null;
let cancelarPerfil = null;

// Al entrar, se revisa si el correo está en la lista de usuarios autorizados (colección "usuarios")
onAuthStateChanged(auth, (u) => {
  user = u; perfil = null;
  if (cancelarPerfil) { cancelarPerfil(); cancelarPerfil = null; }
  if (!u) { vistaLogin(); return; }
  cancelarPerfil = onSnapshot(doc(db, "usuarios", u.email.toLowerCase()), (d) => {
    const antes = perfil;
    perfil = d.exists() ? d.data() : null;
    if (!perfil) vistaSinAcceso();
    else if (!antes) {
      registrarTokenFCM();
      vistaLista();
    }
  }, () => vistaSinAcceso());
});

function vistaSinAcceso() {
  pintar(
    el("header", {}, el("h1", {}, "Sin acceso")),
    el("div", { class: "card" },
      el("p", {}, "Tu correo no está en la lista de usuarios. Pide al administrador que te agregue."),
      el("button", { onclick: () => signOut(auth) }, "Salir"))
  );
}

function vistaUsuarios() {
  const correo = el("input", { type: "email", placeholder: "correo@ejemplo.com" });
  const rol = el("select", {}, el("option", { value: "usuario" }, "Usuario"), el("option", { value: "admin" }, "Administrador"));
  const lista = el("div");
  const agregar = () => {
    const c = correo.value.trim().toLowerCase();
    if (!c) return;
    setDoc(doc(db, "usuarios", c), { email: c, rol: rol.value });
    correo.value = "";
  };
  pintar(
    el("header", {}, el("button", { class: "sec", onclick: vistaLista }, "Volver"), el("h1", {}, "Usuarios")),
    el("div", { class: "card" },
      el("h2", {}, "Agregar usuario"), correo, el("div", { class: "row", style: "margin-top:8px" }, rol, el("button", { onclick: agregar }, "Agregar")),
      el("p", { class: "msg" }, "La persona debe crear su cuenta con ese mismo correo en la pantalla de entrada.")),
    el("div", { class: "card" }, el("h2", {}, "Con acceso"), lista)
  );
  unsubs.push(onSnapshot(collection(db, "usuarios"), (snap) => {
    lista.replaceChildren(...snap.docs.map((d) => {
      const u = d.data();
      const yo = d.id === user.email.toLowerCase();
      return el("div", { class: "nota", style: "display:grid;grid-template-columns:1fr auto;align-items:center" },
        el("div", {}, el("b", {}, u.email), el("div", { class: "autor" }, u.rol === "admin" ? "Administrador" : "Usuario")),
        yo ? el("span", { class: "autor" }, "Tú") : el("button", { class: "sec btn-sm", onclick: () => {
          if (confirm(`¿Quitar el acceso de ${u.email}? Sus notas se conservan.`)) deleteDoc(d.ref);
        } }, "Quitar"));
    }));
  }));
}

function vistaLogin() {
  const msg = el("p", { class: "msg err" });
  const correo = el("input", { type: "email", autocomplete: "username", required: true });
  const clave = el("input", { type: "password", autocomplete: "current-password", required: true });
  const entrar = async () => {
    msg.textContent = "";
    try { await signInWithEmailAndPassword(auth, correo.value.trim(), clave.value); }
    catch { msg.textContent = "Correo o contraseña incorrectos. Revisa los datos e intenta de nuevo."; }
  };
  const crear = async () => {
    msg.textContent = "";
    try { await createUserWithEmailAndPassword(auth, correo.value.trim(), clave.value); }
    catch { msg.textContent = "No se pudo crear la cuenta. Usa un correo válido y una contraseña de 6 o más caracteres."; }
  };
  pintar(
    el("header", {}, el("h1", {}, "Bitácora de equipos")),
    el("div", { class: "card" },
      el("label", {}, "Correo"), correo,
      el("label", {}, "Contraseña"), clave,
      el("div", { class: "row", style: "margin-top:12px" },
        el("button", { onclick: entrar }, "Entrar"),
        el("button", { class: "sec", onclick: crear }, "Crear cuenta")),
      msg)
  );
}

// Reduce la foto a máx. 1280 px y la comprime (~150-300 KB) para guardarla dentro de Firestore, sin Cloud Storage
async function comprimir(archivo) {
  const img = await createImageBitmap(archivo);
  const escala = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * escala);
  c.height = Math.round(img.height * escala);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  let calidad = 0.7, url = c.toDataURL("image/jpeg", calidad);
  while (url.length > 300000 && calidad > 0.35) { calidad -= 0.1; url = c.toDataURL("image/jpeg", calidad); }
  return url;
}

// En celular permite elegir entre abrir la cámara directamente o elegir de la galería
function seleccionarFoto(alCargar, alError) {
  const procesar = async (ev) => {
    const input = ev.target;
    const f = input.files && input.files[0];
    input.remove();
    if (!f) return;
    try {
      const url = await comprimir(f);
      alCargar(url);
    } catch {
      if (alError) alError();
    }
  };

  const lanzarInput = (usarCamara) => {
    document.querySelectorAll("input[type=file][hidden]").forEach((n) => n.remove());
    const props = { type: "file", accept: "image/*", hidden: true, onchange: procesar };
    if (usarCamara) props.capture = "environment";
    const inp = el("input", props);
    document.body.append(inp);
    inp.click();
  };

  if (!esMovil()) {
    lanzarInput(false);
    return;
  }

  const modal = el("div", { class: "modal", onclick: (ev) => { if (ev.target === modal) modal.remove(); } },
    el("div", { class: "card" },
      el("h2", {}, "Agregar foto"),
      el("p", { class: "msg", style: "margin-top:0;margin-bottom:12px" }, "Elige cómo quieres cargar la imagen:"),
      el("div", { class: "col-btns" },
        el("button", { type: "button", onclick: () => { modal.remove(); lanzarInput(true); } }, "Tomar foto con cámara"),
        el("button", { type: "button", class: "sec", onclick: () => { modal.remove(); lanzarInput(false); } }, "Elegir de la galería"),
        el("button", { type: "button", class: "sec", onclick: () => modal.remove() }, "Cancelar"))));
  document.body.append(modal);
}

function verFoto(src) {
  const v = el("div", { class: "visor", onclick: () => v.remove() }, el("img", { src, alt: "Foto ampliada" }));
  document.body.append(v);
}

function vistaLista() {
  const alertaDup = el("div");
  const limpiarAlertas = () => { alertaDup.replaceChildren(); avisoForm.textContent = ""; };

  const inOrden = el("input", { placeholder: "N.º de orden", oninput: limpiarAlertas });
  const inModelo = el("input", { placeholder: "Modelo (ej. Lenovo IdeaPad 3)", oninput: limpiarAlertas });
  const inCliente = el("input", { placeholder: "Cliente", oninput: limpiarAlertas });
  const avisoForm = el("p", { class: "msg" });
  const previaBox = el("div", { class: "fotos" });
  let fotoEquipo = "";

  const pintarPrevia = () => {
    if (!fotoEquipo) { previaBox.replaceChildren(); return; }
    previaBox.replaceChildren(
      el("div", { class: "foto" },
        el("img", { src: fotoEquipo, alt: "Foto del equipo", onclick: () => verFoto(fotoEquipo) }),
        el("button", { type: "button", class: "sec x", title: "Quitar foto", onclick: () => { fotoEquipo = ""; pintarPrevia(); } }, "×"))
    );
  };

  let todosEquipos = [];
  let soloRezagados = false;
  const contador = el("span", { class: "count" });
  const bannerRezago = el("div");
  const lista = el("div");

  const inBuscar = el("input", {
    type: "search",
    placeholder: "Buscar por orden, cliente, modelo o nota...",
    oninput: () => renderLista(),
    onkeydown: (ev) => {
      if (ev.key === "Escape") {
        inBuscar.value = "";
        selEstado.value = "";
        barraBuscar.hidden = true;
        renderLista();
      }
    },
  });

  const selEstado = el("select", { onchange: () => renderLista() },
    el("option", { value: "" }, "Todos los estados"),
    ESTADOS.map((s) => el("option", { value: s }, s))
  );

  const btnLimpiar = el("button", {
    type: "button",
    class: "sec btn-sm",
    onclick: () => {
      if (inBuscar.value || selEstado.value || soloRezagados) {
        inBuscar.value = "";
        selEstado.value = "";
        soloRezagados = false;
        inBuscar.focus();
      } else {
        barraBuscar.hidden = true;
      }
      renderLista();
    },
  }, "Limpiar");

  const barraBuscar = el("div", { class: "buscador", hidden: true }, inBuscar, selEstado, btnLimpiar);

  const btnBuscar = el("button", {
    type: "button",
    class: "sec btn-sm",
    onclick: () => {
      barraBuscar.hidden = !barraBuscar.hidden;
      if (!barraBuscar.hidden) {
        inBuscar.focus();
      } else {
        inBuscar.value = "";
        selEstado.value = "";
        renderLista();
      }
    },
  }, "Buscar");

  function renderLista() {
    const rezagados = todosEquipos
      .map((e) => ({ equipo: e, rezago: obtenerRezago(e) }))
      .filter((x) => x.rezago)
      .sort((a, b) => b.rezago.dias - a.rezago.dias);

    if (rezagados.length) {
      const graves = rezagados.filter((x) => x.rezago.dias >= 14).length;
      const textoBanner = rezagados.length === 1
        ? `1 equipo lleva ${rezagados[0].rezago.texto.replace("Sin cambios: ", "")} sin cambios.`
        : `${rezagados.length} equipos llevan 1 semana o más sin cambios${graves ? ` (${graves} de 2+ semanas)` : ""}.`;

      const puedePedirNotif = "Notification" in window && Notification.permission === "default";
      const btnNotif = puedePedirNotif
        ? el("button", {
            type: "button",
            class: "sec btn-xs",
            onclick: async () => {
              try {
                const perm = await Notification.requestPermission();
                if (perm === "granted") {
                  await registrarTokenFCM();
                  try { localStorage.removeItem("bitacora_notif_rezago_ts"); } catch {}
                  notificarRezagadosCada2Dias(rezagados);
                }
              } catch {}
              renderLista();
            },
          }, "Activar avisos")
        : null;

      bannerRezago.replaceChildren(
        el("div", {
          class: "card",
          style: "display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;margin-bottom:10px;border:1px solid rgba(249,115,22,0.45);background:rgba(249,115,22,0.1)",
        },
          el("span", { style: "font-size:0.9rem;color:#fed7aa" }, textoBanner),
          el("div", { class: "row", style: "gap:6px" },
            btnNotif,
            el("button", {
              type: "button",
              class: (soloRezagados ? "" : "sec ") + "btn-xs",
              onclick: () => { soloRezagados = !soloRezagados; renderLista(); },
            }, soloRezagados ? "Ver todos" : "Ver rezagados")))
      );

      notificarRezagadosCada2Dias(rezagados);
    } else {
      soloRezagados = false;
      bannerRezago.replaceChildren();
    }

    if (!todosEquipos.length) {
      contador.textContent = "";
      lista.replaceChildren(el("p", { class: "vacio" }, "Aún no hay equipos. Agrega el primero arriba."));
      return;
    }

    const q = normalizar(inBuscar.value.trim());
    const est = selEstado.value;

    const filtrados = todosEquipos.filter((e) => {
      if (soloRezagados && !obtenerRezago(e)) return false;
      if (est && e.estado !== est) return false;
      if (!q) return true;
      const textoPend = obtenerListaPendientes(e).map((p) => p.texto).join(" ");
      const bolsa = normalizar([e.orden, e.modelo, e.cliente, e.nombre, e.ultimaNota, textoPend].join(" "));
      return bolsa.includes(q);
    });

    const hayFiltro = Boolean(q || est || soloRezagados);
    contador.textContent = hayFiltro
      ? `${filtrados.length} de ${todosEquipos.length}`
      : `${todosEquipos.length} ${todosEquipos.length === 1 ? "equipo" : "equipos"}`;

    if (!filtrados.length) {
      lista.replaceChildren(el("p", { class: "vacio" }, "No se encontraron equipos con esa búsqueda."));
      return;
    }

    lista.replaceChildren(...filtrados.map((e) => {
      const restantes = diasParaBorrar(e);
      const rezago = obtenerRezago(e);
      return el("button", { class: "card equipo", onclick: () => vistaEquipo(e.id) },
        el("div", { class: "equipo-card" },
          el("div", { class: "equipo-info" },
            el("div", { class: "row", style: "align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:4px" },
              el("span", { class: "estado" + (e.estado === "Listo" ? " listo" : ""), style: "margin-bottom:0" }, e.estado),
              rezago
                ? el("span", {
                    style: `font-size:0.75rem;padding:2px 7px;border-radius:999px;background:${rezago.bg};color:${rezago.color};border:1px solid ${rezago.border}`,
                  }, rezago.texto)
                : null,
              restantes !== null
                ? el("span", { class: "autor" }, restantes === 0 ? "Se elimina hoy" : `Se elimina en ${restantes} d`)
                : null),
            el("b", {}, tituloEquipo(e)),
            e.cliente ? el("div", { class: "autor" }, `Cliente: ${e.cliente}`) : null,
            el("small", {}, e.ultimaNota ? `${fechaLarga(e.ultimaFecha)}: ${e.ultimaNota.slice(0, 80)}` : "Sin notas todavía")),
          e.foto ? el("img", { class: "equipo-thumb", src: e.foto, alt: "Foto del equipo" }) : null));
    }));
  }

  const abrirOReabrir = (existente) => {
    if (existente.estado === "Listo" || existente.estado === "Entregado") {
      updateDoc(doc(db, "equipos", existente.id), {
        estado: ESTADOS[0],
        entregadoEn: null,
        ultimaNota: "Reingreso al taller",
        ultimaFecha: hoy(),
        actualizado: serverTimestamp(),
      });
    }
    vistaEquipo(existente.id);
  };

  let formAbiertoMovil = false;
  const formNuevo = el("form", { class: "card form-oculto-movil", onsubmit: (ev) => agregar(ev, false) },
    el("div", { class: "grid2" }, inOrden, inModelo),
    el("div", { style: "margin-top:8px" }, inCliente),
    previaBox,
    el("div", { class: "row", style: "margin-top:10px;justify-content:space-between;flex-wrap:wrap" },
      el("button", {
        type: "button",
        class: "sec",
        onclick: () => seleccionarFoto(
          (url) => { fotoEquipo = url; pintarPrevia(); avisoForm.textContent = ""; },
          () => { avisoForm.textContent = "No se pudo leer la foto."; }
        ),
      }, "+ Foto del equipo (opcional)"),
      el("button", { type: "submit" }, "Agregar equipo")),
    alertaDup,
    avisoForm
  );

  const btnToggleNuevo = el("button", {
    type: "button",
    class: "movil-toggle",
    onclick: () => {
      formAbiertoMovil = !formAbiertoMovil;
      formNuevo.classList.toggle("form-oculto-movil", !formAbiertoMovil);
      btnToggleNuevo.textContent = formAbiertoMovil ? "Cerrar formulario" : "+ Nuevo equipo";
      btnToggleNuevo.classList.toggle("sec", formAbiertoMovil);
      if (formAbiertoMovil) inOrden.focus();
    },
  }, "+ Nuevo equipo");

  const agregar = (ev, forzar = false) => {
    if (ev) ev.preventDefault();
    alertaDup.replaceChildren();
    const orden = inOrden.value.trim();
    const modelo = inModelo.value.trim();
    const cliente = inCliente.value.trim();
    if (!orden && !modelo && !cliente) {
      avisoForm.textContent = "Escribe al menos el n.º de orden, cliente o modelo.";
      return;
    }

    const ordenNorm = normalizar(orden);
    const modeloNorm = normalizar(modelo);
    const clienteNorm = normalizar(cliente);

    if (ordenNorm) {
      const dupOrden = todosEquipos.find((e) => normalizar(e.orden) === ordenNorm);
      if (dupOrden) {
        const cerrado = dupOrden.estado === "Listo" || dupOrden.estado === "Entregado";
        alertaDup.replaceChildren(
          el("div", { class: "alerta-dup" },
            el("p", {}, cerrado
              ? `La orden #${dupOrden.orden} ya existe y figura como "${dupOrden.estado}". Si el equipo regresó, reabre su bitácora para conservar el historial.`
              : `Ya existe una bitácora activa para la orden #${dupOrden.orden} (${dupOrden.estado}). No se permiten duplicados.`),
            el("div", { class: "row", style: "margin-top:8px;flex-wrap:wrap" },
              el("button", { type: "button", onclick: () => abrirOReabrir(dupOrden) },
                cerrado ? "Reabrir bitácora (Reingreso)" : "Abrir bitácora existente")))
        );
        return;
      }
    }

    if (!forzar && clienteNorm && modeloNorm) {
      const dupEquipo = todosEquipos.find(
        (e) => normalizar(e.cliente) === clienteNorm && normalizar(e.modelo) === modeloNorm
      );
      if (dupEquipo) {
        const cerrado = dupEquipo.estado === "Listo" || dupEquipo.estado === "Entregado";
        alertaDup.replaceChildren(
          el("div", { class: "alerta-dup" },
            el("p", {}, `Ya existe un registro de "${dupEquipo.modelo}" para "${dupEquipo.cliente}" (${dupEquipo.estado}). ¿Es el mismo equipo?`),
            el("div", { class: "row", style: "margin-top:8px;flex-wrap:wrap" },
              el("button", { type: "button", onclick: () => abrirOReabrir(dupEquipo) },
                cerrado ? "Reabrir bitácora anterior" : "Abrir bitácora existente"),
              el("button", { type: "button", class: "sec", onclick: () => agregar(null, true) },
                "Es otro equipo, crear nueva")))
        );
        return;
      }
    }

    const nombre = tituloEquipo({ orden, modelo, cliente });
    addDoc(collection(db, "equipos"), {
      orden, modelo, cliente, foto: fotoEquipo, nombre,
      estado: ESTADOS[0], entregadoEn: null, pendiente: "", pendientes: [], ultimaNota: "", ultimaFecha: "",
      creadoPor: nombreDe(user), actualizado: serverTimestamp(),
    });
    inOrden.value = "";
    inModelo.value = "";
    inCliente.value = "";
    fotoEquipo = "";
    avisoForm.textContent = "";
    pintarPrevia();

    if (formAbiertoMovil) {
      formAbiertoMovil = false;
      formNuevo.classList.add("form-oculto-movil");
      btnToggleNuevo.textContent = "+ Nuevo equipo";
      btnToggleNuevo.classList.remove("sec");
    }
  };

  const panelNuevo = el("div", { class: "sticky" },
    el("div", { class: "lista-head solo-pc" }, el("h2", {}, "Nuevo equipo")),
    btnToggleNuevo,
    formNuevo
  );

  const panelLista = el("div", {},
    el("div", { class: "lista-head" },
      el("h2", {}, "Lista de equipos"),
      el("div", { class: "lista-tools" }, contador, btnBuscar)),
    barraBuscar,
    bannerRezago,
    lista
  );

  pintar(
    el("header", {}, el("h1", {}, "Bitácora de taller"),
      el("div", { class: "row" },
        perfil.rol === "admin" ? el("button", { class: "sec btn-sm", onclick: vistaUsuarios }, "Usuarios") : null,
        el("button", { class: "sec btn-sm", onclick: () => signOut(auth) }, "Salir"))),
    el("div", { class: "cols" }, panelNuevo, panelLista)
  );
  root.className = "ancho";

  unsubs.push(onSnapshot(query(collection(db, "equipos"), orderBy("actualizado", "desc")), (snap) => {
    todosEquipos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    limpiarVencidos(todosEquipos);
    renderLista();
  }));
}

function vistaEquipo(id) {
  const ref = doc(db, "equipos", id);
  const titulo = el("h1", {}, "");
  const estadoBadge = el("span", { class: "estado", style: "margin-bottom:0" }, "");
  const clienteSub = el("span", { class: "autor" });
  const subEquipo = el("div", { class: "sub-equipo" }, estadoBadge, clienteSub);

  const estado = el("select", {
    onchange: () => {
      const nuevoEstado = estado.value;
      updateDoc(ref, {
        estado: nuevoEstado,
        entregadoEn: nuevoEstado === "Entregado" ? Date.now() : null,
        actualizado: serverTimestamp(),
      });
    },
  }, ESTADOS.map((s) => el("option", { value: s }, s)));

  const notaRetencion = el("p", { class: "msg", hidden: true });
  const btnReingreso = el("button", {
    type: "button",
    class: "sec btn-sm",
    style: "margin-top:8px",
    hidden: true,
    onclick: () => {
      updateDoc(ref, {
        estado: ESTADOS[0],
        entregadoEn: null,
        ultimaNota: "Reingreso al taller",
        ultimaFecha: hoy(),
        actualizado: serverTimestamp(),
      });
    },
  }, "Registrar reingreso (volver a diagnóstico)");

  const fichaBox = el("div");
  const avisoPend = el("p", { class: "msg" });
  const pendHistBox = el("div");
  const nota = el("textarea", { placeholder: "Qué se hizo en este equipo" });
  const aviso = el("p", { class: "msg" });
  const notasBox = el("div");
  let equipoActual = null;
  let notasActuales = [];
  let docsNotasOrdenados = [];
  let editandoId = null;
  let reporteAbierto = false;

  const pendiente = el("textarea", {
    placeholder: "Escribe algo que falte por hacer (Enter para agregar)",
    onkeydown: (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        agregarPendiente();
      }
    },
  });

  const guardarListaPendientes = (nuevaLista) => {
    updateDoc(ref, {
      pendientes: nuevaLista,
      pendiente: nuevaLista.map((p) => p.texto).join(" · "),
      actualizado: serverTimestamp(),
    });
  };

  const agregarPendiente = () => {
    const lineas = pendiente.value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lineas.length) return;

    const actuales = obtenerListaPendientes(equipoActual);
    const autor = nombreDe(user);

    const nuevos = lineas.map((texto, idx) => ({
      id: `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
      texto,
      subrayado: false,
      autor,
    }));

    guardarListaPendientes([...actuales, ...nuevos]);
    pendiente.value = "";
    ajustarAltura(pendiente);
    avisoPend.textContent = nuevos.length === 1
      ? "Agregado a lo que falta por hacer."
      : `${nuevos.length} pendientes agregados.`;
  };

  let fotos = [];
  const previas = el("div", { class: "fotos" });
  const btnFotoNota = el("button", {
    type: "button",
    class: "sec btn-sm",
    onclick: () => {
      if (fotos.length >= 3) { aviso.textContent = "Máximo 3 fotos por nota."; return; }
      seleccionarFoto(
        (url) => { fotos.push(url); pintarPrevias(); aviso.textContent = ""; },
        () => { aviso.textContent = "No se pudo leer la foto."; }
      );
    },
  }, "+ Agregar foto (0/3)");

  const pintarPrevias = () => {
    btnFotoNota.textContent = `+ Agregar foto (${fotos.length}/3)`;
    previas.replaceChildren(...fotos.map((src, i) =>
      el("div", { class: "foto" },
        el("img", { src, alt: "Foto adjunta", onclick: () => verFoto(src) }),
        el("button", { class: "sec x", title: "Quitar foto", onclick: () => { fotos.splice(i, 1); pintarPrevias(); } }, "×"))));
  };

  const panelReporte = el("div", { class: "panel-reporte" });
  const btnCrearReporte = el("button", {
    type: "button",
    class: "btn-sm btn-reporte-movil",
    hidden: true,
    onclick: () => {
      reporteAbierto = !reporteAbierto;
      actualizarModoVista();
      if (reporteAbierto) nota.focus();
    },
  }, "Crear nuevo reporte");

  function actualizarModoVista() {
    const tieneHistorial = docsNotasOrdenados.length > 0 || obtenerListaPendientes(equipoActual).length > 0;
    btnCrearReporte.hidden = !tieneHistorial;
    if (!tieneHistorial) {
      reporteAbierto = false;
      panelReporte.classList.remove("oculto-movil");
      return;
    }
    panelReporte.classList.toggle("oculto-movil", !reporteAbierto);
    btnCrearReporte.textContent = reporteAbierto ? "Cerrar reporte" : "Crear nuevo reporte";
    btnCrearReporte.classList.toggle("sec", reporteAbierto);
  }

  const guardarNota = () => {
    const texto = nota.value.trim();
    if (!texto && !fotos.length) return;
    const f = hoy();
    const hora = horaActual();
    addDoc(collection(db, "equipos", id, "notas"), {
      fecha: f, hora, creada: Date.now(), texto, fotos,
      autorUid: user.uid, autorNombre: nombreDe(user), actualizada: serverTimestamp(),
    }).catch(() => { aviso.textContent = "No se pudo guardar: la nota con fotos es demasiado grande. Quita una foto."; });
    updateDoc(ref, { ultimaNota: texto || "(foto)", ultimaFecha: f, actualizado: serverTimestamp() });
    nota.value = "";
    ajustarAltura(nota);
    fotos = [];
    pintarPrevias();
    aviso.textContent = "Nota agregada al historial.";
    reporteAbierto = false;
    actualizarModoVista();
  };

  function renderNotaItem(d) {
    const n = d.data();
    const esMia = n.autorUid === user.uid;
    const esMasReciente = docsNotasOrdenados[0] && docsNotasOrdenados[0].id === d.id;
    const horaTexto = n.hora || "Sin hora";

    if (editandoId === d.id) {
      const areaEdit = el("textarea", { value: n.texto || "" });
      const avisoEdit = el("p", { class: "msg" });
      let fotosEdit = [...(n.fotos || [])];
      const previasEdit = el("div", { class: "fotos" });

      const pintarPreviasEdit = () => previasEdit.replaceChildren(...fotosEdit.map((src, i) =>
        el("div", { class: "foto" },
          el("img", { src, alt: "Foto adjunta", onclick: () => verFoto(src) }),
          el("button", { type: "button", class: "sec x", title: "Quitar foto", onclick: () => { fotosEdit.splice(i, 1); pintarPreviasEdit(); } }, "×"))));
      pintarPreviasEdit();

      const agregarFotoEdit = () => {
        if (fotosEdit.length >= 3) { avisoEdit.textContent = "Máximo 3 fotos por nota."; return; }
        seleccionarFoto(
          (url) => { fotosEdit.push(url); pintarPreviasEdit(); avisoEdit.textContent = ""; },
          () => { avisoEdit.textContent = "No se pudo leer la foto."; }
        );
      };

      const guardarEdicion = () => {
        const nuevoTexto = areaEdit.value.trim();
        if (!nuevoTexto && !fotosEdit.length) {
          avisoEdit.textContent = "La nota no puede quedar vacía sin fotos.";
          return;
        }
        updateDoc(doc(db, "equipos", id, "notas", d.id), {
          texto: nuevoTexto,
          fotos: fotosEdit,
          editada: true,
          actualizada: serverTimestamp(),
        }).catch(() => {
          avisoEdit.textContent = "No se pudo guardar: la nota con fotos es demasiado grande.";
        });

        if (esMasReciente) {
          updateDoc(ref, { ultimaNota: nuevoTexto || "(foto)" });
        }
        editandoId = null;
        pintarNotasPorDia();
      };

      return el("div", { class: "nota nota-edit" },
        el("div", { class: "nota-head" },
          el("time", {}, horaTexto, n.editada ? el("span", { class: "hora" }, " · editada") : null),
          el("span", { class: "autor" }, n.autorNombre)),
        areaEdit,
        previasEdit,
        el("div", { class: "row", style: "margin-top:8px;flex-wrap:wrap" },
          el("button", { type: "button", class: "btn-sm", onclick: guardarEdicion }, "Guardar"),
          el("button", { type: "button", class: "sec btn-sm", onclick: () => { editandoId = null; pintarNotasPorDia(); } }, "Cancelar"),
          el("button", { type: "button", class: "sec btn-sm", onclick: agregarFotoEdit }, "+ Foto")),
        avisoEdit);
    }

    return el("div", { class: "nota" },
      el("div", { class: "nota-head" },
        el("time", {}, horaTexto, n.editada ? el("span", { class: "hora" }, " · editada") : null),
        el("div", { class: "nota-tools" },
          el("span", { class: "autor" }, n.autorNombre),
          esMia ? el("button", {
            type: "button",
            class: "sec btn-xs",
            onclick: () => { editandoId = d.id; pintarNotasPorDia(); },
          }, "Editar") : null)),
      el("p", {}, n.texto),
      n.fotos && n.fotos.length ? el("div", { class: "galeria" }, n.fotos.map((src) => el("img", { src, alt: "Foto de la nota", onclick: () => verFoto(src) }))) : null);
  }

  function pintarNotasPorDia() {
    if (!docsNotasOrdenados.length) {
      notasBox.replaceChildren(el("p", { class: "vacio" }, "Sin notas todavía. Escribe la primera arriba."));
      return;
    }

    const fechasOrdenadas = [...new Set(docsNotasOrdenados.map((d) => d.data().fecha || ""))]
      .sort((a, b) => b.localeCompare(a));

    const bloques = [];
    for (const fecha of fechasOrdenadas) {
      const notasDelDia = docsNotasOrdenados.filter((d) => (d.data().fecha || "") === fecha);
      bloques.push(
        el("div", { class: "dia-titulo" }, tituloDia(fecha)),
        el("div", { class: "dia-caja" }, notasDelDia.map((d) => renderNotaItem(d)))
      );
    }

    notasBox.replaceChildren(...bloques);
  }

  const verResumen = async () => {
    const usarIA = Boolean(GEMINI_API_KEY && notasActuales.length && navigator.onLine);
    let res = usarIA
      ? { cliente: "", tecnico: "" }
      : generarResumenesLocal(notasActuales);
    const estadoCopia = el("p", { class: "msg" });

    const copiarTexto = async (area, etiqueta) => {
      if (!area.value.trim()) return;
      try {
        await navigator.clipboard.writeText(area.value);
        estadoCopia.textContent = `${etiqueta} copiado al portapapeles.`;
      } catch {
        area.select();
        estadoCopia.textContent = `Selecciona el texto de ${etiqueta.toLowerCase()} y cópialo (Ctrl+C).`;
      }
    };

    const contadorPalabras = el("span", { class: "word-count" });
    const actualizarContador = (txt) => {
      const n = contarPalabras(txt);
      contadorPalabras.textContent = `${n}/20 palabras`;
      contadorPalabras.classList.toggle("exceso", n > 20);
    };

    const areaCliente = el("textarea", {
      class: "area-cliente",
      value: res.cliente,
      oninput: () => actualizarContador(areaCliente.value),
    });
    actualizarContador(areaCliente.value);

    const areaTecnico = el("textarea", {
      class: "area-tecnico",
      value: res.tecnico,
    });

    const aplicarResultado = (nuevoRes, mensajeEstado) => {
      res = nuevoRes;
      areaCliente.value = res.cliente;
      actualizarContador(areaCliente.value);
      areaTecnico.value = res.tecnico;
      ajustarAltura(areaCliente);
      ajustarAltura(areaTecnico);
      estadoCopia.textContent = mensajeEstado;
    };

    const ejecutarIA = async (forzar = false) => {
      if (!GEMINI_API_KEY) return;
      if (!navigator.onLine) {
        aplicarResultado(generarResumenesLocal(notasActuales), "Sin conexión: usando resumen local.");
        return;
      }
      areaCliente.value = "";
      areaTecnico.value = "";
      ajustarAltura(areaCliente);
      ajustarAltura(areaTecnico);
      actualizarContador("");
      estadoCopia.textContent = "Redactando diagnósticos con Gemini...";
      if (btnRegenerar) btnRegenerar.disabled = true;
      const iaRes = await generarResumenesGemini(notasActuales, equipoActual, forzar);
      if (btnRegenerar) btnRegenerar.disabled = false;
      if (iaRes.ok) {
        aplicarResultado(iaRes.data, "Diagnósticos generados con Gemini.");
      } else {
        aplicarResultado(
          generarResumenesLocal(notasActuales),
          `Gemini (${iaRes.error}); se muestra el resumen local.`
        );
      }
    };

    const btnRegenerar = GEMINI_API_KEY
      ? el("button", { type: "button", class: "sec btn-sm", onclick: () => ejecutarIA(true) }, "Regenerar")
      : null;

    const modal = el("div", { class: "modal", onclick: (ev) => { if (ev.target === modal) modal.remove(); } },
      el("div", { class: "card" },
        el("div", { class: "row", style: "justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap" },
          el("h2", { style: "margin:0" }, "Resúmenes para orden de salida"),
          el("div", { class: "row" },
            btnRegenerar,
            el("button", { type: "button", class: "sec btn-sm", onclick: () => modal.remove() }, "Cerrar"))),
        el("div", { class: "resumen-bloque" },
          el("div", { class: "resumen-head" },
            el("span", { class: "resumen-titulo" }, "Diagnóstico cliente"),
            el("div", { class: "resumen-tools" },
              contadorPalabras,
              el("button", { type: "button", class: "btn-xs", onclick: () => copiarTexto(areaCliente, "Diagnóstico cliente") }, "Copiar"))),
          areaCliente),
        el("div", { class: "resumen-bloque" },
          el("div", { class: "resumen-head" },
            el("span", { class: "resumen-titulo" }, "Diagnóstico técnico"),
            el("div", { class: "resumen-tools" },
              el("button", { type: "button", class: "btn-xs", onclick: () => copiarTexto(areaTecnico, "Diagnóstico técnico") }, "Copiar"))),
          areaTecnico),
        estadoCopia));

    document.body.append(modal);
    ajustarAltura(areaCliente);
    ajustarAltura(areaTecnico);
    if (usarIA) {
      await ejecutarIA(false);
    }
  };

  const btnEliminar = perfil && perfil.rol === "admin"
    ? el("button", {
        type: "button",
        class: "btn-peligro btn-sm",
        onclick: async () => {
          if (!confirm("¿Eliminar este equipo y todas sus notas y fotos de forma permanente?")) return;
          btnEliminar.disabled = true;
          btnEliminar.textContent = "Eliminando...";
          try {
            await eliminarEquipoCompleto(id);
            vistaLista();
          } catch {
            btnEliminar.disabled = false;
            btnEliminar.textContent = "Eliminar";
            alert("No se pudo eliminar. Revisa que publicaste las nuevas reglas en Firebase.");
          }
        },
      }, "Eliminar")
    : null;

  panelReporte.append(
    el("div", { class: "card" },
      el("label", { style: "margin-top:0" }, "Estado"),
      estado,
      notaRetencion,
      btnReingreso,
      fichaBox),
    el("div", { class: "falta", style: "margin-bottom:12px" },
      el("h2", {}, "Falta hacer"),
      pendiente,
      el("p", { style: "margin:8px 0 0" }, el("button", { onclick: agregarPendiente }, "Agregar pendiente")),
      avisoPend),
    el("div", { class: "card", style: "margin-bottom:0" },
      el("h2", {}, "Nueva nota"),
      nota,
      previas,
      el("div", { class: "row", style: "margin-top:10px;justify-content:space-between;flex-wrap:wrap" },
        btnFotoNota,
        el("button", { onclick: guardarNota }, "Guardar nota")),
      aviso)
  );

  pintar(
    el("header", { class: "head-equipo" },
      el("button", { class: "sec btn-sm", onclick: vistaLista }, "Volver"),
      el("div", { class: "head-acciones" }, btnCrearReporte, btnEliminar),
      titulo,
      subEquipo),
    el("div", { class: "cols" },
      el("div", { class: "izq" }, panelReporte),
      el("div", { class: "card hist" },
        el("div", { class: "row", style: "justify-content:space-between;align-items:center;margin-bottom:8px" },
          el("h2", { style: "margin:0" }, "Historial"),
          el("button", { class: "sec btn-sm", onclick: verResumen }, "Resumen salida")),
        pendHistBox,
        notasBox))
  );
  root.className = "ancho";

  unsubs.push(onSnapshot(ref, (d) => {
    const e = d.data(); if (!e) return;
    equipoActual = e;
    titulo.textContent = tituloEquipo(e);
    estadoBadge.textContent = e.estado;
    estadoBadge.className = "estado" + (e.estado === "Listo" ? " listo" : "");
    clienteSub.textContent = e.cliente ? `Cliente: ${e.cliente}` : "";
    estado.value = e.estado;
    btnReingreso.hidden = !(e.estado === "Listo" || e.estado === "Entregado");

    const restantes = diasParaBorrar(e);
    if (restantes !== null) {
      notaRetencion.hidden = false;
      notaRetencion.textContent = restantes === 0
        ? "Plazo de 30 días cumplido: se eliminará automáticamente."
        : `Se eliminará automáticamente en ${restantes} ${restantes === 1 ? "día" : "días"} (30 días tras entregarse).`;
    } else {
      notaRetencion.hidden = true;
    }

    const listaPend = obtenerListaPendientes(e);
    if (listaPend.length) {
      pendHistBox.replaceChildren(
        el("div", { class: "hist-pend" },
          el("div", { class: "hist-pend-head" },
            el("span", { class: "hist-pend-tag" }, "Falta hacer"),
            el("span", { class: "autor" }, `${listaPend.length} ${listaPend.length === 1 ? "pendiente" : "pendientes"}`)),
          listaPend.map((item, idx) => {
            const marcado = Boolean(item.subrayado);
            const toggleSubrayado = () => {
              const copia = listaPend.map((p, i) => i === idx ? { ...p, subrayado: !marcado } : p);
              guardarListaPendientes(copia);
            };
            const quitarItem = () => {
              const copia = listaPend.filter((_, i) => i !== idx);
              guardarListaPendientes(copia);
            };
            return el("div", { class: "pend-item" + (marcado ? " marcado" : "") },
              el("div", { class: "pend-body" },
                el("p", { class: "pend-texto" + (marcado ? " subrayado" : "") }, item.texto),
                item.autor ? el("div", { class: "pend-meta" }, item.autor) : null),
              el("div", { class: "pend-acciones" },
                el("button", {
                  type: "button",
                  class: (marcado ? "" : "sec ") + "btn-xs",
                  onclick: toggleSubrayado,
                }, marcado ? "Subrayado ✓" : "Subrayar"),
                el("button", {
                  type: "button",
                  class: "sec btn-xs",
                  title: "Quitar este pendiente",
                  onclick: quitarItem,
                }, "×")));
          }))
      );
    } else {
      pendHistBox.replaceChildren();
    }

    const tieneDatos = e.orden || e.cliente || e.modelo || e.foto;
    if (tieneDatos) {
      fichaBox.replaceChildren(
        el("div", { class: "ficha" },
          e.foto ? el("img", { src: e.foto, alt: "Foto del equipo", onclick: () => verFoto(e.foto) }) : null,
          el("div", {},
            e.orden ? el("p", {}, el("b", {}, "Orden: "), `#${e.orden}`) : null,
            e.cliente ? el("p", {}, el("b", {}, "Cliente: "), e.cliente) : null,
            e.modelo ? el("p", {}, el("b", {}, "Modelo: "), e.modelo) : null))
      );
    } else {
      fichaBox.replaceChildren();
    }

    actualizarModoVista();
  }));

  unsubs.push(onSnapshot(query(collection(db, "equipos", id, "notas"), orderBy("fecha", "desc")), (snap) => {
    docsNotasOrdenados = [...snap.docs]
      .filter((d) => d.data().tipo !== "pendiente")
      .sort((a, b) => {
        const na = a.data(), nb = b.data();
        const cmpFecha = (nb.fecha || "").localeCompare(na.fecha || "");
        if (cmpFecha !== 0) return cmpFecha;
        return (nb.creada || 0) - (na.creada || 0);
      });
    notasActuales = docsNotasOrdenados.map((d) => d.data());
    pintarNotasPorDia();
    actualizarModoVista();
  }));
}