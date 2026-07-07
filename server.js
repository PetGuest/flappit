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
const SECRET = process.env.SESSION_SECRET || "cambia-esto-en-produccion";
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
  if(hmac(body)!==parts[2]) return null;
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
    `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
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

/* ---------- app ---------- */
const app = express();

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
app.get(["/en","/en/"], (req,res)=>res.sendFile(path.join(__dirname,"web","en","index.html"))); // landing en inglés (URL limpia)

/* ---- cuentas ---- */
app.post("/api/register", (req,res)=>{
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

app.post("/api/login", (req,res)=>{
  const {email, password} = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE email=?").get((email||"").toLowerCase().trim());
  if(!u || hash(password||"", u.salt)!==u.pass)
    return res.status(401).json({error:"credenciales"});
  setCookie(res, "sid", makeSession(u.id), 60*60*24*30);
  res.json({ok:true});
});

app.post("/api/logout", (req,res)=>{
  setCookie(res, "sid", "", 0);
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
  res.json({ users, now: now() });
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

app.post("/api/pair", auth, requirePaid, (req,res)=>{
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
  const price = req.user.bill==="y"
    ? (req.user.plan==="uno" ? process.env.STRIPE_PRICE_UNO_Y : process.env.STRIPE_PRICE_TRES_Y)
    : (req.user.plan==="uno" ? process.env.STRIPE_PRICE_UNO_M : process.env.STRIPE_PRICE_TRES_M);
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
