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
    const editTop = safeTop + (safeH - rows*cellH)/2;
    const nTop = Math.ceil(editTop/cellH);
    const nBot = Math.ceil((H - (editTop + rows*cellH))/cellH);
    return {pad, cellW, cellH, editTop, nTop, nBot,
            top0: editTop - nTop*cellH, safeTop, safeBotY: H*(1 - REDES_SAFE_BOT)};
  }

  /* ---- sonido clac-clac ---- */
  let audioCtx=null, master=null, noise=null;
  function ensureAudio(){
    if(audioCtx){ audioCtx.resume(); return; }
    audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    master = audioCtx.createGain(); master.gain.value=0.8;
    master.connect(audioCtx.destination);
    const len=Math.floor(audioCtx.sampleRate*0.025);
    noise=audioCtx.createBuffer(1,len,audioCtx.sampleRate);
    const d=noise.getChannelData(0);
    for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/len,2.5);
  }
  function clickSnd(g, dt){
    if(!audioCtx||audioCtx.state!=="running") return;
    const t0 = audioCtx.currentTime + (dt||0);
    const hit = (tt, gg)=>{
      const n1=audioCtx.createBufferSource(); n1.buffer=noise;
      n1.playbackRate.value=1.9+Math.random()*0.5;
      const hp=audioCtx.createBiquadFilter(); hp.type="highpass"; hp.frequency.value=2800; hp.Q.value=0.7;
      const g1=audioCtx.createGain(); g1.gain.setValueAtTime(gg, tt); g1.gain.exponentialRampToValueAtTime(0.0001, tt+0.012);
      n1.connect(hp).connect(g1).connect(master); n1.start(tt);
      const n2=audioCtx.createBufferSource(); n2.buffer=noise; n2.playbackRate.value=2.1;
      const bp=audioCtx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=5800+Math.random()*1600; bp.Q.value=1.4;
      const g2=audioCtx.createGain(); g2.gain.setValueAtTime(gg*0.7, tt); g2.gain.exponentialRampToValueAtTime(0.0001, tt+0.010);
      n2.connect(bp).connect(g2).connect(master); n2.start(tt);
    };
    hit(t0, g*1.05);
    hit(t0 + 0.016 + Math.random()*0.006, g*0.65);
  }

  /* ---- casilla split-flap en canvas ---- */
  function drawCell(ctx,x,y,w,h,prevC,curC,p,flap,txt){
    const gap=w*0.045;
    const fx=x+gap, fy=y+gap, fw=w-2*gap, fh=h-2*gap;
    const half=fh/2, rad=Math.max(2,w*0.08), cx=x+w/2;
    const font=`500 ${fh*0.72}px 'Helvetica Neue',Arial,sans-serif`;
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
      ctx.save(); ctx.translate(cx, fy+half+fh*0.02); ctx.scale(0.74, 1); ctx.fillText(ch, 0, 0); ctx.restore();
      if(top){
        const sh=ctx.createLinearGradient(0,fy,0,fy+half);
        sh.addColorStop(0,"rgba(0,0,0,0.66)"); sh.addColorStop(0.55,"rgba(0,0,0,0.32)"); sh.addColorStop(1,"rgba(0,0,0,0.12)");
        ctx.fillStyle=sh; ctx.fillRect(fx,fy,fw,half);
      }
      ctx.restore();
      if(top){ halfPath(true); ctx.lineWidth = Math.max(0.6, w*0.012); ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.stroke(); }
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
    ctx.fillStyle="rgba(0,0,0,0.75)";
    ctx.fillRect(fx,fy+half-Math.max(1,h*0.008),fw,Math.max(2,h*0.016));
    const pw=Math.max(2,w*0.045), ph=Math.max(6,h*0.14);
    for(const px of [fx-pw*0.4, fx+fw-pw*0.6]){
      ctx.fillStyle="#0a0a0a"; ctx.beginPath();
      if(ctx.roundRect) ctx.roundRect(px,fy+half-ph/2,pw,ph,pw*0.4); else ctx.rect(px,fy+half-ph/2,pw,ph);
      ctx.fill();
      ctx.fillStyle="rgba(255,255,255,0.18)"; ctx.fillRect(px+pw*0.25,fy+half-ph/2+1,pw*0.28,ph-2);
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
      ctx.font = `500 ${H*0.0132}px 'Helvetica Neue',Arial,sans-serif`;
      ctx.textAlign="center"; ctx.textBaseline="bottom";
      ctx.fillText("FLAPPIT.COM/VIDEO", W/2, g.safeBotY - H*0.006);
    }
  }

  function preview(canvas, opts){
    const lines = cleanLines(opts.lines);
    const W = canvas.width, H = canvas.height;
    drawStatic(canvas.getContext("2d"), W, H, lines, opts.textColor||"#ffffff", opts.flapColor||"#16161A", true);
  }

  async function render(opts){
    if(!canRecord()) throw new Error("norecord");
    const lines = cleanLines(opts.lines);
    const textColor = opts.textColor||"#ffffff", flapColor = opts.flapColor||"#16161A";
    const onProgress = opts.onProgress || function(){};
    const W=1080, H=1920;
    const cv = document.createElement("canvas"); cv.width=W; cv.height=H;
    const ctx = cv.getContext("2d");
    const rows = Math.max(3, lines.length), cols = COLS;
    const g = redesGeom(W, H, cols, rows);
    const targets = buildTargets(lines, cols, rows, g);
    const T = 10000, LEAD_CUT = 2000, BASE_NOMINAL = 80;
    const letters = [];
    const cells = targets.map(tg=>{
      const d = tg===0 ? LEN : tg;
      const cell = {from:0, tg, d, steps:d, base:60, delay:Math.random()*350, slowN:0, F:0};
      if(tg>0) letters.push(cell);
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
      if(cell.tg===0) cell.F = T*(0.35 + Math.random()*0.35);
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
        if(ec<=0){ step=0; p=1; active=true; }
        else{
          step = Math.min(cell.steps, stepAt(cell, ec));
          p = Math.min(1,(ec-stepTime(cell,step))/FLIP_ANIM);
          if(step<cell.steps || ec < stepTime(cell,cell.steps) + FLIP_ANIM) active=true;
        }
        sum += step;
        const curc=(cell.from+step)%LEN;
        const prev= step===0?cell.from:(curc-1+LEN)%LEN;
        drawCell(ctx, offX + c2*g.cellW, g.top0 + r*g.cellH, g.cellW, g.cellH,
          CHARSET[prev], CHARSET[curc], step>=cell.steps?1:p, flapColor, textColor);
      }
      { const m2=Math.max(4,g.cellW*0.30), rr=Math.max(8,g.cellW*0.5);
        ctx.beginPath();
        if(ctx.roundRect) ctx.roundRect(offX-m2, g.editTop-m2, innerW+2*m2, rows*g.cellH+2*m2, rr);
        else ctx.rect(offX-m2, g.editTop-m2, innerW+2*m2, rows*g.cellH+2*m2);
        ctx.lineWidth=Math.max(1,g.cellW*0.03); ctx.strokeStyle="rgba(255,255,255,0.06)"; ctx.stroke(); }
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = `500 ${H*0.0132}px 'Helvetica Neue',Arial,sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText("FLAPPIT.COM/VIDEO", W/2, g.safeBotY - H*0.006);
      return {sum, active};
    }
    ensureAudio();
    const stream = cv.captureStream(30);
    let combined = stream, dest = null;
    try{
      dest = audioCtx.createMediaStreamDestination();
      master.connect(dest);
      combined = new MediaStream(stream.getVideoTracks().concat(dest.stream.getAudioTracks()));
    }catch(e){}
    const mime = pickMime();
    const rec = new MediaRecorder(combined, mime ? {mimeType:mime, videoBitsPerSecond:6000000} : undefined);
    const chunks = [];
    rec.ondataavailable = e=>{ if(e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(res=>{ rec.onstop = res; });
    rec.start(200);
    drawFrame(0);
    const t0 = performance.now() + 400;
    const TOTAL = T - LEAD_CUT + 3500 + 600;
    let sumPrev=0, lastTick=-999, ended=0;
    await new Promise(res=>{
      function loop(now){
        const e = now - t0;
        const {sum, active} = drawFrame(Math.max(0, e));
        const d = sum - sumPrev; sumPrev = sum;
        if(d>0 && now-lastTick>22){
          lastTick = now;
          const n = Math.min(3, Math.ceil(d/5));
          const gv = Math.min(0.5, 0.07+d*0.008);
          for(let i2=0;i2<n;i2++) clickSnd(gv*(0.8+Math.random()*0.4), Math.random()*0.022);
        }
        onProgress(Math.min(0.98, Math.max(0, e)/TOTAL));
        if(e>0 && !active && !ended) ended = now;
        if(ended && now-ended>3500){ res(); return; }
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
    return {blob, file, url: URL.createObjectURL(blob), ext};
  }

  window.FlapVideo = {render, preview, canRecord, normalize, COLS, MAX_ROWS: 9};
})();
