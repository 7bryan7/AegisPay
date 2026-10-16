'use client';

import { useEffect } from 'react';

export default function ScrollObserver() {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-inview');
            // RLY data-split reveal: add 'show' to trigger line reveal
            if (e.target.hasAttribute('data-split')) {
              e.target.classList.add('show');
            }
            // Propagate is-inview to tag number/name children
            if (e.target.classList.contains('tag')) {
              e.target.querySelectorAll('.number, .name').forEach((c) =>
                c.classList.add('is-inview')
              );
            }
            // Stagger siblings
            const parent = e.target.parentElement;
            if (parent) {
              const sibs = parent.querySelectorAll('[data-anim]');
              sibs.forEach((s, i) => {
                const d = parseInt(s.getAttribute('data-anim-delay') || '0');
                setTimeout(() => s.classList.add('is-inview'), d + i * 80);
              });
            }
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -8% 0px' }
    );

    document
      .querySelectorAll(
        '[data-anim], [data-scroll], [data-split], .section-title .tag, .ps-col h3, .tech-card, .timeline .step, .arch-diagram'
      )
      .forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, []);

  return null;
}