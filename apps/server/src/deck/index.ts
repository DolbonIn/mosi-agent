/** The deck generator (PLAN §3-C): the model's slide JSON + the server's data → checked, F-A HTML. */
export * from "./types";
export { chars, esc, figureParts, figureText, fill, lintModelText, REF_RE } from "./text";
export { APPENDIX_ROWS, DECK_MAX, DECK_MIN, LEVELS_NEEDED, modelTexts, presentCaptures, TABLE_ROWS, TIMELINE_EVENTS, validateDeck } from "./validate";
export { FONT_LICENCE, kstStamp, LOCAL_FONT_SRC, methodBars, PAGE_H, PAGE_W, renderDeck, renderSlide, shortDay, usedSources, type RenderOptions } from "./render";
export { deckCss, FA3 } from "./style";
export { DECK_FONT_FAMILY, NO_FONT_FAIL, NO_FONT_ROW, type DeckFont, type FontOff } from "./font";
