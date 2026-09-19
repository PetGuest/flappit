/* Flappit — generador público de vídeos split-flap 9:16 (Stories / TikTok / Reels).
   Extraído de panel.html (makeShareVideo): canvas 1080×1920 + captureStream + MediaRecorder,
   coreografía "misterio" y sonido clac-clac (variante C). Todo en el navegador; coste servidor 0.
   Uso: FlapVideo.render({lines:[...], textColor, flapColor, onProgress}) → Promise<{blob, file, url}>
        FlapVideo.preview(canvas, {lines, textColor, flapColor}) → dibuja el mensaje final (estático) */
(function(){
  const CHARSET = " ABCDEFGHIJKLMNOPQRSTUVWXYZÑ0123456789.,!?¡¿:'+-&@#€%";
  const LEN = CHARSET.length;
  const CELL_AR = 0.70;
  const REDES_SAFE_TOP = 0.13, REDES_SAFE_BOT = 0.16;
  const COLS = 13, FLIP_ANIM = 70;

  function normalize(s){
    return String(s||"").toUpperCase()
      .replace(/\u00d1/g,"\u0001")
      .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
      .replace(/\u0001/g,"\u00d1")
      .replace(/[^\x20-\x7EÑ¡¿€]/g," ");
  }
  function shade(hex, f){
    const n = parseInt(hex.slice(1),16);
    const r=Math.min(255,Math.round(((n>>16)&255)*f)),
          g=Math.min(255,Math.round(((n>>8)&255)*f)),
          b=Math.min(255,Math.round((n&255)*f));
    return `rgb(${r},${g},${b})`;
  }
  function lineStart(text, align, cols){
    const L = text.length;
    if(align==="left") return 0;
    if(align==="right") return Math.max(0, cols-L);
    return Math.max(0, Math.floor((cols-L)/2));
  }
  function redesGeom(W, H, cols, rows){
    const pad = Math.max(5, Math.round(Math.min(W, H)*0.022));
    const safeTop = H*REDES_SAFE_TOP;
    const safeH = H*(1 - REDES_SAFE_TOP - REDES_SAFE_BOT);
    const availW = W - 2*pad, availH = safeH - 2*pad;
    let cellW = availW/cols, cellH = availH/rows;
    if(cellW/cellH > CELL_AR) cellW = cellH*CELL_AR;
    else cellH = cellW/CELL_AR;
    /* solo filas ENTERAS: el panel completo (N filas) se centra en el fotograma y el mensaje cae en la
       fila más cercana a su sitio ideal; así nunca hay casillas cortadas arriba ni abajo */
    let N = Math.max(rows, Math.floor((H - 2*pad)/cellH));
    /* si el resto vertical permite casi otra fila, se encoge la casilla lo justo para que quepa una más
       y el panel llene la altura entera (queda algo más de margen a los lados, que no se nota) */
    if((H - 2*pad) - N*cellH > cellH*0.35){ N += 1; cellH = (H - 2*pad)/N; cellW = cellH*CELL_AR; }
    const top0 = (H - N*cellH)/2;
    const ideal = safeTop + (safeH - rows*cellH)/2;
    const nTop = Math.min(N - rows, Math.max(0, Math.round((ideal - top0)/cellH)));
    const editTop = top0 + nTop*cellH;
    const nBot = N - nTop - rows;
    return {pad, cellW, cellH, editTop, nTop, nBot,
            top0, safeTop, safeBotY: H*(1 - REDES_SAFE_BOT)};
  }

  /* ---- sonido clac-clac ---- */
  let audioCtx=null, master=null, noise=null;
  function ensureAudio(){
    if(audioCtx){ audioCtx.resume(); return; }
    audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    master = audioCtx.createGain(); master.gain.value=0.8;
    master.connect(audioCtx.destination);
    noise = makeNoise(audioCtx);
  }
  function makeNoise(ac){
    const len=Math.floor(ac.sampleRate*0.025);
    const nz=ac.createBuffer(1,len,ac.sampleRate);
    const d=nz.getChannelData(0);
    for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/len,2.5);
    return nz;
  }
  /* un clac (doble golpe) en el instante absoluto t0 del contexto ac (tiempo real u offline) */
  function clackAt(ac, mst, nz, t0, g){
    const hit = (tt, gg)=>{
      const n1=ac.createBufferSource(); n1.buffer=nz;
      n1.playbackRate.value=1.9+Math.random()*0.5;
      const hp=ac.createBiquadFilter(); hp.type="highpass"; hp.frequency.value=2800; hp.Q.value=0.7;
      const g1=ac.createGain(); g1.gain.setValueAtTime(gg, tt); g1.gain.exponentialRampToValueAtTime(0.0001, tt+0.012);
      n1.connect(hp).connect(g1).connect(mst); n1.start(tt);
      const n2=ac.createBufferSource(); n2.buffer=nz; n2.playbackRate.value=2.1;
      const bp=ac.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=5800+Math.random()*1600; bp.Q.value=1.4;
      const g2=ac.createGain(); g2.gain.setValueAtTime(gg*0.7, tt); g2.gain.exponentialRampToValueAtTime(0.0001, tt+0.010);
      n2.connect(bp).connect(g2).connect(mst); n2.start(tt);
    };
    hit(t0, g*1.05);
    hit(t0 + 0.016 + Math.random()*0.006, g*0.65);
  }

  /* ---- casilla split-flap en canvas ---- */
  function drawCell(ctx,x,y,w,h,prevC,curC,p,flap,txt){
    const gap=w*0.045;
    const fx=x+gap, fy=y+gap, fw=w-2*gap, fh=h-2*gap;
    const half=fh/2, rad=Math.max(2,w*0.08), cx=x+w/2;
    const font=`500 ${fh*0.80}px 'Roboto Condensed','Helvetica Neue',Arial,sans-serif`;
    function halfPath(top){
      ctx.beginPath();
      if(top){
        ctx.moveTo(fx,fy+half); ctx.lineTo(fx,fy+rad);
        ctx.arcTo(fx,fy,fx+rad,fy,rad); ctx.lineTo(fx+fw-rad,fy);
        ctx.arcTo(fx+fw,fy,fx+fw,fy+rad,rad); ctx.lineTo(fx+fw,fy+half);
      }else{
        ctx.moveTo(fx+fw,fy+half+1); ctx.lineTo(fx+fw,fy+fh-rad);
        ctx.arcTo(fx+fw,fy+fh,fx+fw-rad,fy+fh,rad); ctx.lineTo(fx+rad,fy+fh);
        ctx.arcTo(fx,fy+fh,fx,fy+fh-rad,rad); ctx.lineTo(fx,fy+half+1);
      }
      ctx.closePath();
    }
    function drawHalf(top,ch,dim){
      halfPath(top);
      ctx.fillStyle = shade(flap, (top ? 1.05 : 1.2) * dim);
      ctx.fill();
      ctx.save(); ctx.clip();
      ctx.fillStyle=txt; ctx.font=font; ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.save(); ctx.translate(cx, fy+half+fh*0.09); ctx.scale(0.62, 1.04); ctx.fillText(ch, 0, 0); ctx.restore();
      if(top){
        const sh=ctx.createLinearGradient(0,fy,0,fy+half);
        sh.addColorStop(0,"rgba(0,0,0,0.62)"); sh.addColorStop(0.55,"rgba(0,0,0,0.29)"); sh.addColorStop(1,"rgba(0,0,0,0.09)");
        ctx.fillStyle=sh; ctx.fillRect(fx,fy,fw,half);
      }
      ctx.restore();
      if(top){ halfPath(true); ctx.lineWidth = Math.max(0.5, w*0.009);
        ctx.strokeStyle = "rgba(255,255,255,0.17)";
        ctx.stroke();
      } else { halfPath(false); ctx.lineWidth = Math.max(0.5, w*0.009); ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.stroke(); }
    }
    if(p>=1){ drawHalf(true,curC,1); drawHalf(false,curC,1); }
    else{
      drawHalf(true,curC,1); drawHalf(false,prevC,1);
      const ang = p<0.5 ? (1-2*p) : (2*p-1);
      const shH = half*(1-ang)*0.95;
      if(shH>0.5){
        ctx.save(); halfPath(false); ctx.clip();
        const sg = ctx.createLinearGradient(0, fy+half, 0, fy+half+shH);
        sg.addColorStop(0, "rgba(0,0,0,"+(0.55*(1-ang)).toFixed(3)+")"); sg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = sg; ctx.fillRect(fx, fy+half, fw, shH); ctx.restore();
      }
      ctx.save(); ctx.translate(cx,fy+half);
      const syF = Math.max(0.03, ang);
      ctx.scale(1 + (1-syF)*0.08, syF);
      ctx.translate(-cx,-(fy+half));
      if(p<0.5){ drawHalf(true,prevC,1-p*0.6); }
      else{
        const glint = (p>0.55 && p<0.82) ? 0.55*Math.sin((p-0.55)/0.27*Math.PI) : 0;
        drawHalf(false,curC,0.5+(p-0.5)*0.95 + glint);
      }
      ctx.restore();
      const edgeY = p<0.5 ? fy+half - half*syF : fy+half + half*syF;
      ctx.fillStyle = "rgba(255,255,255,"+(0.40*(1-ang)).toFixed(3)+")";
      ctx.fillRect(fx+fw*0.04, edgeY-Math.max(1,h*0.005), fw*0.92, Math.max(1.5, h*0.012));
    }
    ctx.fillStyle="rgba(0,0,0,0.85)"; ctx.fillRect(fx,fy+half-Math.max(0.5,h*0.004),fw,Math.max(1,h*0.008));
    const pw=Math.max(3,w*0.018), ph=Math.max(12,h*0.12);   // mínimo visible en 720p: si no, la compresión del vídeo se los come
    for(const px of [fx-pw*0.25, fx+fw-pw*0.75]){   // pegados al canto, sin invadir el hueco: los de dos casillas vecinas no se juntan
      const mg = ctx.createLinearGradient(0,fy+half-ph/2,0,fy+half+ph/2);
      mg.addColorStop(0,"#464648"); mg.addColorStop(0.28,"#545456"); mg.addColorStop(0.55,"#38383b"); mg.addColorStop(1,"#1b1b1e");
      ctx.fillStyle=mg; ctx.beginPath();
      if(ctx.roundRect) ctx.roundRect(px,fy+half-ph/2,pw,ph,pw*0.45); else ctx.rect(px,fy+half-ph/2,pw,ph);
      ctx.fill();
      ctx.fillStyle="rgba(255,255,255,0.09)"; ctx.fillRect(px+pw*0.25,fy+half-ph/2+ph*0.15,pw*0.5,Math.max(1,ph*0.12));
    }
  }

  function canRecord(){ return !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream); }
  function pickMime(){
    const c = ["video/mp4;codecs=avc1","video/mp4","video/webm;codecs=vp9","video/webm"];
    for(const m of c){ try{ if(MediaRecorder.isTypeSupported(m)) return m; }catch(e){} }
    return "";
  }

  /* objetivos (índice CHARSET por casilla) para un mensaje de N líneas */
  function buildTargets(lines, cols, rows, g){
    const total = g.nTop + rows + g.nBot;
    const targets = new Array(total*cols).fill(0);
    for(let j=0;j<rows;j++){
      const text = normalize(lines[j]||"").slice(0,cols).replace(/\s+$/,"").replace(/^\s+/,"");
      const st = lineStart(text, "center", cols);
      for(let c2=0;c2<text.length;c2++){
        const k = CHARSET.indexOf(text[c2]);
        if(k>0) targets[(g.nTop+j)*cols+st+c2] = k;
      }
    }
    return targets;
  }
  function cleanLines(lines){
    const out = (lines||[]).map(l=>normalize(l).slice(0,COLS).trim());
    while(out.length && !out[out.length-1]) out.pop();
    while(out.length && !out[0]) out.shift();
    return out.length ? out : [""];
  }

  function drawStatic(ctx, W, H, lines, textColor, flapColor, mark){
    const rows = Math.max(3, lines.length);
    const g = redesGeom(W, H, COLS, rows);
    const targets = buildTargets(lines, COLS, rows, g);
    const innerW = COLS*g.cellW, offX=(W-innerW)/2;
    ctx.fillStyle="#000"; ctx.fillRect(0,0,W,H);
    for(let i=0;i<targets.length;i++){
      const r=Math.floor(i/COLS), c2=i%COLS;
      drawCell(ctx, offX + c2*g.cellW, g.top0 + r*g.cellH, g.cellW, g.cellH, CHARSET[targets[i]], CHARSET[targets[i]], 1, flapColor, textColor);
    }
    if(mark){
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = `500 ${H*0.0158}px 'Helvetica Neue',Arial,sans-serif`;
      ctx.textAlign="center"; ctx.textBaseline="bottom";
      ctx.fillText("FLAPPIT.COM", W/2, g.safeBotY - H*0.006);
    }
  }

  function preview(canvas, opts){
    const lines = cleanLines(opts.lines);
    const W = canvas.width, H = canvas.height;
    drawStatic(canvas.getContext("2d"), W, H, lines, opts.textColor||"#ffffff", opts.flapColor||"#19191B", true);
  }

  function plan(opts){
    const lines = cleanLines(opts.lines);
    const textColor = opts.textColor||"#ffffff", flapColor = opts.flapColor||"#19191B";
    const LOW = opts.lowPower != null ? opts.lowPower : (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.hardwareConcurrency||8) <= 4);
    const W = LOW ? 720 : 1080, H = LOW ? 1280 : 1920;   // 720×1280 en móvil: mismo 9:16, TikTok lo reescala; evita frames perdidos
    const cv = document.createElement("canvas"); cv.width=W; cv.height=H;
    const ctx = cv.getContext("2d");
    const rows = Math.max(3, lines.length), cols = COLS;
    const g = redesGeom(W, H, cols, rows);
    const targets = buildTargets(lines, cols, rows, g);
    const DUR = Math.min(60, Math.max(10, Number(opts.duration)||15));   // duración total del vídeo en segundos
    let HOLD = 5000;                                                     // mensaje resuelto y quieto: exactamente los 5 últimos segundos
    const LEAD_CUT = 2000, BASE_NOMINAL = 80;
    const T = Math.round(DUR*1000 - 400 - HOLD) + LEAD_CUT;              // tambor: el resto (400 ms de arranque en blanco)
    /* Arranque en crescendo: el panel empieza VACÍO y las casillas van entrando en giro poco a poco
       (delay repartido en el primer 35 % del tambor, cada vez más densas), solo ~45 % de las casillas
       vacías participan, se van asentando entre el 45 % y el 85 %, y las letras del mensaje se desvelan
       al final. Así el panel nunca está "lleno" de golpe y recuerda más a uno real. */
    const S = T - LEAD_CUT;                                   // duración visible del tambor
    const letters = [];
    const cells = targets.map(tg=>{
      const d = tg===0 ? LEN : tg;
      const cell = {from:0, tg, d, steps:d, base:60, delay:0, slowN:0, F:0, skip:false};
      if(tg>0){ letters.push(cell); cell.delay = S*0.30*Math.pow(Math.random(), 0.7); }
      else if(Math.random() < 0.45){ cell.delay = S*0.35*Math.pow(Math.random(), 0.6); }
      else { cell.skip = true; cell.steps = 0; }
      return cell;
    });
    for(let i=letters.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [letters[i],letters[j]]=[letters[j],letters[i]]; }
    const nFin = Math.min(8, Math.max(3, Math.round(letters.length*0.3)));
    letters.forEach((cell,i)=>{
      if(i >= letters.length - nFin){
        const k2 = i - (letters.length - nFin);
        cell.F = T*(0.78 + 0.15*(k2+1)/nFin); cell.slowN = 4 + Math.floor(Math.random()*4);
      } else { cell.F = T*(0.55 + 0.23*(i/Math.max(1, letters.length - nFin))); }
    });
    cells.forEach(cell=>{
      if(cell.skip) return;
      if(cell.tg===0){ cell.F = S*(0.45 + Math.random()*0.40) + LEAD_CUT; }
      cell.F = Math.max(1400, cell.F - LEAD_CUT);
      const Tc = Math.max(1200, cell.F - cell.delay);
      const slowExtra = 0.3*cell.slowN*(cell.slowN+1);
      let k = Math.max(0, Math.round((Tc/BASE_NOMINAL - cell.d - slowExtra)/LEN));
      cell.steps = cell.d + k*LEN;
      cell.base = Tc/(cell.steps + slowExtra);
      if(cell.base<50 && cell.steps>cell.d){ cell.steps -= LEN; cell.base = Tc/(cell.steps + slowExtra); }
      cell.base = Math.min(150, Math.max(45, cell.base));
      cell.slowN = Math.min(cell.slowN, Math.max(0, cell.steps-1));
    });
    function stepTime(cell,n){
      const n0 = cell.steps - cell.slowN;
      if(n<=n0) return n*cell.base;
      const k2 = n - n0;
      return n0*cell.base + cell.base*(k2 + 0.3*k2*(k2+1));
    }
    function stepAt(cell,e2){
      const n0 = cell.steps - cell.slowN;
      if(e2<=n0*cell.base) return Math.min(n0, Math.floor(e2/cell.base));
      let n = n0;
      while(n<cell.steps && stepTime(cell,n+1)<=e2) n++;
      return n;
    }
    const innerW = cols*g.cellW, offX = (W-innerW)/2;
    /* fin de la coreografía principal y guiños durante la espera final: 1 o 2 casillas vacías FUERA de las
       filas del mensaje giran 2-3 letras y VUELVEN a quedar en negro (con su clac). Vida sin estorbar la lectura. */
    const IDLE_STEP = 95;
    let finishT = 0;
    cells.forEach(c=>{ finishT = Math.max(finishT, c.delay + stepTime(c, c.steps) + FLIP_ANIM); });
    /* la última letra debe pararse justo en DUR-5 s: se reescala el tempo de todas las casillas (±10 %) */
    { const target = DUR*1000 - 400 - HOLD; const f = target/finishT;
      cells.forEach(c=>{ c.base *= f; c.delay *= f; }); finishT = target; }
    /* CTA opcional (vídeos de la cuenta): una línea corta que aparece 2 filas por debajo del mensaje al
       empezar la espera final, letra a letra de izquierda a derecha, en color apagado. p. ej. "CREA EL TUYO" */
    const ctaText = opts.cta ? normalize(opts.cta).slice(0, cols).trim() : "";
    const ctaColor = opts.ctaColor || "#8f8f96";
    const ctaCells = new Set();
    if(ctaText){
      const totalRows = g.nTop + rows + g.nBot;
      const r = Math.min(totalRows-1, g.nTop + rows + 2);
      const st = lineStart(ctaText, "center", cols);
      for(let i=0;i<ctaText.length;i++){
        const ch = ctaText[i]; if(ch===" ") continue;
        const cell = cells[r*cols + st + i]; if(!cell || cell.tg!==0) continue;
        cell.cta = {t0: finishT + 900 + i*70, k: 3 + Math.floor(Math.random()*2), base: 1 + Math.floor(Math.random()*(LEN-1)), target: CHARSET.indexOf(ch)};
        ctaCells.add(cell);
      }
    }
    const idleCells = cells.map((c,i)=>({c,i})).filter(o=>o.c.tg===0 && !ctaCells.has(o.c) && (Math.floor(o.i/cols) < g.nTop || Math.floor(o.i/cols) >= g.nTop+rows));
    const idleEvents = [];
    { const nEv = 1 + Math.floor(Math.random()*2);                       // 1 o 2 guiños por vídeo
      const span = HOLD - 1800, used = [];
      for(let i=0;i<nEv && idleCells.length;i++){
        let o; do{ o = idleCells[Math.floor(Math.random()*idleCells.length)]; }while(used.includes(o) && used.length<idleCells.length);
        used.push(o);
        const k = 2 + Math.floor(Math.random()*2);                      // 2-3 letras y vuelta al negro (k+1 giros)
        const tt = finishT + 700 + (span/nEv)*i + Math.random()*Math.max(200, span/nEv - 900);
        const base = 1 + Math.floor(Math.random()*(LEN-1));
        o.c.idle = {t0: tt, k, base};
        idleEvents.push({t0: tt, k: k+1});
      }
    }
    function ctaState(cell, e){   // letra del CTA: blanco → k letras al azar → letra final (se queda)
      const ev = cell.cta;
      if(!ev || e < ev.t0) return null;
      const n = Math.min(ev.k+1, Math.floor((e - ev.t0)/IDLE_STEP) + 1);
      const at = i2 => i2<=0 ? 0 : (i2>ev.k ? ev.target : (ev.base + i2 - 1) % LEN);
      const p = Math.min(1, ((e - ev.t0) - (n-1)*IDLE_STEP)/FLIP_ANIM);
      return {prev: at(n-1), cur: at(n), p};
    }
    function idleState(cell, e){   // qué muestra una casilla en guiño: {prev, cur, p} o null si no está en guiño
      const ev = cell.idle;
      if(!ev || e < ev.t0) return null;
      const n = Math.min(ev.k+1, Math.floor((e - ev.t0)/IDLE_STEP) + 1);   // giro n: 1..k letras, k+1 = vuelta a negro
      const at = i2 => i2<=0 ? 0 : (i2>ev.k ? 0 : (ev.base + i2 - 1) % LEN);
      const p = Math.min(1, ((e - ev.t0) - (n-1)*IDLE_STEP)/FLIP_ANIM);
      return {prev: at(n-1), cur: at(n), p: (n>ev.k && p>=1) ? 1 : p};
    }
    function drawFrame(e){
      ctx.fillStyle="#000"; ctx.fillRect(0,0,W,H);
      const refl = ctx.createLinearGradient(0,0,0,H);
      refl.addColorStop(0,"rgba(255,255,255,0.03)"); refl.addColorStop(0.12,"rgba(255,255,255,0.008)");
      refl.addColorStop(0.6,"rgba(255,255,255,0)"); refl.addColorStop(1,"rgba(0,0,0,0.28)");
      ctx.fillStyle=refl; ctx.fillRect(0,0,W,H);
      let sum=0, active=false;
      for(let i=0;i<cells.length;i++){
        const cell=cells[i];
        const r=Math.floor(i/cols), c2=i%cols;
        const ec = e - cell.delay;
        let step, p;
        if(cell.skip){ step=0; p=1; }
        else if(ec<=0){ step=0; p=1; active=true; }
        else{
          step = Math.min(cell.steps, stepAt(cell, ec));
          p = Math.min(1,(ec-stepTime(cell,step))/FLIP_ANIM);
          if(step<cell.steps || ec < stepTime(cell,cell.steps) + FLIP_ANIM) active=true;
        }
        sum += step;
        let pp = step>=cell.steps?1:p;
        let curc=(cell.from+step)%LEN;
        let prev= step===0?cell.from:(curc-1+LEN)%LEN;
        let col = textColor;
        if(cell.idle && step>=cell.steps){ const st = idleState(cell, e); if(st){ prev=st.prev; curc=st.cur; pp=st.p; } }
        if(cell.cta && step>=cell.steps){ const st = ctaState(cell, e); if(st){ prev=st.prev; curc=st.cur; pp=st.p; col = ctaColor; } }
        drawCell(ctx, offX + c2*g.cellW, g.top0 + r*g.cellH, g.cellW, g.cellH,
          CHARSET[prev], CHARSET[curc], pp, flapColor, col);
      }
      { const m2=Math.max(4,g.cellW*0.30), rr=Math.max(8,g.cellW*0.5);
        ctx.beginPath();
        if(ctx.roundRect) ctx.roundRect(offX-m2, g.editTop-m2, innerW+2*m2, rows*g.cellH+2*m2, rr);
        else ctx.rect(offX-m2, g.editTop-m2, innerW+2*m2, rows*g.cellH+2*m2);
        ctx.lineWidth=Math.max(1,g.cellW*0.03); ctx.strokeStyle="rgba(255,255,255,0.06)"; ctx.stroke(); }
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = `500 ${H*0.0158}px 'Helvetica Neue',Arial,sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText("FLAPPIT.COM", W/2, g.safeBotY - H*0.006);
      ctx.fillStyle = (Math.floor(e/16)%2) ? "#000000" : "#020202";   // esquina alterna (invisible): Safari solo graba fotogramas si el canvas cambia
      ctx.fillRect(0, 0, 3, 3);
      return {sum, active};
    }
    /* pista de audio determinista: pasos de todas las casillas por ventanas de 22 ms → clacs con su instante exacto */
    const BIN = 22, bins = new Map();
    for(const cell of cells){
      for(let n=1;n<=cell.steps;n++){
        const tt = cell.delay + stepTime(cell, n);
        const k = Math.floor(tt/BIN); bins.set(k, (bins.get(k)||0)+1);
      }
    }
    const clicks = [];   // {t: ms desde el inicio, g: ganancia}
    for(const [k,d] of bins){
      const n = Math.min(3, Math.ceil(d/5));
      const gv = Math.min(0.5, 0.07+d*0.008);
      for(let i2=0;i2<n;i2++) clicks.push({t: k*BIN + Math.random()*22, g: gv*(0.8+Math.random()*0.4)});
    }
    for(const ev of idleEvents){ for(let n=0;n<ev.k;n++) clicks.push({t: ev.t0 + n*IDLE_STEP, g: 0.16+Math.random()*0.06}); }
    for(const c of ctaCells){ for(let n=0;n<=c.cta.k;n++) clicks.push({t: c.cta.t0 + n*IDLE_STEP, g: 0.12+Math.random()*0.05}); }
    clicks.sort((a,b)=>a.t-b.t);
    const TOTAL = finishT + HOLD;
    return {W, H, LOW, cv, ctx, drawFrame, TOTAL, clicks};
  }

  function measureDuration(url){
    return new Promise(res=>{
      const v = document.createElement("video"); v.preload="metadata"; v.muted=true; v.playsInline=true;
      let done=false; const fin=x=>{ if(!done){ done=true; res(x); } };
      const t = setTimeout(()=>fin(null), 4000);
      v.onloadedmetadata = ()=>{
        if(isFinite(v.duration) && v.duration>0){ clearTimeout(t); fin(Math.round(v.duration*10)/10); }
        else { v.currentTime = 1e6; v.ontimeupdate = ()=>{ v.ontimeupdate=null; clearTimeout(t); fin(isFinite(v.duration)?Math.round(v.duration*10)/10:null); }; }   // webm sin cabecera de duración
      };
      v.onerror = ()=>{ clearTimeout(t); fin(null); };
      v.src = url;
    });
  }

  async function render(opts){
    if(!canRecord()) throw new Error("norecord");
    const onProgress = opts.onProgress || function(){};
    try{ if(document.fonts) await document.fonts.load("500 20px 'Roboto Condensed'"); }catch(e){}
    const {W, H, LOW, cv, drawFrame, TOTAL, clicks} = plan(opts);
    ensureAudio();
    try{ await audioCtx.resume(); }catch(e){}   // iOS: el contexto nace suspendido; sin esto los clacs se descartaban
    const stream = cv.captureStream(30);
    const vtrack = stream.getVideoTracks()[0];
    const pushFrame = (vtrack && typeof vtrack.requestFrame === "function") ? ()=>{ try{ vtrack.requestFrame(); }catch(e){} } : ()=>{};
    let combined = stream, dest = null;
    try{
      dest = audioCtx.createMediaStreamDestination();
      master.connect(dest);
      combined = new MediaStream(stream.getVideoTracks().concat(dest.stream.getAudioTracks()));
    }catch(e){}
    const mime = pickMime();
    const rec = new MediaRecorder(combined, mime ? {mimeType:mime, videoBitsPerSecond: LOW ? 4000000 : 6000000} : undefined);
    const chunks = [];
    rec.ondataavailable = e=>{ if(e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(res=>{ rec.onstop = res; });
    rec.start(200);
    drawFrame(0); pushFrame();
    const LEAD = 0.4;
    /* los clacs tienen su instante precalculado; se programan con 1,5 s de antelación (no todos de golpe:
       en un vídeo de 30 s son >2.000 y saturaban el motor de audio de Safari/iOS) */
    const a0 = audioCtx ? audioCtx.currentTime + LEAD : 0;
    let ci = 0;
    function scheduleUntil(ms){ if(!audioCtx) return; while(ci < clicks.length && clicks[ci].t <= ms){ const c = clicks[ci++]; clackAt(audioCtx, master, noise, a0 + c.t/1000, c.g); } }
    scheduleUntil(1500);
    const t0 = performance.now() + LEAD*1000;
    await new Promise(res=>{
      function loop(now){
        const e = now - t0;
        scheduleUntil(e + 1500);
        drawFrame(Math.max(0, e)); pushFrame();   // fotograma explícito: el grabador no puede saltarse la espera final
        onProgress(Math.min(0.98, Math.max(0, e)/TOTAL));
        if(e >= TOTAL){ res(); return; }   // fin por tiempo: coreografía + HOLD de mensaje quieto (con guiños)
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    });
    try{ rec.stop(); }catch(e){}
    await done;
    try{ if(dest) master.disconnect(dest); }catch(e){}
    onProgress(1);
    const blob = new Blob(chunks, {type: mime || "video/webm"});
    const ext = (mime||"").indexOf("mp4")>=0 ? "mp4" : "webm";
    const file = new File([blob], "flappit-"+(opts.name||"story")+"."+ext, {type: blob.type});
    const url = URL.createObjectURL(blob);
    const durationSec = await measureDuration(url);   // duración real del fichero (para comprobar que no se pierde la cola)
    try{ console.log("[flapvideo] pedido "+((TOTAL+400)/1000).toFixed(1)+" s · fichero "+(durationSec||"?")+" s"); }catch(e){}
    return {blob, file, url, ext, durationSec, plannedSec: (TOTAL+400)/1000};
  }

  /* pista de audio renderizada fuera de tiempo real (WAV 16 bit mono): para el render fotograma a fotograma */
  async function offlineAudio(clicks, durationMs, sampleRate){
    const sr = sampleRate||48000;
    const ac = new OfflineAudioContext(1, Math.ceil(sr*durationMs/1000), sr);
    const mst = ac.createGain(); mst.gain.value=0.8; mst.connect(ac.destination);
    const nz = makeNoise(ac);
    for(const c of clicks) clackAt(ac, mst, nz, c.t/1000, c.g);
    const buf = await ac.startRendering();
    const d = buf.getChannelData(0), n = d.length;
    const out = new ArrayBuffer(44 + n*2), v = new DataView(out);
    const str=(o,t)=>{ for(let i=0;i<t.length;i++) v.setUint8(o+i, t.charCodeAt(i)); };
    str(0,"RIFF"); v.setUint32(4, 36+n*2, true); str(8,"WAVE"); str(12,"fmt "); v.setUint32(16,16,true); v.setUint16(20,1,true);
    v.setUint16(22,1,true); v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
    str(36,"data"); v.setUint32(40, n*2, true);
    for(let i=0;i<n;i++){ const x=Math.max(-1,Math.min(1,d[i])); v.setInt16(44+i*2, x<0?x*32768:x*32767, true); }
    return new Blob([out], {type:"audio/wav"});
  }

  window.FlapVideo = {render, plan, offlineAudio, preview, canRecord, normalize, COLS, MAX_ROWS: 9};
})();
