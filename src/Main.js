// Entry point.

import { App } from './App.js';

const Instance = new App();
Instance.init();

// Handy for poking at the engine from the browser console.
/** @type {any} */ (window).BrowbrowPulse = Instance;
