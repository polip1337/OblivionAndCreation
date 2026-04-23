(function () {
  "use strict";

  function startPageEntrance() {
    if (!window.gsap) return;
    const tl = window.gsap.timeline();
    tl.from(".scroll-rod--top", { scaleX: 0, duration: 0.6, ease: "power2.out" })
      .from(".scroll-rod--bottom", { scaleX: 0, duration: 0.6, ease: "power2.out" }, "<")
      .from(".scroll-body", { scaleY: 0, opacity: 0, duration: 0.7, ease: "power2.out", transformOrigin: "top center" }, "-=0.3")
      .from(".topbar, .middle-panel-tabs, .left-tabs", { opacity: 0, y: -10, duration: 0.4, stagger: 0.1, ease: "power1.out" }, "-=0.2");
  }

  function startParticles() {
    if (!window.tsParticles || typeof window.tsParticles.load !== "function") return;
    window.tsParticles.load("tsparticles", {
      fullScreen: { enable: true, zIndex: -1 },
      particles: {
        number: { value: 18 },
        color: { value: ["#4a9b6f", "#c8952a", "#8b1a1a"] },
        shape: { type: "circle" },
        opacity: { value: { min: 0.1, max: 0.5 }, animation: { enable: true, speed: 0.5 } },
        size: { value: { min: 1, max: 3 } },
        move: {
          enable: true,
          speed: 0.4,
          direction: "top",
          random: true,
          straight: false,
          outModes: "out"
        }
      },
      background: { color: "transparent" }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    startPageEntrance();
    startParticles();
  });
})();
