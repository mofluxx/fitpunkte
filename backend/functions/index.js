// FitPunkte – Push-Nachrichten
// 1) onTeamChange: schickt dem Partner eine Nachricht bei Training, Einlösen, Wunsch, Reaktion …
// 2) dailyReminder: täglich 18:00 – Erinnerung nach 2 Tagen Pause oder bei geplantem Training
// 3) scanMeal: Foto vom Essen -> Gemini erkennt Lebensmittel, Menge und Nährwerte

const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const GEMINI_KEY = defineSecret("GEMINI_API_KEY");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "europe-west3", maxInstances: 2 });

const APP_URL = "https://mofluxx.github.io/fitpunkte/";
const db = () => admin.firestore();

// ---------- Hilfen ----------
const dayKey = (ts) => new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }); // YYYY-MM-DD
const nameOf = (d, uid) => (d.people && d.people[uid] && d.people[uid].name) || "Dein Partner";
const wants = (d, uid, kind) => !(d.people && d.people[uid] && d.people[uid].notify && d.people[uid].notify[kind] === false);

async function sendTo(uid, title, body, tag) {
  const ref = db().collection("users").doc(uid);
  const snap = await ref.get();
  const tokens = (snap.exists && snap.data().tokens) || [];
  if (!tokens.length) return 0;
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    data: { title, body, tag: tag || "", url: APP_URL },
    webpush: { notification: { title, body, icon: APP_URL + "icon-192.png", tag: tag || undefined }, fcmOptions: { link: APP_URL } },
  });
  // ungültige Tokens aufräumen
  const bad = [];
  res.responses.forEach((r, i) => {
    const c = r.error && r.error.code;
    if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token") bad.push(tokens[i]);
  });
  if (bad.length) await ref.update({ tokens: admin.firestore.FieldValue.arrayRemove(...bad) });
  return res.successCount;
}

// Unterschiede zwischen altem und neuem Stand -> Nachrichten
function diffMessages(b, a) {
  const out = [];
  const members = a.members || [];
  const others = (uid) => members.filter((m) => m !== uid);
  const push = (to, title, body, tag) => { if (to && wants(a, to, "partner")) out.push({ to, title, body, tag }); };

  // neue Trainings (nur frische, keine nachgetragenen von vor Tagen)
  const oldW = new Set((b.workouts || []).map((w) => w.id));
  for (const w of a.workouts || []) {
    if (!oldW.has(w.id) && w.uid && Date.now() - w.d < 36 * 3600e3)
      others(w.uid).forEach((to) => push(to, `${nameOf(a, w.uid)} hat trainiert 💪`, `${w.t} · ${w.m} Min`, "w" + w.uid));
  }
  // neue Reaktionen
  const oldWMap = Object.fromEntries((b.workouts || []).map((w) => [w.id, w]));
  for (const w of a.workouts || []) {
    const before = (oldWMap[w.id] && oldWMap[w.id].react) || {};
    for (const [uid, e] of Object.entries(w.react || {})) {
      if (before[uid] !== e && uid !== w.uid) push(w.uid, `${nameOf(a, uid)} reagiert ${e}`, `auf dein Training: ${w.t}`, "r" + w.id);
    }
  }
  // angezweifelt / abgelehnt / Zweifel zurückgenommen
  for (const w of a.workouts || []) {
    const o = oldWMap[w.id];
    if (!o || !w.uid) continue;
    if (w.disputed && !o.disputed) push(w.uid, `${nameOf(a, w.disputed.by)} zweifelt dein Training an 🤨`, `${w.t} · ${w.m} Min – Punkte sind eingefroren`, "d" + w.id);
    if (w.rejected && !o.rejected) push(w.uid, `${nameOf(a, w.rejected.by)} hat dein Training abgelehnt`, `${w.t} · ${w.m} Min`, "d" + w.id);
    if (o.disputed && !w.disputed && !w.rejected) push(w.uid, "Zweifel zurückgenommen ✓", `${w.t} zählt wieder`, "d" + w.id);
  }
  // eingelöst / erledigt
  const oldR = Object.fromEntries((b.redeemed || []).map((r) => [r.id, r]));
  for (const r of a.redeemed || []) {
    if (!oldR[r.id] && r.uid) others(r.uid).forEach((to) => push(to, `${nameOf(a, r.uid)} hat eingelöst 🎁`, r.n, "x" + r.id));
    else if (oldR[r.id] && oldR[r.id].done === false && r.done === true && r.uid) push(r.uid, "Belohnung erledigt ✓", r.n, "x" + r.id);
  }
  // Wünsche
  const oldQ = new Set((b.wishes || []).map((q) => q.id));
  for (const q of a.wishes || []) {
    if (!oldQ.has(q.id) && q.uid) others(q.uid).forEach((to) => push(to, `${nameOf(a, q.uid)} wünscht sich etwas`, q.n, "q" + q.id));
  }
  const newRewards = new Set((a.rewards || []).map((r) => r.id));
  for (const r of a.rewards || []) {
    const wasThere = (b.rewards || []).some((x) => x.id === r.id);
    if (!wasThere && r.from) push(r.from, "Wunsch freigegeben ✨", `${r.n} · ${r.c} Punkte`, "f" + r.id);
  }
  return out;
}
exports._diffMessages = diffMessages; // für Tests

exports.onTeamChange = onDocumentUpdated("fitpunkte/{code}", async (event) => {
  const b = event.data.before.data() || {};
  const a = event.data.after.data() || {};
  const msgs = diffMessages(b, a);
  await Promise.all(msgs.slice(0, 10).map((m) => sendTo(m.to, m.title, m.body, m.tag).catch((e) => console.error(e))));
});

