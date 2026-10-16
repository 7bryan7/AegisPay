'use client';

import { useEffect, useRef, useCallback } from 'react';

const features = [
  { title: 'ENSv2 Discovery', desc: '"Who can do this?" — Providers publish machine-readable identities and capabilities through ENSv2 names and records.' },
  { title: 'Live Readiness Checks', desc: '"Who can I reach right now?" — Live ENS record resolution and endpoint readiness probes verify each candidate before any payment decision.' },
  { title: 'AI Decision Engine', desc: '"Which one to choose?" — Combines capability, price, and provider evidence into a runtime routing decision.' },
  { title: 'Hedera Settlement', desc: '"How does the agent pay?" — The agent settles the selected service directly with HBAR — no accounts, no cards.' },
  { title: 'x402 Payment Gate', desc: '"How does the service request payment?" — The endpoint becomes machine-payable through HTTP 402 Payment Required.' },
];

// Scroll-driven sprite animation — 250 frames (0.webp through 249.webp).
const TOTAL_FRAMES = 250; // 0.webp through 249.webp

/**
 * Features section with a canvas that draws pre-rendered sprite frames
 * (features_animation/0-249.webp) driven by scroll position through the
 * feature list — the tile-to-ball transformation animation.
 *   frameIndex = sum(weight[i] * progress[i])
 *   progress[i] = clamp((0.6 * innerHeight - itemTop) / (0.2 * innerHeight), 0, 1)
 */
