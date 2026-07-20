"use strict";
/* FLAPS Signage — backend MVP
   Cuentas + pareo de pantallas por código + estado por pantalla + push en vivo (WebSocket).
   Stripe opcional vía variables de entorno. */

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
/* SESSION_SECRET es obligatorio: sin él cualquiera podría forjar cookies de sesión.
   En producción (Railway define RAILWAY_ENVIRONMENT) el proceso se niega a arrancar;
   en desarrollo local se genera uno efímero (las sesiones caducan al reiniciar). */
const SECRET = (()=>{
  if(process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV==="production"){
    console.error("FALTA la variable SESSION_SECRET. Defínela antes de arrancar en producción.");
    process.exit(1);
  }
  console.warn("AVISO: SESSION_SECRET no definida; usando secret efímero de desarrollo.");
  return crypto.randomBytes(32).toString("hex");
})();
/* ¿estamos en producción? (Railway define RAILWAY_ENVIRONMENT) */
const IS_PROD = !!(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production");
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "flaps.db");
// carpeta para vídeos subidos (foto plena viaja embebida; el vídeo no cabe).
// por defecto junto a la base de datos, para que caiga en el mismo disco persistente.
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(path.dirname(DB_FILE), "media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const MEDIA_MAX = (+process.env.MEDIA_MAX_MB || 250) * 1024 * 1024;
const MEDIA_EXT = ["mp4","webm","mov","m4v","ogg","ogv","png","jpg","jpeg","gif","webp"];
const TRIAL_DAYS = 7;
const PLAN_LIMITS = { uno: 1, tres: 3, cadena: 99 };

/* ---------- base de datos ---------- */
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass TEXT NOT NULL,
  salt TEXT NOT NULL,
  business TEXT DEFAULT '',
  plan TEXT DEFAULT 'tres',
  bill TEXT DEFAULT 'm',
  sub_status TEXT DEFAULT 'trial',
  trial_until INTEGER,
  created INTEGER
);
CREATE TABLE IF NOT EXISTS screens(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  token TEXT UNIQUE NOT NULL,
  code TEXT,
  name TEXT DEFAULT 'Pantalla',
  state TEXT,
  last_seen INTEGER,
  created INTEGER
);
CREATE TABLE IF NOT EXISTS resets(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
`);
// columnas de suscripción (se añaden si faltan, para bases de datos ya existentes)
{
  const have = db.prepare("PRAGMA table_info(users)").all().map(c=>c.name);
  const addCol = (name, decl)=>{ if(!have.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${decl}`); };
  addCol("stripe_customer_id", "TEXT");
  addCol("stripe_sub_id", "TEXT");
  addCol("current_period_end", "INTEGER");
  addCol("is_admin", "INTEGER DEFAULT 0");
}
// concede permiso de administrador a la cuenta propietaria (idempotente en cada arranque)
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "marcel@petguest.eu").toLowerCase().trim();
try{ db.prepare("UPDATE users SET is_admin=1 WHERE email=?").run(ADMIN_EMAIL); }catch(e){}

/* ---------- stripe (perezoso: solo si está configurado) ---------- */
let _stripe = null;
function stripe(){
  const key = process.env.STRIPE_SECRET_KEY;
  if(!key) return null;
  if(!_stripe) _stripe = require("stripe")(key);
  return _stripe;
}

/* ---------- email (SMTP, para recuperación de contraseña) ----------
   Se configura con SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS (+ MAIL_FROM opcional).
   Con DonDominio: SMTP_HOST=mailsrv1.dondominio.com, SMTP_PORT=465, SMTP_USER=hello@flappit.com.
   Si no está configurado, /api/forgot responde 503 y el panel muestra el email de contacto. */
