export function setupMotion() {
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  if (!gsap || !ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);
  const media = gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)', () => {
    const list = document.querySelector('#taskList');
    const rows = new Map();
    let frame = 0;
    const sync = () => {
      frame = 0;
      for (const [node, timeline] of rows) {
        if (!node.isConnected) { timeline.scrollTrigger?.kill(); timeline.kill(); rows.delete(node); }
      }
      for (const node of list.querySelectorAll('.task-row')) {
        if (rows.has(node)) continue;
        const content = node.querySelector('.post-text, .task-name');
        const timeline = gsap.timeline({ scrollTrigger: {
          trigger: node, scroller: list, start: 'top bottom', end: 'top 78%', scrub: 0.25,
        } });
        timeline.fromTo(content, { opacity: 0.65 }, { opacity: 1, duration: 1 });
        const image = node.querySelector('.media-preview img');
        if (image) timeline.fromTo(image, { scale: 0.96, opacity: 0.7 }, { scale: 1, opacity: 1, duration: 1 }, 0);
        rows.set(node, timeline);
      }
      ScrollTrigger.refresh();
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(sync); });
    observer.observe(list, { childList: true });
    sync();
    const dialogs = [...document.querySelectorAll('dialog')];
    const dialogObserver = new MutationObserver((records) => {
      for (const { target } of records) {
        if (!target.open) { gsap.killTweensOf(target.querySelectorAll('.modal-head, .settings-group, .modal-actions')); continue; }
        gsap.fromTo(target.querySelectorAll('.modal-head, .settings-group, .modal-actions'),
          { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.24, stagger: 0.035, ease: 'power2.out', overwrite: true });
      }
    });
    dialogs.forEach((dialog) => dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] }));
    return () => {
      observer.disconnect(); dialogObserver.disconnect(); cancelAnimationFrame(frame);
      for (const timeline of rows.values()) { timeline.scrollTrigger?.kill(); timeline.kill(); }
      gsap.set(document.querySelectorAll('.task-row img, .post-text, .task-name, .modal-head, .settings-group, .modal-actions'), { clearProps: 'opacity,transform' });
    };
  });
}
