/**
 * Border Control - Magenta Neon Border Toggle
 *
 * Creates a magenta neon border around the window that can be toggled
 * on/off with the 'B' key.
 */

(function () {
    'use strict';

    let borderWrapper = null;
    let isVisible = false;

    function createBorder() {
        // Create wrapper element
        borderWrapper = document.createElement('div');
        borderWrapper.className = 'neon-border-wrapper';

        // Create inner border element
        const border = document.createElement('div');
        border.className = 'neon-border';

        borderWrapper.appendChild(border);
        document.body.appendChild(borderWrapper);

        console.log('[border-control] Magenta neon border created (hidden by default)');
    }

    function toggleBorder() {
        if (!borderWrapper) return;

        isVisible = !isVisible;

        if (isVisible) {
            borderWrapper.classList.add('visible');
            console.log('[border-control] Border visible');
        } else {
            borderWrapper.classList.remove('visible');
            console.log('[border-control] Border hidden');
        }
    }

    function init() {
        // Create border on page load
        createBorder();

        // Listen for 'B' key to toggle
        window.addEventListener('keydown', (e) => {
            if (e.key === 'b' || e.key === 'B') {
                toggleBorder();
            }
        });
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
