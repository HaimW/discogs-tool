(function () {
    const link = document.getElementById('footer-credit-link');
    if (!link) return;

    let hovered = false;
    let hue = 180;

    function applyStyle() {
        const h2 = (hue + 70) % 360;
        if (hovered) {
            const glowA = `hsla(${h2}, 100%, 65%, 0.55)`;
            const glowB = `hsla(${h2}, 100%, 65%, 0.25)`;
            link.style.color = `hsl(${h2}, 100%, 68%)`;
            link.style.opacity = '0.9';
            link.style.filter = `drop-shadow(0 0 4px ${glowA}) drop-shadow(0 0 12px ${glowB})`;
        } else {
            link.style.color = '';
            link.style.opacity = '';
            link.style.filter = '';
        }
    }

    window.addEventListener('mousemove', function (e) {
        const rect = link.getBoundingClientRect();
        const x = hovered
            ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
            : e.clientX / window.innerWidth;
        hue = Math.round(x * 360);
        if (hovered) applyStyle();
    });

    link.addEventListener('mouseenter', function () {
        hovered = true;
        applyStyle();
    });

    link.addEventListener('mouseleave', function () {
        hovered = false;
        applyStyle();
    });
})();