let _mailer = null;
function mailer(){
  if(!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  if(!_mailer){
    const port = +process.env.SMTP_PORT || 465;
    _mailer = require("nodemailer").createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return _mailer;
}

/* ---------- utilidades ---------- */
const now = () => Date.now();
// ¿el usuario tiene acceso ahora mismo? (suscripción activa, o prueba vigente)
function entitled(u){
  if(!u) return false;
  if(u.sub_status==="active" || u.sub_status==="trialing") return true;
  if(u.sub_status==="trial" && u.trial_until && u.trial_until > now()) return true;
  return false;
}
const hash = (pass, salt) => crypto.scryptSync(pass, salt, 64).toString("hex");
const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("hex");
/* comparación en tiempo constante (evita ataques de temporización sobre firmas/hashes) */
function safeEqual(a, b){
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  if(A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function makeSession(userId){
  const exp = now() + 1000*60*60*24*30; // 30 días
  const body = userId + "." + exp;
  return body + "." + hmac(body);
}
function readSession(sid){
  if(!sid) return null;
  const parts = sid.split(".");
  if(parts.length!==3) return null;
  const body = parts[0]+"."+parts[1];
  if(!safeEqual(hmac(body), parts[2])) return null;
  if(+parts[1] < now()) return null;
  return +parts[0];
}
function getCookie(req, name){
  const c = req.headers.cookie || "";
  const m = c.match(new RegExp("(?:^|;\\s*)"+name+"=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(res, name, val, maxAgeSec){
  res.append("Set-Cookie",
    `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
    + (IS_PROD ? "; Secure" : ""));
}
function pairCode(){
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sin I/O para evitar confusión
  let code = "";
  for(let i=0;i<4;i++) code += letters[crypto.randomInt(letters.length)];
  return code;
}
function auth(req, res, next){
  const uid = readSession(getCookie(req, "sid"));
  if(!uid) return res.status(401).json({error:"no-auth"});
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(uid);
  if(!user) return res.status(401).json({error:"no-auth"});
  req.user = user;
  next();
}
// bloquea escrituras cuando la prueba caducó y no hay suscripción activa (402 = pago requerido)
function requirePaid(req, res, next){
  if(entitled(req.user)) return next();
  return res.status(402).json({error:"suscripcion-requerida"});
}
// solo administradores (panel interno)
function requireAdmin(req, res, next){
  if(req.user && req.user.is_admin) return next();
  return res.status(403).json({error:"solo-admin"});
}

/* ---------- rate limiting (en memoria, sin dependencias) ----------
   Protege login/register del ataque por fuerza bruta de contraseñas, y /api/pair
   del barrido de códigos de 4 letras. Cuenta por IP en una ventana deslizante. */
const rlBuckets = new Map(); // "prefijo:ip" -> {n, reset}
function clientIp(req){
  // Railway pone la IP real en X-Forwarded-For (primer valor)
  const xff = (req.headers["x-forwarded-for"]||"").split(",")[0].trim();
  return xff || req.socket.remoteAddress || "?";
}
function rateLimit(prefix, max, windowMs){
  return (req, res, next)=>{
    const key = prefix+":"+clientIp(req);
    const t = Date.now();
    let b = rlBuckets.get(key);
    if(!b || b.reset < t){ b = {n:0, reset: t+windowMs}; rlBuckets.set(key, b); }
    b.n++;
    if(b.n > max){
      res.set("Retry-After", String(Math.ceil((b.reset-t)/1000)));
      return res.status(429).json({error:"demasiados-intentos"});
    }
    next();
  };
}
setInterval(()=>{ // purga de cubos caducados y de tokens de reset vencidos
  const t = Date.now();
  rlBuckets.forEach((b,k)=>{ if(b.reset<t) rlBuckets.delete(k); });
  try{ db.prepare("DELETE FROM resets WHERE expires<?").run(t); }catch(e){}
}, 60000).unref();

/* ---------- app ---------- */
const app = express();

/* cabeceras de seguridad en todas las respuestas */
app.use((req, res, next)=>{
  if(IS_PROD) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN"); // el panel embebe /tv en un iframe del mismo origen
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  next();
});

/* HTML siempre revalidado: tras un deploy, ningún navegador se queda con un panel/landing viejo en caché
   (con ETag la revalidación devuelve 304 y apenas cuesta; fotos/JS/SVG siguen cacheándose normal) */
app.use((req, res, next)=>{
  if(/\.html$/.test(req.path) || ["/","/panel","/tv","/admin","/reset","/en","/en/"].includes(req.path)){
    res.set("Cache-Control", "no-cache");
  }
  next();
});

/* dominio canónico (SEO): www.flappit.com y el host de Railway redirigen 301 a flappit.com,
   para que Google no indexe contenido duplicado en varios hosts. Solo en producción. */
app.use((req, res, next)=>{
  const host = (req.headers.host || "").toLowerCase();
  if(IS_PROD && (host === "www.flappit.com" || host.endsWith(".up.railway.app"))){
    return res.redirect(301, "https://flappit.com" + req.originalUrl);
  }
  next();
});

/* ---- webhook de Stripe (ANTES del parser JSON: necesita el cuerpo en crudo
   para verificar la firma) ---- */
app.post("/api/stripe/webhook", express.raw({type:"application/json"}), (req,res)=>{
  const s = stripe();
  const wh = process.env.STRIPE_WEBHOOK_SECRET;
  if(!s || !wh) return res.status(503).json({error:"stripe-no-configurado"});
  let event;
  try{
    event = s.webhooks.constructEvent(req.body, req.headers["stripe-signature"], wh);
  }catch(err){
    return res.status(400).send("firma-invalida");
  }
  try{ handleStripeEvent(event); }
  catch(e){ console.error("stripe webhook:", e); }
  res.json({received:true});
});

function userForSub(o){
  const uid = o && o.metadata && o.metadata.user_id ? +o.metadata.user_id : null;
  if(uid) return db.prepare("SELECT * FROM users WHERE id=?").get(uid);
  if(o && o.customer) return db.prepare("SELECT * FROM users WHERE stripe_customer_id=?").get(o.customer);
  return null;
}
function planFromSub(sub){
  try{
    const pid = sub.items.data[0].price.id;
    if(pid===process.env.STRIPE_PRICE_UNO_M || pid===process.env.STRIPE_PRICE_UNO_Y) return "uno";
    if(pid===process.env.STRIPE_PRICE_TRES_M || pid===process.env.STRIPE_PRICE_TRES_Y) return "tres";
  }catch(e){}
  return null;
}
function handleStripeEvent(event){
  const o = event.data.object;
  switch(event.type){
    case "checkout.session.completed": {
      const uid = o.metadata && o.metadata.user_id ? +o.metadata.user_id
                : (o.client_reference_id ? +o.client_reference_id : null);
      if(uid){
        db.prepare("UPDATE users SET stripe_customer_id=?, stripe_sub_id=?, sub_status='active' WHERE id=?")
          .run(o.customer||null, o.subscription||null, uid);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const u = userForSub(o);
      if(u){
        db.prepare(`UPDATE users SET sub_status=?,
                    stripe_customer_id=COALESCE(stripe_customer_id,?),
                    stripe_sub_id=?, current_period_end=?, plan=COALESCE(?,plan) WHERE id=?`)
          .run(o.status, o.customer||null, o.id,
               (o.current_period_end||0)*1000, planFromSub(o), u.id);
      }
      break;
    }
    case "customer.subscription.deleted": {
      const u = userForSub(o);
      if(u) db.prepare("UPDATE users SET sub_status='canceled' WHERE id=?").run(u.id);
      break;
    }
    case "invoice.payment_failed": {
      const u = userForSub(o);
      if(u) db.prepare("UPDATE users SET sub_status='past_due' WHERE id=?").run(u.id);
      break;
    }
    case "invoice.paid": {
      const u = userForSub(o);
      if(u) db.prepare("UPDATE users SET sub_status='active' WHERE id=?").run(u.id);
      break;
    }
  }
}

app.use(express.json({limit:"12mb"})); // estados con fotos flapizadas y fotos a pantalla completa embebidas
app.use(express.static(path.join(__dirname, "web")));
app.use("/media", express.static(MEDIA_DIR, {maxAge:"7d", immutable:true})); // vídeos subidos
app.get("/tv", (req,res)=>res.sendFile(path.join(__dirname,"web","tv.html")));
app.get("/panel", (req,res)=>res.sendFile(path.join(__dirname,"web","panel.html")));
app.get("/admin", (req,res)=>res.sendFile(path.join(__dirname,"web","admin.html"))); // panel interno (protegido por API)
app.get("/reset", (req,res)=>res.sendFile(path.join(__dirname,"web","reset.html"))); // nueva contraseña (enlace del email)
app.get(["/en","/en/"], (req,res)=>res.sendFile(path.join(__dirname,"web","en","index.html"))); // landing en inglés (URL limpia)

/* ---- cuentas ---- */
app.post("/api/register", rateLimit("reg", 10, 60*60*1000), (req,res)=>{
  const {email, password, business, plan, bill} = req.body || {};
  if(!email || !password || password.length<8)
    return res.status(400).json({error:"datos-invalidos"});
  const salt = crypto.randomBytes(16).toString("hex");
  try{
    const r = db.prepare(`INSERT INTO users(email,pass,salt,business,plan,bill,trial_until,created)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(email.toLowerCase().trim(), hash(password,salt), salt,
           (business||"").slice(0,60), PLAN_LIMITS[plan]?plan:"tres",
           bill==="y"?"y":"m", now()+TRIAL_DAYS*86400000, now());
    setCookie(res, "sid", makeSession(r.lastInsertRowid), 60*60*24*30);
    res.json({ok:true});
  }catch(e){
    res.status(409).json({error:"email-existe"});
  }
});

app.post("/api/login", rateLimit("login", 20, 15*60*1000), (req,res)=>{
  const {email, password} = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE email=?").get((email||"").toLowerCase().trim());
  if(!u || !safeEqual(hash(password||"", u.salt), u.pass))
    return res.status(401).json({error:"credenciales"});
  setCookie(res, "sid", makeSession(u.id), 60*60*24*30);
  res.json({ok:true});
});

app.post("/api/logout", (req,res)=>{
  setCookie(res, "sid", "", 0);
  res.json({ok:true});
});

/* ---- recuperación de contraseña ----
   /api/forgot responde SIEMPRE ok si el email es válido (no revela si existe cuenta);
   el token viaja por email y en la BD solo se guarda su HMAC (un volcado de la BD
   no permite restablecer contraseñas ajenas). Caduca en 1 hora y es de un solo uso. */
const RESET_TTL = 60*60*1000;
app.post("/api/forgot", rateLimit("forgot", 5, 15*60*1000), (req,res)=>{
  const m = mailer();
  if(!m) return res.status(503).json({error:"email-no-configurado"});
  const email = ((req.body||{}).email || "").toLowerCase().trim();
  const lang = (req.body||{}).lang === "en" ? "en" : "es";
  if(!email || !email.includes("@")) return res.status(400).json({error:"datos-invalidos"});
  res.json({ok:true}); // respuesta inmediata: ni el timing delata si la cuenta existe
  const u = db.prepare("SELECT id,email FROM users WHERE email=?").get(email);
  if(!u) return;
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("DELETE FROM resets WHERE user_id=?").run(u.id); // un enlace vigente por usuario
  db.prepare("INSERT INTO resets(token_hash,user_id,expires) VALUES(?,?,?)")
    .run(hmac(token), u.id, now()+RESET_TTL);
  const base = process.env.BASE_URL || "https://flappit.com";
  const link = base+"/reset?token="+token+(lang==="en" ? "&lang=en" : "");
  const subject = lang==="en" ? "Reset your Flappit password"
                              : "Restablecer su contraseña de Flappit";
  const text = lang==="en"
    ? "Someone (hopefully you) asked to reset the password of this Flappit account.\n\n"
      +"Open this link to set a new password (valid for 1 hour):\n"+link+"\n\n"
      +"If you didn't request it, ignore this email; your password stays the same."
    : "Alguien (esperamos que usted) ha pedido restablecer la contraseña de esta cuenta de Flappit.\n\n"
      +"Abra este enlace para crear una contraseña nueva (caduca en 1 hora):\n"+link+"\n\n"
      +"Si no lo ha pedido usted, ignore este correo; su contraseña seguirá siendo la misma.";
  m.sendMail({
    from: process.env.MAIL_FROM || ('"Flappit" <'+process.env.SMTP_USER+'>'),
    to: u.email, subject, text
  }).catch(e=>console.error("email de reset:", e && (e.message||e)));
});

app.post("/api/reset", rateLimit("reset", 10, 15*60*1000), (req,res)=>{
  const {token, password} = req.body || {};
  if(!token || !password || password.length<8)
    return res.status(400).json({error:"datos-invalidos"});
  const r = db.prepare("SELECT * FROM resets WHERE token_hash=?").get(hmac(String(token)));
  if(!r || r.expires < now()) return res.status(400).json({error:"enlace-invalido"});
  const salt = crypto.randomBytes(16).toString("hex");
  db.prepare("UPDATE users SET pass=?, salt=? WHERE id=?").run(hash(password,salt), salt, r.user_id);
  db.prepare("DELETE FROM resets WHERE user_id=?").run(r.user_id);
  setCookie(res, "sid", makeSession(r.user_id), 60*60*24*30); // entra directamente al panel
  res.json({ok:true});
});

app.get("/api/me", auth, (req,res)=>{
  const u = req.user;
  res.json({
    email:u.email, business:u.business, plan:u.plan, bill:u.bill,
    sub_status:u.sub_status, trial_until:u.trial_until,
    screens_limit: PLAN_LIMITS[u.plan] || 1,
    entitled: entitled(u),
    has_customer: !!u.stripe_customer_id,
    current_period_end: u.current_period_end || null,
    billing_ready: !!process.env.STRIPE_SECRET_KEY,
    is_admin: !!u.is_admin
  });
});

/* ---- panel interno de administración (solo admin) ---- */
app.get("/api/admin/users", auth, requireAdmin, (req,res)=>{
  const rows = db.prepare(`
    SELECT u.id, u.email, u.business, u.plan, u.bill, u.sub_status, u.trial_until, u.created,
           u.current_period_end, u.stripe_customer_id,
           (SELECT COUNT(*) FROM screens s WHERE s.user_id=u.id) AS screens
    FROM users u ORDER BY u.created DESC`).all();
  const users = rows.map(r=>({
    id:r.id, email:r.email, business:r.business, plan:r.plan, bill:r.bill,
    sub_status:r.sub_status, trial_until:r.trial_until, created:r.created,
    current_period_end:r.current_period_end, screens:r.screens,
    screens_limit: PLAN_LIMITS[r.plan] || 1,
    has_customer: !!r.stripe_customer_id, entitled: entitled(r)
  }));
  const stats = db.prepare("SELECT key, n FROM stats").all();
  res.json({ users, now: now(), stats });
});

/* admin: genera una contraseña temporal para un usuario (se muestra UNA vez;
   pensado para hoteles que pierden el acceso y llaman/escriben) */
app.post("/api/admin/users/:id/reset-password", auth, requireAdmin, (req,res)=>{
  const u = db.prepare("SELECT id,email FROM users WHERE id=?").get(+req.params.id);
  if(!u) return res.status(404).json({error:"usuario-no-encontrado"});
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin 0/O/1/l/I
  let pw = "";
  for(let i=0;i<12;i++) pw += chars[crypto.randomInt(chars.length)];
  const salt = crypto.randomBytes(16).toString("hex");
  db.prepare("UPDATE users SET pass=?, salt=? WHERE id=?").run(hash(pw,salt), salt, u.id);
  db.prepare("DELETE FROM resets WHERE user_id=?").run(u.id); // invalida enlaces de email pendientes
  res.json({ok:true, email:u.email, password:pw});
});

/* admin: pantallas de cualquier cuenta, con desvinculación */
app.get("/api/admin/users/:id/screens", auth, requireAdmin, (req,res)=>{
  const rows = db.prepare("SELECT id,name,last_seen,created FROM screens WHERE user_id=? ORDER BY id")
    .all(+req.params.id);
  res.json(rows.map(r=>({...r, online: sockets.has(tokenOf(r.id)) })));
});

app.delete("/api/admin/screens/:id", auth, requireAdmin, (req,res)=>{
  const s = db.prepare("SELECT * FROM screens WHERE id=? AND user_id IS NOT NULL").get(+req.params.id);
  if(!s) return res.status(404).json({error:"pantalla-no-encontrada"});
  db.prepare("DELETE FROM screens WHERE id=?").run(s.id);
  wsSend(s.token, {type:"unpaired"}); // la TV borra su token y muestra código nuevo al instante
  res.json({ok:true});
});

/* ---- estadística mínima: cuántos vídeos genera la gente en la landing ---- */
db.exec("CREATE TABLE IF NOT EXISTS stats(key TEXT PRIMARY KEY, n INTEGER DEFAULT 0)");
app.post("/api/stat/video-dl", rateLimit("stat", 30, 60000), (req,res)=>{
  db.prepare("INSERT INTO stats(key,n) VALUES('video-dl',1) ON CONFLICT(key) DO UPDATE SET n=n+1").run();
  res.json({ok:true});
});

/* ---- pantallas ---- */
app.post("/api/screen/hello", (req,res)=>{
  const {token} = req.body || {};
  if(token){
    const s = db.prepare("SELECT * FROM screens WHERE token=?").get(token);
    if(s){
      db.prepare("UPDATE screens SET last_seen=? WHERE id=?").run(now(), s.id);
      return res.json({token:s.token, code:s.code, paired:!!s.user_id,
                       state: s.state ? JSON.parse(s.state) : null});
    }
  }
  const t = crypto.randomUUID();
  let code = pairCode();
  while(db.prepare("SELECT 1 FROM screens WHERE code=? AND user_id IS NULL").get(code))
    code = pairCode();
  db.prepare("INSERT INTO screens(token,code,last_seen,created) VALUES(?,?,?,?)")
    .run(t, code, now(), now());
  res.json({token:t, code, paired:false, state:null});
});

app.post("/api/pair", rateLimit("pair", 15, 15*60*1000), auth, requirePaid, (req,res)=>{
  const {code, name} = req.body || {};
  const s = db.prepare("SELECT * FROM screens WHERE code=? AND user_id IS NULL")
    .get((code||"").toUpperCase().trim());
  if(!s) return res.status(404).json({error:"codigo-no-encontrado"});
  const count = db.prepare("SELECT COUNT(*) n FROM screens WHERE user_id=?").get(req.user.id).n;
  const limit = PLAN_LIMITS[req.user.plan] || 1;
  if(count>=limit) return res.status(403).json({error:"limite-plan", limit});
  db.prepare("UPDATE screens SET user_id=?, name=?, code=NULL WHERE id=?")
    .run(req.user.id, (name||"Pantalla "+(count+1)).slice(0,40), s.id);
  wsSend(s.token, {type:"paired"});
  res.json({ok:true, id:s.id, name:name||("Pantalla "+(count+1))});
});

app.get("/api/screens", auth, (req,res)=>{
  const rows = db.prepare("SELECT id,name,last_seen FROM screens WHERE user_id=? ORDER BY id")
    .all(req.user.id);
  res.json(rows.map(r=>({...r, online: sockets.has(tokenOf(r.id)) })));
});

function tokenOf(screenId){
  const r = db.prepare("SELECT token FROM screens WHERE id=?").get(screenId);
  return r ? r.token : null;
}
function ownScreen(req, res){
  const s = db.prepare("SELECT * FROM screens WHERE id=? AND user_id=?")
    .get(+req.params.id, req.user.id);
  if(!s){ res.status(404).json({error:"pantalla-no-encontrada"}); return null; }
  return s;
}

app.put("/api/screens/:id", auth, (req,res)=>{
  const s = ownScreen(req,res); if(!s) return;
  db.prepare("UPDATE screens SET name=? WHERE id=?")
    .run((req.body.name||"Pantalla").slice(0,40), s.id);
  res.json({ok:true});
});

app.delete("/api/screens/:id", auth, (req,res)=>{
  const s = ownScreen(req,res); if(!s) return;
  db.prepare("DELETE FROM screens WHERE id=?").run(s.id);
  wsSend(s.token, {type:"unpaired"});
  res.json({ok:true});
});

app.get("/api/screens/:id/state", auth, (req,res)=>{
  const s = ownScreen(req,res); if(!s) return;
  res.json({state: s.state ? JSON.parse(s.state) : null});
});

app.put("/api/screens/:id/state", auth, requirePaid, (req,res)=>{
  const s = ownScreen(req,res); if(!s) return;
  const state = req.body.state;
  if(!state || typeof state!=="object")
    return res.status(400).json({error:"estado-invalido"});
  db.prepare("UPDATE screens SET state=? WHERE id=?").run(JSON.stringify(state), s.id);
  wsSend(s.token, {type:"state", state});
  res.json({ok:true});
});

/* ---- subida de media (vídeo; también acepta imágenes grandes) ----
   Recibe el fichero en crudo (body binario) y lo vuelca a disco en streaming,
   sin cargarlo entero en memoria. Devuelve la URL pública en /media. */
app.post("/api/media", auth, requirePaid, (req,res)=>{
  const ct = (req.headers["content-type"]||"").toLowerCase();
  const fn = (()=>{ try{ return decodeURIComponent(req.headers["x-filename"]||""); }catch(e){ return ""; } })();
  let ext = (fn.split(".").pop()||"").toLowerCase();
  if(!MEDIA_EXT.includes(ext)){
    ext = ct.includes("webm") ? "webm"
        : ct.includes("quicktime") ? "mov"
        : ct.startsWith("video/") ? "mp4"
        : ct.includes("png") ? "png"
        : ct.includes("gif") ? "gif"
        : ct.includes("webp") ? "webp"
        : ct.startsWith("image/") ? "jpg"
        : "";
  }
  if(!MEDIA_EXT.includes(ext)) return res.status(415).json({error:"tipo-no-soportado"});
  const fname = crypto.randomUUID()+"."+ext;
  const dest = path.join(MEDIA_DIR, fname);
  const out = fs.createWriteStream(dest);
  let size = 0, aborted = false;
  const abort = (code, err)=>{
    if(aborted) return; aborted = true;
    try{ out.destroy(); }catch(e){}
    try{ req.destroy(); }catch(e){}
    fs.unlink(dest, ()=>{});
    if(!res.headersSent) res.status(code).json({error:err});
  };
  req.on("data", c=>{ size += c.length; if(size > MEDIA_MAX) abort(413, "demasiado-grande"); });
  req.on("error", ()=> abort(400, "subida-interrumpida"));
  out.on("error", ()=> abort(500, "guardado"));
  out.on("finish", ()=>{ if(!aborted && !res.headersSent) res.json({src:"/media/"+fname, size}); });
  req.pipe(out);
});

/* ---- stripe: alta de suscripción (checkout) ---- */
app.get("/api/subscribe", auth, async (req,res)=>{
  const s = stripe();
  if(!s) return res.json({url:null, note:"stripe-no-configurado"});
  /* el usuario elige plan y periodicidad en el selector del panel; se persiste su elección */
  const plan = (req.query.plan==="uno" || req.query.plan==="tres") ? req.query.plan : req.user.plan;
  const bill = (req.query.bill==="m" || req.query.bill==="y") ? req.query.bill : req.user.bill;
  if(plan!==req.user.plan || bill!==req.user.bill){
    db.prepare("UPDATE users SET plan=?, bill=? WHERE id=?").run(plan, bill, req.user.id);
  }
  const price = bill==="y"
    ? (plan==="uno" ? process.env.STRIPE_PRICE_UNO_Y : process.env.STRIPE_PRICE_TRES_Y)
    : (plan==="uno" ? process.env.STRIPE_PRICE_UNO_M : process.env.STRIPE_PRICE_TRES_M);
  if(!price) return res.json({url:null, note:"precio-no-configurado"});
  const base = process.env.BASE_URL || ("http://localhost:"+PORT);
  try{
    const session = await s.checkout.sessions.create({
      mode:"subscription",
      line_items:[{price, quantity:1}],
      // reutiliza el cliente de Stripe si ya existe (para que el portal funcione)
      ...(req.user.stripe_customer_id
          ? {customer:req.user.stripe_customer_id}
          : {customer_email:req.user.email}),
      client_reference_id:String(req.user.id),
      success_url:base+"/panel?sub=ok",
      cancel_url:base+"/panel?sub=cancel",
      metadata:{user_id:String(req.user.id)},
      subscription_data:{metadata:{user_id:String(req.user.id)}} // el user_id viaja en los eventos de la suscripción
    });
    res.json({url:session.url});
  }catch(e){
    res.status(500).json({error:"stripe", detail:String(e.message||e)});
  }
});

/* ---- stripe: portal del cliente (cambiar plan, tarjeta, cancelar) ---- */
app.get("/api/portal", auth, async (req,res)=>{
  const s = stripe();
  if(!s) return res.json({url:null, note:"stripe-no-configurado"});
  if(!req.user.stripe_customer_id) return res.status(400).json({error:"sin-cliente"});
  const base = process.env.BASE_URL || ("http://localhost:"+PORT);
  try{
    const session = await s.billingPortal.sessions.create({
      customer:req.user.stripe_customer_id,
      return_url:base+"/panel"
    });
    res.json({url:session.url});
  }catch(e){
    res.status(500).json({error:"stripe", detail:String(e.message||e)});
  }
});

/* ---------- manejo de errores (evita que una excepción tumbe el proceso único) ---------- */
// middleware de error de Express: SIEMPRE el último app.use, captura errores de rutas síncronas
app.use((err, req, res, next)=>{
  if(err && err.type==="entity.parse.failed") // JSON malformado del cliente
    return res.status(400).json({error:"json-invalido"});
  if(err && err.type==="entity.too.large")
    return res.status(413).json({error:"demasiado-grande"});
  console.error("Error en ruta", req.method, req.url, "-", err && (err.stack||err));
  if(res.headersSent) return next(err);
  res.status(500).json({error:"interno"});
});
// red de seguridad global: registra y sigue en pie (Railway solo reinicia si el proceso muere)
process.on("uncaughtException", (err)=>{
  console.error("uncaughtException:", err && (err.stack||err));
});
process.on("unhandledRejection", (err)=>{
  console.error("unhandledRejection:", err && (err.stack||err));
});

/* ---------- websocket de pantallas ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({server, path:"/ws"});
const sockets = new Map(); // token -> ws

function wsSend(token, msg){
  const ws = sockets.get(token);
  if(ws && ws.readyState===1){
    try{ ws.send(JSON.stringify(msg)); }catch(e){}
  }
}

wss.on("connection", (ws, req)=>{
  const url = new URL(req.url, "http://x");
  const token = url.searchParams.get("token");
  const s = token && db.prepare("SELECT * FROM screens WHERE token=?").get(token);
  if(!s){ ws.close(); return; }
  sockets.set(token, ws);
  db.prepare("UPDATE screens SET last_seen=? WHERE id=?").run(now(), s.id);
  if(s.user_id && s.state){
    try{ ws.send(JSON.stringify({type:"state", state:JSON.parse(s.state)})); }catch(e){}
  }
  ws.on("close", ()=>{ if(sockets.get(token)===ws) sockets.delete(token); });
  ws.on("message", ()=>{ db.prepare("UPDATE screens SET last_seen=? WHERE id=?").run(now(), s.id); });
});

setInterval(()=>{ // latido para mantener conexiones vivas tras proxies
  wss.clients.forEach(ws=>{ try{ ws.ping(); }catch(e){} });
}, 30000);

server.listen(PORT, ()=>{
  console.log("FLAPS backend escuchando en http://localhost:"+PORT);
  console.log("  Panel de control: /panel   Pantalla TV: /tv");
});

/* Apagado limpio. Al redesplegar, Railway envía SIGTERM para parar la versión anterior.
   Si no lo gestionamos, Node termina "por señal" y Railway lo marca como crash (falso
   positivo: los emails "Deploy Crashed"). Cerramos ordenadamente y salimos con código 0. */
let shuttingDown = false;
function shutdown(sig){
  if(shuttingDown) return; shuttingDown = true;
  console.log("Apagado limpio ("+sig+")…");
  try{ wss.clients.forEach(ws=>{ try{ ws.close(); }catch(e){} }); }catch(e){}
  try{ wss.close(); }catch(e){}
  try{ server.close(()=>{ try{ db.close(); }catch(e){} process.exit(0); }); }catch(e){ process.exit(0); }
  setTimeout(()=>{ try{ db.close(); }catch(e){} process.exit(0); }, 4000).unref(); // red de seguridad
}
process.on("SIGTERM", ()=>shutdown("SIGTERM"));
process.on("SIGINT",  ()=>shutdown("SIGINT"));
