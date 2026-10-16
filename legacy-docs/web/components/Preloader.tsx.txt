'use client';

import { useEffect, useRef } from 'react';

export default function Preloader() {
  const loaderRef = useRef<HTMLDivElement>(null);
  const numRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    let pct = 0;
    const circumference = 310;

    const tick = () => {
      pct += Math.random() * 12 + 3;
      if (pct > 100) pct = 100;
      if (pathRef.current) {
        const offset = circumference - (pct / 100) * circumference;
        pathRef.current.style.strokeDashoffset = String(offset);
      }
      if (numRef.current) numRef.current.textContent = Math.floor(pct) + '%';
      if (lineRef.current) lineRef.current.classList.add('active');
      if (pct < 100) requestAnimationFrame(tick);
      else setTimeout(() => loaderRef.current?.classList.add('hide'), 300);
    };
    requestAnimationFrame(tick);
  }, []);

  return (
    <div className="site-loader" ref={loaderRef}>
      <div className="brand">
        <svg viewBox="0 0 48 48" fill="none">
          <path fillRule="evenodd" clipRule="evenodd" d="M23.8588 4.80005L40.8 14.4V33.8824L23.8588 43.2001L7.20001 33.8824V14.4L23.8588 4.80005ZM12.847 17.7883L23.8587 11.2942L34.8705 17.7883L29.7882 20.8942L23.8587 17.2236L18.494 20.8942V33.8825L12.847 30.4942V17.7883Z" fill="currentColor"/>
        </svg>
      </div>
      <div className="line" ref={lineRef}></div>
      <div className="preloader">
        <svg viewBox="0 0 100 100" fill="none">
          <path ref={pathRef} d="M99.5 50C99.5 77.3377 77.3377 99.5 50 99.5C22.6623 99.5 0.5 77.3377 0.5 50C0.5 22.6623 22.6623 0.5 50 0.5C77.3377 0.5 99.5 22.6623 99.5 50Z" vectorEffect="non-scaling-stroke"/>
        </svg>
        <div className="number"><div ref={numRef}>0%</div></div>
      </div>
      <div className="line down"></div>
    </div>
  );
}