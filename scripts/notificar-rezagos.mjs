import admin from "firebase-admin";

const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
admin.initializeApp({ credential: admin.credential.cert(cred) });

const db = admin.firestore();
const MS_DIA = 24 * 60 * 60 * 1000;

function tituloEquipo(e) {
  const partes = [e.orden ? `#${e.orden}` : "", e.modelo].filter(Boolean);
  return partes.length ? partes.join(" · ") : (e.cliente || e.nombre || "Equipo sin datos");
}

function diasSinCambios(e) {
  let inicio = null;
  if (e.actualizado && typeof e.actualizado.toMillis === "function") {
    inicio = e.actualizado.toMillis();
  } else if (e.ultimaFecha) {
    const t = new Date(e.ultimaFecha + "T12:00:00").getTime();
    if (!Number.isNaN(t)) inicio = t;
  }
  if (!inicio) return 0;
  return Math.floor((Date.now() - inicio) / MS_DIA);
}

const snapEquipos = await db.collection("equipos").get();
const paraAvisar = [];

for (const d of snapEquipos.docs) {
  const e = d.data();
  if (e.estado === "Listo" || e.estado === "Entregado") continue;
  const dias = diasSinCambios(e);
  // Avisa a partir del día 7 y luego cada 2 días (7, 9, 11, 13...)
  if (dias >= 7 && (dias - 7) % 2 === 0) {
    paraAvisar.push({ titulo: tituloEquipo(e), dias });
  }
}

if (!paraAvisar.length) {
  console.log("Sin equipos para notificar hoy.");
  process.exit(0);
}

const snapUsers = await db.collection("usuarios").get();
const tokens = [...new Set(
  snapUsers.docs.flatMap((d) => Array.isArray(d.data().fcmTokens) ? d.data().fcmTokens : [])
)].filter(Boolean);

if (!tokens.length) {
  console.log("No hay dispositivos registrados con token FCM.");
  process.exit(0);
}

const titulo = paraAvisar.length === 1
  ? "1 equipo sin movimiento en taller"
  : `${paraAvisar.length} equipos sin movimiento en taller`;
const lista = paraAvisar.slice(0, 3).map((x) => `${x.titulo} (${x.dias} d)`).join(", ");
const extra = paraAvisar.length > 3 ? ` y ${paraAvisar.length - 3} más.` : ".";

const res = await admin.messaging().sendEachForMulticast({
  tokens,
  notification: { title: titulo, body: `${lista}${extra}` },
});

console.log(`Enviadas: ${res.successCount}, fallidas: ${res.failureCount}`);