(function(){
  const canvas = document.getElementById('map');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const cov = document.getElementById('cov');
  const covbar = document.getElementById('covbar');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setCoverage(c){
    const pct = Math.round(c*100);
    if(cov) cov.textContent = pct+'%';
    if(covbar) covbar.style.width = pct+'%';
  }

  // ---- world grid (oversized so it overflows the banner and leaves no empty corners) ----
  const GX = 32, GY = 32;
  const AGENT = ['#C0392B','#2E8B57','#1E3FC8'];

  // voxel face palette (light top, gray sides for a 3D read)
  const FLR = { top:'#F4F5EF', right:'#D7DBD0', left:'#C2C6BB', st:'rgba(20,23,26,.10)' };
  const OBS = { top:'#394046', right:'#282E33', left:'#191D20', st:'rgba(20,23,26,.30)' };

  // movement / behavior tuning
  const SPEED = 0.06, SEP_R = 2.8, MINSEP = 2.0, SENSE_R = 3.0, DRONE_Z = 1.6;

  let cells, agents, maxH, frames;
  let TW, TH, VH, ORX, ORY, CW, CH, visCount;

  function idx(x,y){ return y*GX + x; }

  function build(){
    cells = new Array(GX*GY);
    for(let y=0;y<GY;y++) for(let x=0;x<GX;x++){
      cells[idx(x,y)] = { h:1, obstacle:false, revealed:false, grow:0, vis:false };
    }

    // scatter obstacle clusters (taller, black voxels)
    for(let n=0;n<18;n++){
      const cx = 1+Math.floor(Math.random()*(GX-2));
      const cy = 1+Math.floor(Math.random()*(GY-2));
      const blob = 2+Math.floor(Math.random()*4);
      const ht = 2+Math.floor(Math.random()*3);            // 2..4
      for(let b=0;b<blob;b++){
        const bx = Math.max(0,Math.min(GX-1, cx+Math.floor(Math.random()*3)-1));
        const by = Math.max(0,Math.min(GY-1, cy+Math.floor(Math.random()*3)-1));
        const c = cells[idx(bx,by)];
        c.obstacle = true;
        c.h = Math.max(c.h, ht);
      }
    }

    maxH = 1;
    for(const c of cells) if(c.h>maxH) maxH = c.h;

    frames = 0;
    agents = [];
    for(let i=0;i<3;i++){
      const x = GX/2 + (i-1)*2.2, y = GY/2 + (i-1)*1.4;
      // prio = i (lower number = higher priority). Drones only yield to higher
      // priority, so avoidance is asymmetric and can never deadlock.
      agents.push({ x, y, wp:null, path:[], bestDist:Infinity, noProg:0, prio:i });
    }
  }

  function resize(){
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width*dpr);
    canvas.height = Math.round(r.height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    CW = r.width; CH = r.height;

    // scale so the ground plane COVERS the rectangle (corners included, edges crop)
    const N = GX;                                    // GX == GY
    TW = ((CW/2 + CH) / N) * 1.04;                   // covering constraint + margin
    TH = TW*0.5; VH = TW*0.62;
    ORX = CW/2;
    ORY = CH*0.54 - N*TH;                            // ground centered a touch low for headroom

    // "play area": inset region drones patrol, so they stay on-screen.
    // Sensing still reaches past it, so white voxels keep filling everywhere.
    const PADX = CW*0.08;
    const PADT = Math.max(CH*0.14, DRONE_Z*VH + 14);  // headroom for drone altitude at top
    const PADB = CH*0.10;

    // UI overlays the drones must not put obstacles or waypoints under:
    //   - axis gizmo (top-left)   - coverage/legend caption (bottom strip)
    const GZ_W = 78, GZ_H = 68;      // gizmo footprint (px)
    const CAP_H = 30;                // caption strip height (px)
    const WP_GAP = 16;               // extra breathing room for waypoints
    // waypoint keep-out: ground footprint of the overlays + gap
    const wpBlocked = (px,py) => (px < GZ_W+WP_GAP && py < GZ_H+WP_GAP) || py > CH-(CAP_H+WP_GAP);

    visCount = 0; maxH = 1;
    for(let y=0;y<GY;y++) for(let x=0;x<GX;x++){
      const c = cells[idx(x,y)];
      const p = proj(x+0.5, y+0.5, 0);
      // no black voxels overlapping the overlays. Obstacles rise upward, so also
      // demote ones just below the gizmo whose top would poke up into it.
      if(c.obstacle){
        const topY = p[1] - c.h*VH;
        if((p[0] < GZ_W+4 && topY < GZ_H+4) || p[1] > CH-(CAP_H+2)){ c.obstacle=false; c.h=1; }
      }
      if(c.h>maxH) maxH=c.h;
      // waypoints: inside the inset play area AND clear of the overlays
      const v = !wpBlocked(p[0], p[1])
             && p[0]>=PADX && p[0]<=CW-PADX && p[1]>=PADT && p[1]<=CH-PADB;
      c.vis = v;
      if(v) visCount++;
    }
  }

  function proj(x,y,z){
    return [ ORX + (x-y)*TW, ORY + (x+y)*TH - z*VH ];
  }

  function poly(pts, fill, stroke){
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if(stroke){ ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }

  function drawColumn(gx,gy,c){
    const g = c.grow<1 ? c.grow*c.grow*(3-2*c.grow) : 1;   // smoothstep pop-in
    const top = c.h*g;
    const col = c.obstacle ? OBS : FLR;

    const A=proj(gx,gy,top), B=proj(gx+1,gy,top), C=proj(gx+1,gy+1,top), D=proj(gx,gy+1,top);
    const Bb=proj(gx+1,gy,0), Cb=proj(gx+1,gy+1,0), Db=proj(gx,gy+1,0);

    poly([B,C,Cb,Bb], col.right, col.st);   // right side face
    poly([D,C,Cb,Db], col.left,  col.st);   // left side face
    poly([A,B,C,D],   col.top,   col.st);   // top face
  }

  function drawWaypoint(a,i,t){
    if(!a.wp) return;
    const p = proj(a.wp.x+0.5, a.wp.y+0.5, 0);
    const col = AGENT[i];
    const pulse = 0.5+0.5*Math.sin(t/300 + i*2);
    ctx.strokeStyle = col; ctx.lineWidth = 1.3; ctx.globalAlpha = 0.35+0.4*pulse;
    ctx.beginPath();
    ctx.ellipse(p[0], p[1], TW*(0.35+0.35*pulse), TH*(0.35+0.35*pulse), 0, 0, Math.PI*2);
    ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(p[0], p[1], 1.6, 0, Math.PI*2); ctx.fill();
  }

  function drawDrone(a,i,t){
    const col = AGENT[i];
    const z = DRONE_Z + i*0.32 + Math.sin(t/360 + i*2)*0.2;

    const s = proj(a.x, a.y, 0);
    ctx.globalAlpha = 0.13; ctx.fillStyle = '#14171A';
    ctx.beginPath(); ctx.ellipse(s[0], s[1], TW*0.55, TH*0.55, 0, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;

    const p = proj(a.x, a.y, z);
    const r = Math.max(6, TW*0.68);

    ctx.strokeStyle = col; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(p[0]-r, p[1]-r*0.5); ctx.lineTo(p[0]+r, p[1]+r*0.5);
    ctx.moveTo(p[0]+r, p[1]-r*0.5); ctx.lineTo(p[0]-r, p[1]+r*0.5);
    ctx.stroke();

    const rot = [[-r,-r*0.5],[r,r*0.5],[r,-r*0.5],[-r,r*0.5]];
    for(const o of rot){
      ctx.beginPath();
      ctx.ellipse(p[0]+o[0], p[1]+o[1], r*0.42, r*0.2, 0, 0, Math.PI*2);
      ctx.globalAlpha = 0.22; ctx.fillStyle = col; ctx.fill();
      ctx.globalAlpha = 1;   ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
    }

    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(p[0], p[1], 2.4, 0, Math.PI*2); ctx.fill();
  }

  // a cell blocks pathing only once its obstacle has been discovered (revealed)
  function blocked(x,y){
    if(x<0||y<0||x>=GX||y>=GY) return true;
    const c = cells[idx(x,y)];
    return c.revealed && c.obstacle;
  }

  function heur(x,y,gx,gy){
    const dx=Math.abs(x-gx), dy=Math.abs(y-gy);
    return (dx+dy) + (1.4142-2)*Math.min(dx,dy);   // octile
  }

  function astar(sx,sy,gx,gy){
    if(blocked(gx,gy)) return null;
    const N = GX*GY;
    const g = new Float64Array(N).fill(Infinity);
    const f = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const inOpen = new Uint8Array(N);
    const open = [];
    const s = idx(sx,sy), goal = idx(gx,gy);
    g[s]=0; f[s]=heur(sx,sy,gx,gy); open.push(s); inOpen[s]=1;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

    while(open.length){
      let bi=0; for(let i=1;i<open.length;i++) if(f[open[i]]<f[open[bi]]) bi=i;
      const cur = open[bi];
      if(cur===goal){
        const path=[]; let n=cur;
        while(n!==s && n!==-1){ path.push({x:n%GX, y:(n/GX)|0}); n=came[n]; }
        path.reverse(); return path;
      }
      open.splice(bi,1); inOpen[cur]=0;
      const cx=cur%GX, cy=(cur/GX)|0;
      for(const [ddx,ddy] of dirs){
        const nx=cx+ddx, ny=cy+ddy;
        if(blocked(nx,ny)) continue;
        if(ddx!==0 && ddy!==0 && (blocked(cx+ddx,cy)||blocked(cx,cy+ddy))) continue; // no corner cutting
        const ni=idx(nx,ny);
        const tg = g[cur] + ((ddx!==0&&ddy!==0)?1.4142:1);
        if(tg < g[ni]){
          came[ni]=cur; g[ni]=tg; f[ni]=tg+heur(nx,ny,gx,gy);
          if(!inOpen[ni]){ open.push(ni); inOpen[ni]=1; }
        }
      }
    }
    return null;
  }

  function plan(a){
    const p = astar(Math.floor(a.x), Math.floor(a.y), a.wp.x, a.wp.y);
    a.path = p || [];
  }

  function pathBlocked(a){
    for(const n of a.path) if(blocked(n.x,n.y)) return true;
    return false;
  }

  function newWaypoint(a){
    let best=null, bd=-Infinity;
    for(let n=0;n<140;n++){
      const x=Math.floor(Math.random()*GX), y=Math.floor(Math.random()*GY);
      const c = cells[idx(x,y)];
      if(!c.vis || (c.revealed && c.obstacle)) continue;
      let score = Math.hypot(x-a.x, y-a.y) + (c.revealed?0:6);   // favor far, unexplored
      for(const o of agents){ if(o!==a && o.wp){ const s=Math.hypot(x-o.wp.x,y-o.wp.y); if(s<4) score-=(4-s)*2; } }
      if(score>bd){ bd=score; best={x,y}; }
    }
    if(!best) best = { x:Math.floor(a.x), y:Math.floor(a.y) };
    a.wp = best; plan(a);

    let tries=0;
    while(a.path.length===0 && !(Math.floor(a.x)===a.wp.x && Math.floor(a.y)===a.wp.y) && tries<6){
      const x=Math.floor(Math.random()*GX), y=Math.floor(Math.random()*GY);
      const c = cells[idx(x,y)];
      if(c.vis && !(c.revealed && c.obstacle)){ a.wp={x,y}; plan(a); }
      tries++;
    }
    a.bestDist = Infinity; a.noProg = 0;   // reset progress tracker for the new goal
  }

  function sense(a){
    const minx=Math.max(0,Math.floor(a.x-SENSE_R)), maxx=Math.min(GX-1,Math.ceil(a.x+SENSE_R));
    const miny=Math.max(0,Math.floor(a.y-SENSE_R)), maxy=Math.min(GY-1,Math.ceil(a.y+SENSE_R));
    for(let y=miny;y<=maxy;y++) for(let x=minx;x<=maxx;x++){
      if(Math.hypot((x+0.5)-a.x,(y+0.5)-a.y) <= SENSE_R){
        const c = cells[idx(x,y)];
        if(!c.revealed){ c.revealed=true; c.grow=0; }
      }
    }
  }

  function follow(a){
    if(a.path.length===0) return;
    const node = a.path[0];
    const tx=node.x+0.5, ty=node.y+0.5;
    let dx=tx-a.x, dy=ty-a.y;
    const d=Math.hypot(dx,dy)||1e-6;
    if(d<0.28){ a.path.shift(); return; }

    // separation steering — only yield to HIGHER-priority drones (asymmetric,
    // so two drones can never lock into a mutual standoff)
    let sepx=0, sepy=0;
    for(const o of agents){
      if(o===a || o.prio >= a.prio) continue;
      const ox=a.x-o.x, oy=a.y-o.y, od=Math.hypot(ox,oy);
      if(od>0 && od<SEP_R){ sepx+=(ox/od)*(SEP_R-od); sepy+=(oy/od)*(SEP_R-od); }
    }
    // repulsion + a consistent perpendicular "swirl" so drones slide past
    // each other instead of locking head-on
    let vx=dx/d + sepx*0.55 - sepy*0.6, vy=dy/d + sepy*0.55 + sepx*0.6;
    const vl=Math.hypot(vx,vy)||1e-6;
    a.x += (vx/vl)*SPEED; a.y += (vy/vl)*SPEED;
  }

  function enforceSeparation(){
    // agents[i] has higher priority than agents[j] for i<j. Only move the
    // lower-priority drone aside so the higher one keeps a smooth course.
    for(let i=0;i<agents.length;i++) for(let j=i+1;j<agents.length;j++){
      const a=agents[i], b=agents[j];
      let dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy);
      if(d<MINSEP){
        if(d<1e-4){ dx=Math.random()-0.5; dy=Math.random()-0.5; d=Math.hypot(dx,dy)||1e-6; }
        const push=(MINSEP-d);
        b.x+=(dx/d)*push; b.y+=(dy/d)*push;
      }
    }
  }

  function step(){
    frames++;
    for(const a of agents) sense(a);                 // discover obstacles before (re)planning
    for(const a of agents){
      if(!a.wp) newWaypoint(a);
      if(a.path.length===0 || pathBlocked(a)) plan(a);
      if(a.path.length===0) newWaypoint(a);          // reached or stuck -> new goal
      follow(a);
    }
    enforceSeparation();

    // break standoffs: track PROGRESS toward the waypoint (not raw motion — the
    // separation push jitters them in place, which would mask a real deadlock).
    // If a drone gets no closer to its goal for a while, hand it a fresh one.
    for(const a of agents){
      if(!a.wp) continue;
      const dwp = Math.hypot((a.wp.x+0.5)-a.x, (a.wp.y+0.5)-a.y);
      if(dwp < a.bestDist - 0.04){ a.bestDist = dwp; a.noProg = 0; }
      else a.noProg++;
      if(a.noProg > 48) newWaypoint(a);
    }

    for(const c of cells) if(c.revealed && c.grow<1) c.grow=Math.min(1, c.grow+0.09);
  }

  function draw(t){
    ctx.clearRect(0,0,CW,CH);
    for(let x=0;x<GX;x++) for(let y=0;y<GY;y++){       // back-to-front
      const c = cells[idx(x,y)];
      if(c.revealed && c.grow>0.001) drawColumn(x,y,c);
    }
    agents.forEach((a,i)=>drawWaypoint(a,i,t));
    agents.forEach((a,i)=>drawDrone(a,i,t));
  }

  function coverage(){
    let seen=0; for(const c of cells) if(c.vis && c.revealed) seen++;
    return visCount ? seen/visCount : 0;
  }

  function reset(){ build(); resize(); }

  let last = 0;
  function loop(t){
    if(t-last > 45){
      last = t;
      step();
      draw(t);
      const c = coverage();
      setCoverage(c);
      if(c > 0.9 || frames > 2000) reset();
    }
    requestAnimationFrame(loop);
  }

  build();
  resize();
  window.addEventListener('resize', ()=>{ resize(); draw(0); });

  if(reduced){
    for(const c of cells) if(c.vis){ c.revealed=true; c.grow=1; }
    draw(0);
    setCoverage(1);
  } else {
    requestAnimationFrame(loop);
  }
})();
