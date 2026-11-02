// The entry imports this for its side effect only; terminal-fonts.ts must not, so a test can load
// the font service without a stylesheet (spec 2026-11-02 §8).
import './fonts.css';
