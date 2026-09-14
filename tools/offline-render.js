// Render fotograma a fotograma (determinista) → ffmpeg H.264/AAC. Uso: node offline.js out.mp4 '["LINEA1","LINEA2"]' '#ffffff' '#16161A'
const { chromium } = require('playwright'); const fs=require('fs'); const { spawn } = require('child_process');
const [,, out, linesJson, txt, flap, dur, cta] = process.argv; const FPS=30;
(async()=>{
  const b=await chromium.launch(); const p=await b.newPage();
  await p.goto('http://localhost:8767/video-split-flap.html');
  const info = await p.evaluate(async(o)=>{ window.__P = FlapVideo.plan({lines:o.lines, textColor:o.txt, flapColor:o.flap, duration:o.dur||15, cta:o.cta||'', lowPower:false}); const P=window.__P;
    const wav = await FlapVideo.offlineAudio(P.clicks, P.TOTAL+400); const ab=await wav.arrayBuffer(); let s=''; const u=new Uint8Array(ab); for(let i=0;i<u.length;i+=8192) s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
    return {W:P.W,H:P.H,TOTAL:P.TOTAL, wav: btoa(s), clicks:P.clicks.length}; }, {lines:JSON.parse(linesJson), txt, flap, dur:Number(dur)||15, cta:cta||''});
  fs.writeFileSync('/tmp/fl_audio.wav', Buffer.from(info.wav,'base64'));
  const nFrames = Math.ceil((info.TOTAL+400)/1000*FPS);
  console.log(`plan ${info.W}x${info.H} ${info.TOTAL}ms ${nFrames} frames ${info.clicks} clacs`);
  const ff = spawn('ffmpeg', ['-v','error','-y','-f','image2pipe','-vcodec','mjpeg','-framerate',String(FPS),'-i','-','-i','/tmp/fl_audio.wav','-c:v','libx264','-preset','slow','-crf','18','-pix_fmt','yuv420p','-r',String(FPS),'-c:a','aac','-b:a','128k','-shortest','-movflags','+faststart', out]);
  ff.stderr.on('data', d=>process.stderr.write(d));
  const LEAD=400; // ms de tablero en blanco al principio (como en tiempo real)
  for(let f=0; f<nFrames; f+=10){
    const chunk = await p.evaluate((o)=>{ const P=window.__P; const outArr=[]; for(let k=o.f;k<Math.min(o.f+10,o.n);k++){ const e = k*1000/o.fps - o.lead; P.drawFrame(Math.max(0,e)); outArr.push(P.cv.toDataURL('image/jpeg',0.93).split(',')[1]); } return outArr; }, {f, n:nFrames, fps:FPS, lead:LEAD});
    for(const c of chunk){ const buf=Buffer.from(c,'base64'); if(!ff.stdin.write(buf)) await new Promise(r=>ff.stdin.once('drain', r)); }
  }
  ff.stdin.end(); await new Promise(r=>ff.on('close', r)); await b.close();
  console.log('done', out, (fs.statSync(out).size/1e6).toFixed(1)+'MB');
})().catch(e=>{console.error(e);process.exit(1);});