// ---------- tägliche Erinnerung ----------
function reminderFor(d, uid, now) {
  if (!wants(d, uid, "reminder")) return null;
  const today = dayKey(now);
  const plans = (d.plans || []).filter((p) => p.day === today && (p.uid || uid) === uid);
  const doneToday = (d.workouts || []).some((w) => w.uid === uid && dayKey(w.d) === today);
  if (plans.length && !doneToday) return { title: "Heute geplant 📅", body: plans.map((p) => p.t + (p.m ? ` · ${p.m} Min` : "")).join(", ") };
  const pauses = new Set((d.people && d.people[uid] && d.people[uid].pauses) || []);
  const mine = (d.workouts || []).filter((w) => w.uid === uid);
  if (!mine.length || doneToday || pauses.has(today)) return null;
  const last = Math.max(...mine.map((w) => w.d));
  const days = Math.round((new Date(today) - new Date(dayKey(last))) / 864e5);
  if (days === 2) return { title: "Zeit für Bewegung", body: "Seit 2 Tagen kein Training – schon 15 Minuten zählen." };
  if (days === 4) return { title: "Wir vermissen dich 👋", body: "4 Tage Pause. Ein kurzer Spaziergang bringt dich zurück in den Rhythmus." };
  return null;
}
exports._reminderFor = reminderFor;

exports.dailyReminder = onSchedule({ schedule: "0 18 * * *", timeZone: "Europe/Berlin" }, async () => {
  const teams = await db().collection("fitpunkte").get();
  const now = Date.now();
  const jobs = [];
  teams.forEach((doc) => {
    const d = doc.data();
    for (const uid of d.members || []) {
      const r = reminderFor(d, uid, now);
      if (r) jobs.push(sendTo(uid, r.title, r.body, "reminder").catch((e) => console.error(e)));
    }
  });
  await Promise.all(jobs);
});


// ---------- 3) Essen per Foto erkennen (Gemini) ----------
const MODELS = ["gemini-flash-latest", "gemini-3.5-flash-lite"];
const MAX_PER_DAY = 40;
const PROMPT = `Du bist Ernährungsberater. Erkenne alle Lebensmittel und Getränke auf dem Foto.
Schätze für jedes die Menge in Gramm (bzw. ml), so realistisch wie möglich anhand von Teller, Besteck und Verpackung.
Denke an sichtbares Öl, Butter, Soßen und Dressings als eigene Einträge.
Gib Nährwerte PRO 100 g an (typische deutsche Werte, z. B. wie im Bundeslebensmittelschlüssel).
Namen kurz auf Deutsch, z. B. "Spaghetti, gekocht", "Tomatensoße", "Parmesan".
Ist kein Essen zu sehen, gib eine leere Liste zurück.`;
const SCHEMA = {
  type: "OBJECT",
  properties: {
    dish: { type: "STRING", description: "Kurzer Name des Gerichts" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          grams: { type: "NUMBER" },
          kcal100: { type: "NUMBER" },
          protein100: { type: "NUMBER" },
          carbs100: { type: "NUMBER" },
          fat100: { type: "NUMBER" },
          confidence: { type: "STRING", enum: ["hoch", "mittel", "niedrig"] },
        },
        required: ["name", "grams", "kcal100", "protein100", "carbs100", "fat100", "confidence"],
      },
    },
  },
  required: ["dish", "items"],
};

exports.scanMeal = onCall({ secrets: [GEMINI_KEY], invoker: "public", timeoutSeconds: 60, memory: "256MiB" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Bitte anmelden.");
  const img = req.data && req.data.image;
  if (typeof img !== "string" || img.length < 1000 || img.length > 3_000_000) throw new HttpsError("invalid-argument", "Bild fehlt oder ist zu groß.");
  const hint = String((req.data && req.data.hint) || "").slice(0, 200);

  // Tageslimit pro Person
  const ref = db().doc(`limits/${req.auth.uid}`);
  const today = dayKey(Date.now());
  await db().runTransaction(async (t) => {
    const d = (await t.get(ref)).data() || {};
    const n = d.day === today ? d.scans || 0 : 0;
    if (n >= MAX_PER_DAY) throw new HttpsError("resource-exhausted", "Tageslimit für Foto-Erkennung erreicht.");
    t.set(ref, { day: today, scans: n + 1 }, { merge: true });
  });

  const body = {
    contents: [{ role: "user", parts: [
      { text: PROMPT + (hint ? `\nHinweis vom Nutzer: ${hint}` : "") },
      { inline_data: { mime_type: "image/jpeg", data: img } },
    ] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.2 },
  };
  let lastErr = "";
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY.value() },
        body: JSON.stringify(body),
      });
      if (!r.ok) { lastErr = `${model}: ${r.status} ${(await r.text()).slice(0, 300)}`; continue; }
      const j = await r.json();
      const txt = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts.map((p) => p.text || "").join("");
      const out = JSON.parse(txt || "{}");
      const num = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
      const items = (out.items || []).slice(0, 12).map((x) => ({
        name: String(x.name || "Lebensmittel").slice(0, 60),
        grams: Math.round(num(x.grams, 2000)),
        kcal100: Math.round(num(x.kcal100, 900)),
        protein100: +num(x.protein100, 100).toFixed(1),
        carbs100: +num(x.carbs100, 100).toFixed(1),
        fat100: +num(x.fat100, 100).toFixed(1),
        confidence: ["hoch", "mittel", "niedrig"].includes(x.confidence) ? x.confidence : "mittel",
      })).filter((x) => x.grams > 0);
      return { dish: String(out.dish || "").slice(0, 80), items, model };
    } catch (e) { lastErr = `${model}: ${e.message}`; }
  }
  console.error("scanMeal fehlgeschlagen", lastErr);
  throw new HttpsError("unavailable", "Erkennung gerade nicht möglich. Bitte später nochmal.");
});