export default function ProblemSolution() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const listWebRef = useRef<HTMLUListElement>(null);
  const listMobileRef = useRef<HTMLUListElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  // --- Lock animation to last item when reached ---
  const updateIconPosition = useCallback(() => {
    const iconEl = iconRef.current;
    if (!iconEl) return;

    const isMobile = window.innerWidth < 768;
    const listEl = isMobile ? listMobileRef.current : listWebRef.current;
    if (!listEl) return;

    const items = listEl.querySelectorAll('li');
    const lastItem = items[items.length - 1];
    if (!lastItem) return;

    const lastItemRect = lastItem.getBoundingClientRect();
    const lastItemCenter = lastItemRect.top + lastItemRect.height / 2;

    const stickyTop = isMobile ? window.innerHeight * 0.24 : window.innerHeight * 0.11;
    const stickyCenter = stickyTop + iconEl.offsetHeight / 2;

    if (lastItemCenter < stickyCenter) {
      const diff = lastItemCenter - stickyCenter;
      iconEl.style.transform = `translate3d(0, ${diff}px, 0)`;
    } else {
      iconEl.style.transform = 'translate3d(0, 0, 0)';
    }
  }, []);

  // --- Scroll-linked opacity + color for desktop list and active state for mobile list ---
  const handleScroll = useCallback(() => {
    updateIconPosition();
    const isMobile = window.innerWidth < 768;

    if (isMobile) {
      const mList = listMobileRef.current;
      if (!mList) return;
      const mItems = Array.from(mList.querySelectorAll('li'));
      const vh = window.innerHeight;
      mItems.forEach((item) => {
        const rect = item.getBoundingClientRect();
        const inFocus = rect.top < vh * 0.7 && rect.bottom > vh * 0.25;
        if (inFocus) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
      return;
    }

    const list = listWebRef.current;
    if (!list) return;
    const items = Array.from(list.querySelectorAll('li'));
    const vw = window.innerHeight;

    items.forEach((item) => {
      const rect = item.getBoundingClientRect();
      const progress = Math.min(Math.max(0, (vw * 0.6 - rect.top) / rect.height), 1);

      let opacity: number;
      let color: string;

      if (progress < 0.5) {
        opacity = 0.3 + (1 - 0.3) * (progress / 0.5);
        color = 'rgb(255,255,255)';
      } else if (progress < 0.75) {
        opacity = 1;
        const t = (progress - 0.5) / 0.25;
        const r = Math.round(255 - (255 - 206) * t);
        const g = Math.round(255 - (255 - 255) * t);
        const b = Math.round(255 - (255 - 69) * t);
        color = `rgb(${r},${g},${b})`;
      } else {
        opacity = 1 - (1 - 0.3) * ((progress - 0.75) / 0.25);
        const t = (progress - 0.75) / 0.25;
        const r = Math.round(206 + (255 - 206) * t);
        const g = 255;
        const b = Math.round(69 + (255 - 69) * t);
        color = `rgb(${r},${g},${b})`;
      }

      item.style.opacity = String(opacity);
      item.style.color = color;
    });
  }, [updateIconPosition]);

  // --- Canvas sprite animation: draw frame based on scroll with buttery smooth lerp ---
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;

    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    // Non-null captures for closures (TS narrowing)
    const canvasEl: HTMLCanvasElement = cvs;
    const drawCtx: CanvasRenderingContext2D = ctx;

    // Load all frames 0-249
    const frames: HTMLImageElement[] = [];
    let canvasSized = false;
    let targetFrame = 0;
    let currentFrame = 0;
    let lastDrawnIndex = -1;
    let rafId: number | null = null;
    const LERP_FACTOR = 0.09; // Buttery smooth damping inertia

    function getBestFrame(idx: number): HTMLImageElement | null {
      const direct = frames[idx];
      if (direct && direct.naturalWidth > 0) return direct;
      for (let offset = 1; offset < TOTAL_FRAMES; offset++) {
        const prev = frames[idx - offset];
        if (prev && prev.naturalWidth > 0) {
          return prev;
        }
        const next = frames[idx + offset];
        if (next && next.naturalWidth > 0) {
          return next;
        }
      }
      return null;
    }

    function calcTargetFrame(): number {
      const isMobile = window.innerWidth < 768;
      const listEl = isMobile ? listMobileRef.current : listWebRef.current;
      if (!listEl) return 0;

      const items = Array.from(listEl.querySelectorAll('li'));
      if (items.length < 2) return 0;

      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!firstItem || !lastItem) return 0;

      const firstRect = firstItem.getBoundingClientRect();
      const firstCenter = firstRect.top + firstRect.height / 2;

      const lastRect = lastItem.getBoundingClientRect();
      const lastCenter = lastRect.top + lastRect.height / 2;

      const focalStart = isMobile ? window.innerHeight * 0.5 : window.innerHeight * 0.55;
      const stickyTop = isMobile ? window.innerHeight * 0.24 : window.innerHeight * 0.11;
      const iconEl = iconRef.current;
      const stickyCenter = stickyTop + (iconEl ? iconEl.offsetHeight / 2 : 0);

      const D = lastCenter - firstCenter;
      const totalRange = (focalStart - stickyCenter) + D;

      if (totalRange <= 0) return 0;

      const progress = (focalStart - firstCenter) / totalRange;
      const clamped = Math.min(Math.max(0, progress), 1);
      return clamped * (TOTAL_FRAMES - 1);
    }

    function renderLoop() {
      const diff = targetFrame - currentFrame;
      if (Math.abs(diff) < 0.005) {
        currentFrame = targetFrame;
      } else {
        currentFrame += diff * LERP_FACTOR;
      }

      const frameIndex = Math.min(Math.max(0, Math.round(currentFrame)), TOTAL_FRAMES - 1);

      if (frameIndex !== lastDrawnIndex || !canvasSized) {
        const frame = getBestFrame(frameIndex);
        if (frame && frame.naturalWidth > 0) {
          drawCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
          drawCtx.drawImage(frame, 0, 0);
          lastDrawnIndex = frameIndex;
        }
      }

      if (currentFrame !== targetFrame) {
        rafId = requestAnimationFrame(renderLoop);
      } else {
        rafId = null;
      }
    }

    function wakeLoop() {
      targetFrame = calcTargetFrame();
      if (rafId === null) {
        rafId = requestAnimationFrame(renderLoop);
      }
    }

    function onFrameLoad() {
      if (!canvasSized && frames[0] && frames[0].naturalWidth > 0) {
        canvasEl.width = frames[0].naturalWidth;
        canvasEl.height = frames[0].naturalHeight;
        canvasSized = true;
      }
      wakeLoop();
    }

    for (let i = 0; i < TOTAL_FRAMES; i++) {
      const img = new Image();
      img.onload = onFrameLoad;
      img.onerror = onFrameLoad;
      img.src = `/features_animation/${i}.webp`;
      frames.push(img);
    }

    const onScroll = () => {
      wakeLoop();
      updateIconPosition();
    };
    const onResize = () => {
      wakeLoop();
      updateIconPosition();
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    wakeLoop();
    updateIconPosition();

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [updateIconPosition]);

  // --- Scroll listener for list opacity ---
  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // --- mask-bt hover effect: lime circle expands from cursor ---
  useEffect(() => {
    const btns = Array.from(document.querySelectorAll('.btn.mask-bt'));
    const rafIds: number[] = [];

    btns.forEach((btn) => {
      const el = btn as HTMLElement;
      let targetX = 0, targetY = 0, curX = 0, curY = 0;
      let raf = 0;
      let animating = false;

      const animate = () => {
        curX += (targetX - curX) * 0.1;
        curY += (targetY - curY) * 0.1;
        el.style.setProperty('--x', `${curX}px`);
        el.style.setProperty('--y', `${curY}px`);
        raf = requestAnimationFrame(animate);
      };

      const onEnter = (e: MouseEvent) => {
        // Create SVG circle if not present
        if (!el.querySelector('svg')) {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', '0');
          circle.setAttribute('cy', '0');
          svg.appendChild(circle);
          el.appendChild(svg);
        }
        const rect = el.getBoundingClientRect();
        targetX = e.clientX - rect.left;
        targetY = e.clientY - rect.top;
        curX = targetX; curY = targetY;
        const diag = Math.hypot(rect.width, rect.height);
        el.style.setProperty('--r', `${diag}px`);
        if (!animating) {
          animating = true;
          raf = requestAnimationFrame(animate);
        }
        el.classList.add('hover');
        // loop: text slides up, reappears at bottom, slides back
        if (el.classList.contains('loop')) {
          const span = el.querySelector<HTMLElement>('.container span');
          if (span) {
            span.style.transition = 'transform .25s ease-in';
            span.style.setProperty('--y', '-100%');
            span.addEventListener('transitionend', function handler() {
              span.removeEventListener('transitionend', handler);
              span.style.transition = 'none';
              span.style.setProperty('--y', '100%');
              requestAnimationFrame(() => {
                span.style.transition = 'transform .25s ease-out';
                span.style.setProperty('--y', '0%');
              });
            });
          }
        }
      };

      const onMove = (e: MouseEvent) => {
        const rect = el.getBoundingClientRect();
        targetX = e.clientX - rect.left;
        targetY = e.clientY - rect.top;
      };

      const onLeave = () => {
        el.style.setProperty('--r', '0px');
        el.classList.remove('hover');
        if (raf) { cancelAnimationFrame(raf); animating = false; }
      };

      el.addEventListener('mouseenter', onEnter);
      el.addEventListener('mousemove', onMove);
      el.addEventListener('mouseleave', onLeave);
    });

    return () => {
      rafIds.forEach((id) => cancelAnimationFrame(id));
    };
  }, []);

  return (
    <section className="features" id="features" ref={sectionRef}>
      <div className="section-title">
        <div>
          <h2 data-scroll>
            The agent discovers,<br />
            the evidence decides,<br />
            the agent <span>pays</span>.
          </h2>
          <p>An autonomous routing layer where agents discover services through ENSv2, verify providers with live readiness checks, and pay for the best option themselves.</p>
        </div>
        <div className="features-btn-wrap">
          <a className="btn solid mask-bt loop" href="https://x402.org" target="_blank" rel="noopener noreferrer">
            <div className="container"><span>Read x402 Docs &rarr;</span></div>
          </a>
        </div>
      </div>

      <div id="fixed-features">
        <div className="icon" ref={iconRef}>
          <canvas ref={canvasRef}></canvas>
        </div>

        {/* Desktop list */}
        <ul className="list-web" ref={listWebRef}>
          {features.map((f, i) => (
            <li
              key={i}
              style={{ opacity: 0.3, visibility: 'inherit' as const, color: 'rgb(255, 255, 255)' }}
            >
              <div className="num"></div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </li>
          ))}
        </ul>

        {/* Mobile list */}
        <ul className="list-mobile" ref={listMobileRef}>
          {features.map((f, i) => (
            <li key={i}>
              <div className="num"></div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </li>
          ))}
          <svg viewBox="0 0 32 32" fill="none">
            <path
              d="M31.5 16C31.5 24.5604 24.5604 31.5 16 31.5C7.43959 31.5 0.5 24.5604 0.5 16C0.5 7.43959 7.43959 0.5 16 0.5C24.5604 0.5 31.5 7.43959 31.5 16Z"
              vectorEffect="non-scaling-stroke"
            ></path>
          </svg>
        </ul>
      </div>
    </section>
  );
}