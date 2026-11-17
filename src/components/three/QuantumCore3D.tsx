import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { TERMINAL_THEMES } from '../../lib/themes';
import { BotStatus, CoreVisualMode, ThemeId, Trade } from '../../types/trading';

interface QuantumCore3DProps {
  status: BotStatus;
  openTradesCount: number;
  visualMode: CoreVisualMode;
  themeId: ThemeId;
  trades?: Trade[];
  t?: Record<string, string>;
}

const isSoftwareGl = (() => {
  if (typeof document === 'undefined') return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
})();

export const QuantumCore3D: React.FC<QuantumCore3DProps> = ({
  status,
  openTradesCount,
  visualMode,
  themeId,
  trades = [],
  t,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<BotStatus>(status);
  const openCountRef = useRef<number>(openTradesCount);
  const visualRef = useRef<CoreVisualMode>(visualMode);
  const themeRef = useRef<ThemeId>(themeId);
  const tradesRef = useRef<Trade[]>(trades);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    openCountRef.current = openTradesCount;
  }, [openTradesCount]);

  useEffect(() => {
    visualRef.current = visualMode;
  }, [visualMode]);

  useEffect(() => {
    themeRef.current = themeId;
  }, [themeId]);

  useEffect(() => {
    tradesRef.current = trades;
  }, [trades]);

  const openTrades = useMemo(
    () => trades.filter((tr) => tr.status === 'OPEN').slice(0, 4),
    [trades]
  );

  const closedTrades = useMemo(
    () => trades.filter((tr) => tr.status === 'CLOSED').slice(0, 4),
    [trades]
  );

  const lastClosedTrade = closedTrades[0];

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const width = Math.max(container.clientWidth, 180);
    const height = Math.max(container.clientHeight, 180);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 50);
    camera.position.set(0, 0.3, 4.7);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        alpha: true,
        powerPreference: 'low-power',
      });
    } catch {
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const torusGroup = new THREE.Group();
    const lorenzGroup = new THREE.Group();
    const vortexGroup = new THREE.Group();
    const depthGroup = new THREE.Group();
    const radarBlipsGroup = new THREE.Group();
    scene.add(torusGroup, lorenzGroup, vortexGroup, depthGroup, radarBlipsGroup);

    // --- 1. TOROIDAL SINGULARITY ---
    const outerGeo = new THREE.IcosahedronGeometry(1.38, 1);
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      wireframe: true,
      transparent: true,
      opacity: 0.28,
    });
    const outerMesh = new THREE.Mesh(outerGeo, outerMat);
    torusGroup.add(outerMesh);

    const torusGeo = new THREE.TorusGeometry(0.86, 0.26, 14, 42);
    const torusMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      wireframe: true,
      transparent: true,
      opacity: 0.68,
    });
    const torusMesh = new THREE.Mesh(torusGeo, torusMat);
    torusMesh.rotation.x = Math.PI / 3;
    torusGroup.add(torusMesh);

    const ringGeo = new THREE.RingGeometry(1.54, 1.58, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.45,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 2.3;
    torusGroup.add(ringMesh);

    // --- 2. LORENZ CHAOS ATTRACTOR ---
    const lorenzPoints: THREE.Vector3[] = [];
    let lx = 0.1;
    let ly = 0;
    let lz = 0;
    const dt = 0.008;
    for (let i = 0; i < 1400; i++) {
      const dx = 10 * (ly - lx) * dt;
      const dy = (lx * (28 - lz) - ly) * dt;
      const dz = (lx * ly - (8 / 3) * lz) * dt;
      lx += dx;
      ly += dy;
      lz += dz;
      lorenzPoints.push(new THREE.Vector3(lx * 0.055, (lz - 25) * 0.052, ly * 0.055));
    }
    const lorenzGeo = new THREE.BufferGeometry().setFromPoints(lorenzPoints);
    const lorenzMat = new THREE.LineBasicMaterial({
      color: 0x10b981,
      transparent: true,
      opacity: 0.9,
    });
    const lorenzLine = new THREE.Line(lorenzGeo, lorenzMat);
    lorenzGroup.add(lorenzLine);

    const lorenzBoxGeo = new THREE.BoxGeometry(2.4, 2.2, 2.4);
    const lorenzEdges = new THREE.EdgesGeometry(lorenzBoxGeo);
    const lorenzBoxMat = new THREE.LineBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.22,
    });
    lorenzGroup.add(new THREE.LineSegments(lorenzEdges, lorenzBoxMat));

    // --- 3. LIQUIDITY VORTEX SPIRAL ---
    const vortexCount = 720;
    const vortexPos = new Float32Array(vortexCount * 3);
    for (let i = 0; i < vortexCount; i++) {
      const arm = i % 4;
      const tv = (i / vortexCount) * 1.55 + 0.18;
      const angle = tv * 5.2 + (arm * Math.PI) / 2;
      const yOffset = ((i % 7) - 3) * 0.035;
      vortexPos[i * 3] = Math.cos(angle) * tv;
      vortexPos[i * 3 + 1] = yOffset - tv * 0.14;
      vortexPos[i * 3 + 2] = Math.sin(angle) * tv;
    }
    const vortexGeo = new THREE.BufferGeometry();
    vortexGeo.setAttribute('position', new THREE.BufferAttribute(vortexPos, 3));
    const vortexMat = new THREE.PointsMaterial({
      color: 0x22d3ee,
      size: 0.045,
      transparent: true,
      opacity: 0.9,
    });
    const vortexPts = new THREE.Points(vortexGeo, vortexMat);
    vortexPts.rotation.x = 0.65;
    vortexGroup.add(vortexPts);

    const vortexRingGeo = new THREE.RingGeometry(1.42, 1.46, 64);
    const vortexRingMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.4,
    });
    const vortexRing = new THREE.Mesh(vortexRingGeo, vortexRingMat);
    vortexRing.rotation.x = Math.PI / 2 + 0.65;
    vortexGroup.add(vortexRing);

    // --- 4. L3 ORDERBOOK TERRAIN BARS ---
    const barGeo = new THREE.BoxGeometry(0.16, 1, 0.16);
    const bidMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      wireframe: false,
      transparent: true,
      opacity: 0.78,
    });
    const askMat = new THREE.MeshBasicMaterial({
      color: 0xf43f5e,
      wireframe: false,
      transparent: true,
      opacity: 0.78,
    });
    const depthBars: { mesh: THREE.Mesh; phase: number; isBid: boolean }[] = [];
    for (let x = -4; x <= 4; x++) {
      for (let z = -2; z <= 2; z++) {
        if (x === 0) continue;
        const isBid = x < 0;
        const m = new THREE.Mesh(barGeo, isBid ? bidMat : askMat);
        m.position.set(x * 0.25, -0.5, z * 0.28);
        depthGroup.add(m);
        depthBars.push({ mesh: m, phase: Math.abs(x) * 0.6 + z * 0.4, isBid });
      }
    }
    depthGroup.rotation.x = 0.35;
    depthGroup.rotation.y = -0.35;

    // --- 5. RADAR ORBITING TRADE NODES + HISTORICAL ENTRY->EXIT GEOMETRIC CONNECTORS ---
    const blipGeo = new THREE.SphereGeometry(0.075, 10, 10);
    const radarBlips: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x34d399,
        transparent: true,
        opacity: 0.92,
      });
      const mesh = new THREE.Mesh(blipGeo, mat);
      mesh.visible = false;
      radarBlipsGroup.add(mesh);
      radarBlips.push({ mesh, mat });
    }

    const histEntryGeo = new THREE.OctahedronGeometry(0.055, 0);
    const histExitGeo = new THREE.SphereGeometry(0.058, 10, 10);
    const histConnectors: {
      line: THREE.Line;
      lineGeo: THREE.BufferGeometry;
      lineMat: THREE.LineBasicMaterial;
      entryMesh: THREE.Mesh;
      exitMesh: THREE.Mesh;
      nodeMat: THREE.MeshBasicMaterial;
    }[] = [];

    for (let i = 0; i < 6; i++) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, 0),
      ]);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x10b981,
        transparent: true,
        opacity: 0.88,
      });
      const line = new THREE.Line(lineGeo, lineMat);
      line.visible = false;

      const nodeMat = new THREE.MeshBasicMaterial({
        color: 0x10b981,
        transparent: true,
        opacity: 0.95,
      });
      const entryMesh = new THREE.Mesh(histEntryGeo, nodeMat);
      const exitMesh = new THREE.Mesh(histExitGeo, nodeMat);
      entryMesh.visible = false;
      exitMesh.visible = false;

      radarBlipsGroup.add(line, entryMesh, exitMesh);
      histConnectors.push({ line, lineGeo, lineMat, entryMesh, exitMesh, nodeMat });
    }

    const clock = new THREE.Clock();
    const targetPrimary = new THREE.Color();
    const targetSecondary = new THREE.Color();
    let frameId = 0;
    let disposed = false;

    const resizeObserver = new ResizeObserver((entries) => {
      if (disposed) return;
      for (const entry of entries) {
        const w = Math.max(entry.contentRect.width, 140);
        const h = Math.max(entry.contentRect.height, 140);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
    });
    resizeObserver.observe(container);

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (!gl || typeof gl.fenceSync !== 'function') {
        frameId = window.setTimeout(cb, 90);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 8);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 8);
    }

    function updateScene(delta: number, elapsed: number) {
      const currentStatus = statusRef.current;
      const mode = visualRef.current;
      const activeTheme = TERMINAL_THEMES[themeRef.current];
      const isRunning = currentStatus === 'RUNNING';
      const isOffline = currentStatus === 'OFFLINE';
      const activeBoost = isRunning ? 1 + Math.min(openCountRef.current, 6) * 0.22 : 0.26;

      torusGroup.visible = mode === 'torus';
      lorenzGroup.visible = mode === 'lorenz';
      vortexGroup.visible = mode === 'vortex';
      depthGroup.visible = mode === 'depth';

      if (isOffline) {
        targetPrimary.setHex(0xf43f5e);
        targetSecondary.setHex(0xf59e0b);
      } else if (!isRunning) {
        targetPrimary.setHex(0x64748b);
        targetSecondary.setHex(0x334155);
      } else {
        targetPrimary.setHex(activeTheme.threePrimary);
        targetSecondary.setHex(activeTheme.threeSecondary);
      }

      torusMat.color.lerp(targetPrimary, 0.1);
      outerMat.color.lerp(targetSecondary, 0.1);
      ringMat.color.lerp(targetSecondary, 0.1);
      lorenzMat.color.lerp(targetPrimary, 0.1);
      lorenzBoxMat.color.lerp(targetSecondary, 0.1);
      vortexMat.color.lerp(targetSecondary, 0.1);
      vortexRingMat.color.lerp(targetPrimary, 0.1);
      bidMat.color.lerp(targetPrimary, 0.1);

      const speed = delta * activeBoost;

      if (mode === 'torus') {
        torusMesh.rotation.y += speed * 0.95;
        torusMesh.rotation.z += speed * 0.45;
        outerMesh.rotation.y -= speed * 0.35;
        outerMesh.rotation.x += speed * 0.18;
        ringMesh.rotation.z += speed * 0.55;
        const pulse = isRunning ? 1 + Math.sin(elapsed * 3.2) * 0.045 : 1;
        torusMesh.scale.setScalar(pulse);
      } else if (mode === 'lorenz') {
        lorenzGroup.rotation.y += speed * 0.55;
        lorenzGroup.rotation.x = Math.sin(elapsed * 0.5) * 0.25;
      } else if (mode === 'vortex') {
        vortexPts.rotation.y += speed * 1.1;
        vortexRing.rotation.z -= speed * 0.6;
      } else if (mode === 'depth') {
        depthGroup.rotation.y = -0.35 + Math.sin(elapsed * 0.6) * 0.22;
        depthBars.forEach((b) => {
          const h = 0.28 + Math.abs(Math.sin(elapsed * (isRunning ? 2.4 : 0.7) + b.phase)) * 1.05;
          b.mesh.scale.y = h;
          b.mesh.position.y = -0.6 + h * 0.5;
        });
      }

      // Position active open trade blips orbiting the 3D radar
      const liveOpen = tradesRef.current.filter((tr) => tr.status === 'OPEN').slice(0, 8);
      radarBlips.forEach((b, i) => {
        const trade = liveOpen[i];
        if (!trade) {
          b.mesh.visible = false;
          return;
        }
        b.mesh.visible = true;
        const angle = elapsed * 0.8 + (i * Math.PI * 2) / Math.max(1, liveOpen.length);
        const radius = 1.48;
        b.mesh.position.set(
          Math.cos(angle) * radius,
          Math.sin(angle * 1.5) * 0.45,
          Math.sin(angle) * radius
        );
        b.mat.color.setHex(trade.profit_usdt >= 0 ? 0x34d399 : 0xfbbf24);
        const s = 1 + Math.sin(elapsed * 4 + i) * 0.22;
        b.mesh.scale.setScalar(s);
      });

      // Position historical closed trades as Entry -> Exit geometric beams (Green=Profit, Red=Loss)
      const histClosed = tradesRef.current.filter((tr) => tr.status === 'CLOSED').slice(0, 6);
      histConnectors.forEach((hc, i) => {
        const tr = histClosed[i];
        if (!tr) {
          hc.line.visible = false;
          hc.entryMesh.visible = false;
          hc.exitMesh.visible = false;
          return;
        }
        hc.line.visible = true;
        hc.entryMesh.visible = true;
        hc.exitMesh.visible = true;

        const isProfit = tr.profit_usdt >= 0;
        const hex = isProfit ? 0x10b981 : 0xf43f5e;
        hc.lineMat.color.setHex(hex);
        hc.nodeMat.color.setHex(hex);

        const baseAngle = elapsed * 0.35 + (i * Math.PI * 2) / Math.max(1, histClosed.length);
        const exitAngle = baseAngle + 0.55;
        const rIn = 0.88;
        const rOut = 1.56;
        const yIn = -0.35 + (i % 3) * 0.25;
        const deltaLift = Math.max(-0.45, Math.min(0.45, (tr.profit_pct / 5) * 0.45));
        const yOut = yIn + deltaLift;

        const p1 = new THREE.Vector3(Math.cos(baseAngle) * rIn, yIn, Math.sin(baseAngle) * rIn);
        const p2 = new THREE.Vector3(Math.cos(exitAngle) * rOut, yOut, Math.sin(exitAngle) * rOut);

        hc.entryMesh.position.copy(p1);
        hc.exitMesh.position.copy(p2);
        hc.entryMesh.rotation.y = elapsed * 1.4;

        const posAttr = hc.lineGeo.getAttribute('position') as THREE.BufferAttribute;
        posAttr.setXYZ(0, p1.x, p1.y, p1.z);
        posAttr.setXYZ(1, p2.x, p2.y, p2.z);
        posAttr.needsUpdate = true;
      });
    }

    function tick() {
      if (disposed) return;
      if (document.hidden) {
        frameId = window.setTimeout(tick, 350);
        return;
      }
      const delta = Math.min(clock.getDelta(), 0.1);
      const elapsed = clock.getElapsedTime();
      updateScene(delta, elapsed);
      renderer.render(scene, camera);

      if (!reducedMotion) {
        if (isSoftwareGl) afterDraw(tick);
        else frameId = requestAnimationFrame(tick);
      }
    }

    if (reducedMotion) {
      updateScene(0.016, 0);
      renderer.render(scene, camera);
    } else {
      tick();
    }

    const handleVisibility = () => {
      if (!document.hidden && !reducedMotion) {
        clock.getDelta();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      outerGeo.dispose();
      outerMat.dispose();
      torusGeo.dispose();
      torusMat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      lorenzGeo.dispose();
      lorenzMat.dispose();
      lorenzBoxGeo.dispose();
      lorenzEdges.dispose();
      lorenzBoxMat.dispose();
      vortexGeo.dispose();
      vortexMat.dispose();
      vortexRingGeo.dispose();
      vortexRingMat.dispose();
      barGeo.dispose();
      bidMat.dispose();
      askMat.dispose();
      blipGeo.dispose();
      radarBlips.forEach((b) => b.mat.dispose());
      histEntryGeo.dispose();
      histExitGeo.dispose();
      histConnectors.forEach((hc) => {
        hc.lineGeo.dispose();
        hc.lineMat.dispose();
        hc.nodeMat.dispose();
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div className="w-full space-y-1.5">
      <div
        ref={containerRef}
        className="relative flex h-44 w-full items-center justify-center overflow-hidden sm:h-52"
        aria-label="3D Quantum Core Radar Visualization"
      />

      {/* Radar Trade Dots + Last Closed Realized Profit/Loss */}
      <div className="space-y-1 rounded-lg border border-slate-800/80 bg-[#04060b] px-2 py-1.5 font-mono-tech text-[10px]">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="text-slate-400 uppercase">{t?.radarLastResult ?? 'Last Closed'}:</span>
          {lastClosedTrade ? (
            <span
              className={`font-bold ${
                lastClosedTrade.profit_usdt >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {lastClosedTrade.pair.replace('USDT', '')} {lastClosedTrade.profit_usdt >= 0 ? '+' : ''}
              ${lastClosedTrade.profit_usdt.toFixed(2)}
            </span>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </div>
        {closedTrades.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            {closedTrades.map((tr) => {
              const isPos = tr.profit_usdt >= 0;
              return (
                <span
                  key={tr.id}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold ${
                    isPos
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                  }`}
                >
                  ◆─● {tr.pair.replace('USDT', '')} {isPos ? '+' : ''}${tr.profit_usdt.toFixed(2)}
                </span>
              );
            })}
          </div>
        )}
        {openTrades.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {openTrades.map((tr) => (
              <span
                key={tr.id}
                className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                  tr.profit_usdt >= 0
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-amber-500/15 text-amber-300'
                }`}
              >
                ● {tr.pair.replace('USDT', '')} {tr.profit_usdt >= 0 ? '+' : ''}$
                {tr.profit_usdt.toFixed(2)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
