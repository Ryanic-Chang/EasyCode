export const MAX_INPUT_GRAPHEMES = 2000;

export interface InputState {
  readonly graphemes: readonly string[];
  readonly cursor: number;
}

export type InputAction =
  | { readonly type: "insert"; readonly value: string }
  | { readonly type: "left" }
  | { readonly type: "right" }
  | { readonly type: "home" }
  | { readonly type: "end" }
  | { readonly type: "backspace" }
  | { readonly type: "delete" }
  | { readonly type: "clear" };

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

export const EMPTY_INPUT: InputState = { graphemes: [], cursor: 0 };

export function splitGraphemes(value: string): readonly string[] {
  return [...segmenter.segment(value)].map(({ segment }) => segment);
}

export function truncateGraphemes(value: string, maximum: number, marker: string): string {
  const graphemes = splitGraphemes(value);
  if (graphemes.length <= maximum) {
    return value;
  }
  const markerLength = splitGraphemes(marker).length;
  const kept = Math.max(0, maximum - markerLength);
  return `${graphemes.slice(0, kept).join("")}${marker}`;
}

export function normalizePastedInput(value: string): string {
  return [...value.replace(/\r\n|\r|\n/g, " ").replace(/\t/g, " ")]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("");
}

export function inputValue(state: InputState): string {
  return state.graphemes.join("");
}

export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case "insert": {
      const inserted = splitGraphemes(normalizePastedInput(action.value));
      if (inserted.length === 0 || state.graphemes.length >= MAX_INPUT_GRAPHEMES) {
        return state;
      }
      const available = MAX_INPUT_GRAPHEMES - state.graphemes.length;
      const accepted = inserted.slice(0, available);
      return {
        graphemes: [...state.graphemes.slice(0, state.cursor), ...accepted, ...state.graphemes.slice(state.cursor)],
        cursor: state.cursor + accepted.length,
      };
    }
    case "left":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case "right":
      return { ...state, cursor: Math.min(state.graphemes.length, state.cursor + 1) };
    case "home":
      return { ...state, cursor: 0 };
    case "end":
      return { ...state, cursor: state.graphemes.length };
    case "backspace":
      if (state.cursor === 0) {
        return state;
      }
      return {
        graphemes: [...state.graphemes.slice(0, state.cursor - 1), ...state.graphemes.slice(state.cursor)],
        cursor: state.cursor - 1,
      };
    case "delete":
      if (state.cursor >= state.graphemes.length) {
        return state;
      }
      return {
        graphemes: [...state.graphemes.slice(0, state.cursor), ...state.graphemes.slice(state.cursor + 1)],
        cursor: state.cursor,
      };
    case "clear":
      return EMPTY_INPUT;
  }
}
