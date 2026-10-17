// One import point for the UI library: Preact + hooks + htm (tagged-template JSX, no build step).
import { h } from './vendor/preact.module.js';
import htm from './vendor/htm.module.js';

export { h, render, Fragment, createContext } from './vendor/preact.module.js';
export {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from './vendor/hooks.module.js';

export const html = htm.bind(h);
